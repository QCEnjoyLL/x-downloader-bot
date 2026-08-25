function readPositiveInt(name, fallback, max = 1000) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(1, value)) : fallback;
}

const allowedChats = new Set(
  (process.env.ALLOWED_CHAT_IDS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
);
const maxRequestsPerMinute = readPositiveInt('MAX_REQUESTS_PER_MINUTE', 10);
const maxLinksPerMessage = readPositiveInt('MAX_LINKS_PER_MESSAGE', 5, 50);
const requestWindows = new Map();
let accessChecks = 0;

export function checkChatAccess(chatId, requestId, now = Date.now()) {
  const key = String(chatId);
  if (allowedChats.size > 0 && !allowedChats.has(key)) {
    return { allowed: false, reason: 'not_allowed' };
  }

  const cutoff = now - 60000;
  if (++accessChecks % 1000 === 0) {
    for (const [chat, items] of requestWindows) {
      if (!items.some(item => item.timestamp > cutoff)) requestWindows.delete(chat);
    }
  }
  const recent = (requestWindows.get(key) || []).filter(item => item.timestamp > cutoff);
  if (requestId !== undefined && recent.some(item => item.requestId === String(requestId))) {
    return { allowed: true };
  }
  if (recent.length >= maxRequestsPerMinute) {
    requestWindows.set(key, recent);
    return { allowed: false, reason: 'rate_limited' };
  }
  recent.push({ timestamp: now, requestId: requestId === undefined ? null : String(requestId) });
  requestWindows.set(key, recent);
  return { allowed: true };
}

export function capLinks(urls) {
  return {
    urls: urls.slice(0, maxLinksPerMessage),
    dropped: Math.max(0, urls.length - maxLinksPerMessage),
    limit: maxLinksPerMessage
  };
}

export function getAccessConfig() {
  return {
    allowlistEnabled: allowedChats.size > 0,
    maxRequestsPerMinute,
    maxLinksPerMessage
  };
}
