// X Downloader Bot 用户偏好存储
// 使用 JSON 文件持久化（替代 Cloudflare KV）

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const PREFS_FILE = join(DATA_DIR, 'prefs.json');

// 内存缓存，避免每次读写磁盘
let cache = null;
let cacheLoaded = false;

async function loadCache() {
  if (cacheLoaded) return;
  try {
    await mkdir(DATA_DIR, { recursive: true });
    const raw = await readFile(PREFS_FILE, 'utf-8');
    cache = JSON.parse(raw);
  } catch {
    cache = {};
  }
  cacheLoaded = true;
}

async function saveCache() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(PREFS_FILE, JSON.stringify(cache, null, 2), 'utf-8');
}

/**
 * 获取用户完整偏好
 * @param {number|string} chatId
 * @returns {Promise<{mode: string, quality: string}>}
 */
export async function getUserPrefs(chatId) {
  await loadCache();
  const key = String(chatId);
  return {
    mode: 'download',     // Docker 部署默认下载模式
    quality: 'high',      // 默认最高清
    ...(cache[key] || {})
  };
}

/**
 * 获取用户模式
 * @param {number|string} chatId
 * @returns {Promise<'link'|'download'>}
 */
export async function getUserMode(chatId) {
  const prefs = await getUserPrefs(chatId);
  return prefs.mode;
}

/**
 * 设置用户模式
 * @param {number|string} chatId
 * @param {'link'|'download'} mode
 */
export async function setUserMode(chatId, mode) {
  await loadCache();
  const key = String(chatId);
  if (!cache[key]) cache[key] = {};
  cache[key].mode = mode;
  await saveCache();
}

/**
 * 获取用户画质偏好
 * @param {number|string} chatId
 * @returns {Promise<'high'|'medium'|'low'>}
 */
export async function getUserQuality(chatId) {
  const prefs = await getUserPrefs(chatId);
  return prefs.quality;
}

/**
 * 设置用户画质偏好
 * @param {number|string} chatId
 * @param {'high'|'medium'|'low'} quality
 */
export async function setUserQuality(chatId, quality) {
  await loadCache();
  const key = String(chatId);
  if (!cache[key]) cache[key] = {};
  cache[key].quality = quality;
  await saveCache();
}
