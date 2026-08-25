import { mkdir, readdir, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';

function readNonNegativeNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= 0) return value;
  console.warn(`Invalid ${name}=${raw}; using ${fallback}`);
  return fallback;
}

const retentionHours = readNonNegativeNumber('DOWNLOAD_RETENTION_HOURS', 24);
const maxDiskBytes = readNonNegativeNumber('MAX_DOWNLOAD_DISK_GB', 20) * 1024 ** 3;
const minFreeBytes = readNonNegativeNumber('MIN_FREE_DISK_GB', 1) * 1024 ** 3;

async function listFiles(directory) {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter(entry => entry.isFile()).map(entry => join(directory, entry.name));
}

export async function cleanupExpiredDownloads(directory, now = Date.now()) {
  if (retentionHours <= 0) return 0;
  const cutoff = now - retentionHours * 60 * 60 * 1000;
  let removed = 0;
  for (const filepath of await listFiles(directory)) {
    try {
      const info = await stat(filepath);
      if (info.mtimeMs < cutoff) {
        await rm(filepath, { force: true });
        removed++;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`Storage cleanup failed for ${filepath}:`, error.message);
    }
  }
  return removed;
}

export async function getDownloadStorageStats(directory) {
  let usedBytes = 0;
  for (const filepath of await listFiles(directory)) {
    try { usedBytes += (await stat(filepath)).size; } catch {}
  }
  const filesystem = await statfs(directory);
  return {
    usedBytes,
    freeBytes: filesystem.bavail * filesystem.bsize,
    maxDiskBytes,
    minFreeBytes,
    retentionHours
  };
}

export async function assertDownloadCapacity(directory, incomingBytes = 0) {
  const stats = await getDownloadStorageStats(directory);
  if (maxDiskBytes > 0 && stats.usedBytes + incomingBytes > maxDiskBytes) {
    throw new Error('DISK_QUOTA_EXCEEDED: download directory quota exceeded');
  }
  if (minFreeBytes > 0 && stats.freeBytes - incomingBytes < minFreeBytes) {
    throw new Error('DISK_SPACE_LOW: not enough free disk space');
  }
  return stats;
}

export async function initializeStorage(directory) {
  const removed = await cleanupExpiredDownloads(directory);
  if (removed) console.log(`Storage cleanup removed ${removed} expired file(s)`);
  const stats = await getDownloadStorageStats(directory);
  if (maxDiskBytes > 0 && stats.usedBytes > maxDiskBytes) {
    console.warn('Download directory is over quota; new downloads will be rejected');
  }
  if (minFreeBytes > 0 && stats.freeBytes < minFreeBytes) {
    console.warn('Download filesystem is low on free space; new downloads will be rejected');
  }
  return stats;
}
