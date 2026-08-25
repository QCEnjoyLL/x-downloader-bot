import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', 'data');
const DB_FILE = process.env.JOB_DB_FILE || join(DATA_DIR, 'jobs.sqlite');
const MAX_ATTEMPTS = Math.max(1, Number.parseInt(process.env.JOB_MAX_ATTEMPTS || '3', 10) || 3);
const TERMINAL_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

mkdirSync(dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS telegram_jobs (
    update_id TEXT PRIMARY KEY,
    chat_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_error TEXT
  );
`);

function getChatKey(update) {
  const chatId = update?.message?.chat?.id
    ?? update?.edited_message?.chat?.id
    ?? update?.channel_post?.chat?.id
    ?? update?.edited_channel_post?.chat?.id
    ?? update?.callback_query?.message?.chat?.id
    ?? update?.callback_query?.from?.id;
  return chatId === undefined || chatId === null
    ? `update:${update.update_id}`
    : `chat:${chatId}`;
}

// 为 v1.8.0 开发期间创建的早期数据库补齐 chat_key，不影响已有任务。
const columns = db.prepare('PRAGMA table_info(telegram_jobs)').all();
if (!columns.some(column => column.name === 'chat_key')) {
  db.exec(`ALTER TABLE telegram_jobs ADD COLUMN chat_key TEXT NOT NULL DEFAULT ''`);
}
const updateChatKey = db.prepare(`UPDATE telegram_jobs SET chat_key = ? WHERE update_id = ?`);
for (const row of db.prepare(`SELECT update_id, payload FROM telegram_jobs WHERE chat_key = ''`).all()) {
  try {
    updateChatKey.run(getChatKey(JSON.parse(row.payload)), row.update_id);
  } catch {
    updateChatKey.run(`update:${row.update_id}`, row.update_id);
  }
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_telegram_jobs_ready_chat
    ON telegram_jobs(status, chat_key, available_at, created_at);
`);

// 上次进程非正常退出时，running 任务重新进入队列。
db.prepare(`UPDATE telegram_jobs SET status = 'pending', available_at = ?, updated_at = ? WHERE status = 'running'`)
  .run(Date.now(), Date.now());
const pruneTerminalJobs = db.prepare(`
  DELETE FROM telegram_jobs
  WHERE status IN ('completed', 'failed') AND updated_at < ?
`);
pruneTerminalJobs.run(Date.now() - TERMINAL_JOB_RETENTION_MS);
const pruneTimer = setInterval(() => {
  pruneTerminalJobs.run(Date.now() - TERMINAL_JOB_RETENTION_MS);
}, 60 * 60 * 1000);
pruneTimer.unref();

const insertJob = db.prepare(`
  INSERT OR IGNORE INTO telegram_jobs
    (update_id, chat_key, payload, status, attempts, available_at, created_at, updated_at)
  VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
`);
const selectJob = db.prepare(`
  SELECT job.update_id, job.payload, job.attempts FROM telegram_jobs AS job
  WHERE job.status = 'pending' AND job.available_at <= ?
    AND NOT EXISTS (
      SELECT 1 FROM telegram_jobs AS earlier
      WHERE earlier.chat_key = job.chat_key
        AND earlier.status IN ('pending', 'running')
        AND CAST(earlier.update_id AS INTEGER) < CAST(job.update_id AS INTEGER)
    )
  ORDER BY job.created_at ASC, CAST(job.update_id AS INTEGER) ASC LIMIT 1
`);
const markRunning = db.prepare(`
  UPDATE telegram_jobs SET status = 'running', attempts = attempts + 1, updated_at = ?
  WHERE update_id = ? AND status = 'pending'
`);
const markCompleted = db.prepare(`
  UPDATE telegram_jobs SET status = 'completed', updated_at = ?, last_error = NULL WHERE update_id = ?
`);
const markPending = db.prepare(`
  UPDATE telegram_jobs SET status = 'pending', available_at = ?, updated_at = ?, last_error = ? WHERE update_id = ?
`);
const markFailed = db.prepare(`
  UPDATE telegram_jobs SET status = 'failed', updated_at = ?, last_error = ? WHERE update_id = ?
`);

let running = false;
let workers = [];

function claimJob() {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = selectJob.get(Date.now());
    if (!row) {
      db.exec('COMMIT');
      return null;
    }
    const result = markRunning.run(Date.now(), row.update_id);
    db.exec('COMMIT');
    return result.changes ? { ...row, payload: JSON.parse(row.payload) } : null;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function failJob(job, error) {
  const message = String(error?.stack || error?.message || error).slice(0, 4000);
  const attempts = job.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    markFailed.run(Date.now(), message, job.update_id);
    return;
  }
  const delay = Math.min(60000, 1000 * 2 ** Math.max(0, attempts - 1));
  markPending.run(Date.now() + delay, Date.now(), message, job.update_id);
}

async function workerLoop(handler) {
  while (running) {
    let job;
    try {
      job = claimJob();
    } catch (error) {
      console.error('Failed to claim update job:', error);
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }
    if (!job) {
      await new Promise(resolve => setTimeout(resolve, 500));
      continue;
    }
    try {
      await handler(job.payload);
      markCompleted.run(Date.now(), job.update_id);
    } catch (error) {
      console.error(`Update job ${job.update_id} failed:`, error);
      failJob(job, error);
    }
  }
}

export function enqueueTelegramUpdate(update) {
  if (update?.update_id === undefined || update?.update_id === null) {
    throw new Error('Telegram update is missing update_id');
  }
  const now = Date.now();
  const result = insertJob.run(
    String(update.update_id), getChatKey(update), JSON.stringify(update), now, now, now
  );
  return { inserted: result.changes > 0, updateId: String(update.update_id) };
}

export function startUpdateWorkers(handler, concurrency = 8) {
  if (running) return;
  running = true;
  const count = Math.min(32, Math.max(1, Math.floor(Number(concurrency) || 1)));
  workers = Array.from({ length: count }, () => workerLoop(handler));
}

export function getJobQueueStats() {
  const rows = db.prepare(`SELECT status, COUNT(*) AS count FROM telegram_jobs GROUP BY status`).all();
  return Object.fromEntries(rows.map(row => [row.status, Number(row.count)]));
}

export async function closeJobQueue() {
  running = false;
  clearInterval(pruneTimer);
  await Promise.allSettled(workers);
  workers = [];
  db.close();
}
