function readNonNegativeInt(name, fallback, max = 1000) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : fallback;
}

function readIdSet(name) {
  return new Set(
    (process.env[name] || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
  );
}

const allowedUsers = readIdSet('ALLOWED_USER_IDS');
const allowedChats = readIdSet('ALLOWED_CHAT_IDS');
const allowlistEnabled = allowedUsers.size > 0 || allowedChats.size > 0;
const allowlistBypassLimits = process.env.ALLOWLIST_BYPASS_LIMITS !== 'false';
const maxRequestsPerMinute = readNonNegativeInt('MAX_REQUESTS_PER_MINUTE', 10);
const maxLinksPerMessage = readNonNegativeInt('MAX_LINKS_PER_MESSAGE', 5, 1000);
const requestWindows = new Map();
let accessChecks = 0;

export function checkTelegramAccess({ chatId, userId, requestId, now = Date.now() }) {
  const chatKey = String(chatId);
  const userKey = userId === undefined || userId === null ? null : String(userId);
  const authorized = !allowlistEnabled ||
    (userKey !== null && allowedUsers.has(userKey)) ||
    allowedChats.has(chatKey);
  if (!authorized) {
    return { allowed: false, reason: 'not_allowed' };
  }
  const unlimited = allowlistEnabled && allowlistBypassLimits;
  if (unlimited || maxRequestsPerMinute === 0) {
    return { allowed: true, unlimited };
  }

  const cutoff = now - 60000;
  if (++accessChecks % 1000 === 0) {
    for (const [chat, items] of requestWindows) {
      if (!items.some(item => item.timestamp > cutoff)) requestWindows.delete(chat);
    }
  }
  const recent = (requestWindows.get(chatKey) || []).filter(item => item.timestamp > cutoff);
  if (requestId !== undefined && recent.some(item => item.requestId === String(requestId))) {
    return { allowed: true, unlimited: false };
  }
  if (recent.length >= maxRequestsPerMinute) {
    requestWindows.set(chatKey, recent);
    return { allowed: false, reason: 'rate_limited' };
  }
  recent.push({ timestamp: now, requestId: requestId === undefined ? null : String(requestId) });
  requestWindows.set(chatKey, recent);
  return { allowed: true, unlimited: false };
}

export function capLinks(urls, unlimited = false) {
  if (unlimited || maxLinksPerMessage === 0) {
    return { urls, dropped: 0, limit: 0 };
  }
  return {
    urls: urls.slice(0, maxLinksPerMessage),
    dropped: Math.max(0, urls.length - maxLinksPerMessage),
    limit: maxLinksPerMessage
  };
}

export function getAccessConfig() {
  return {
    allowlistEnabled,
    userAllowlistEnabled: allowedUsers.size > 0,
    chatAllowlistEnabled: allowedChats.size > 0,
    allowlistBypassLimits,
    maxRequestsPerMinute,
    maxLinksPerMessage
  };
}
