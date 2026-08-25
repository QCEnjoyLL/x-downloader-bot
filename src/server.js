// X Downloader Bot — Docker 部署版 Express 服务器入口
import 'dotenv/config';
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import {
  handleTelegramWebhook,
  setupWebhook,
  getStatusHtml
} from './index.js';

const PORT = process.env.PORT || 3000;
const POLLING = process.env.POLLING !== 'false';
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const TELEGRAM_API = process.env.TELEGRAM_API_URL || 'https://api.telegram.org';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const WEBHOOK_SETUP_KEY = process.env.WEBHOOK_SETUP_KEY || '';

const app = express();
app.use(express.json({ limit: '1mb' }));

function secretsMatch(actual, expected) {
  if (!actual || !expected) return false;
  const a = Buffer.from(String(actual));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

// 主页 — 状态显示
app.get('/', async (_req, res) => {
  try {
    const html = await getStatusHtml();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

// Webhook 接收（仅非轮询模式需要）
app.post('/webhook', async (req, res) => {
  if (POLLING) return res.status(409).send('Webhook disabled in polling mode');
  if (!WEBHOOK_SECRET) return res.status(503).send('WEBHOOK_SECRET is not configured');
  if (!secretsMatch(req.get('X-Telegram-Bot-Api-Secret-Token'), WEBHOOK_SECRET)) {
    return res.status(401).send('Unauthorized');
  }
  // Telegram 需要快速收到 200；实际处理异步进行，避免耗时下载触发重复投递。
  res.status(200).send('OK');
  handleTelegramWebhook(req.body).catch(err => {
    console.error('Webhook error:', err);
  });
});

// Webhook 设置助手
app.get('/setup-webhook', async (req, res) => {
  if (POLLING) return res.status(409).send('Switch POLLING=false before setting a webhook');
  if (!WEBHOOK_SECRET) return res.status(503).send('WEBHOOK_SECRET is not configured');
  if (!WEBHOOK_SETUP_KEY) return res.status(503).send('WEBHOOK_SETUP_KEY is not configured');
  if (!secretsMatch(req.get('X-Webhook-Setup-Key'), WEBHOOK_SETUP_KEY)) {
    return res.status(401).send('Unauthorized');
  }
  try {
    const html = await setupWebhook(req);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

// 健康检查
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', mode: POLLING ? 'polling' : 'webhook' });
});

app.listen(PORT, () => {
  console.log(`🤖 X Downloader Bot running on port ${PORT}`);
  if (!BOT_TOKEN) {
    console.error('⚠️  BOT_TOKEN 未设置！请检查 .env 文件');
    process.exit(1);
  }
  console.log('✅ BOT_TOKEN 已配置');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🤖 X Downloader Bot');
  console.log('  默认：📥 下载模式 + 🎯 最高清');
  console.log('  Telegram 发送 /start 查看使用方法');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (POLLING) {
    console.log('🔄 轮询模式已启动（无需设置 Webhook）');
    startPolling();
  } else {
    console.log('📡 Webhook 模式（需要公网 HTTPS 地址）');
    console.log('💡 提示：设置 POLLING=true 可切换到轮询模式');
  }
});

// ==================== 轮询模式 ====================

async function startPolling() {
  let offset = 0;
  let retryDelay = 1000;

  async function poll() {
    try {
      const url = `${TELEGRAM_API}/bot${BOT_TOKEN}/getUpdates?timeout=30&offset=${offset}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(40000) });
      const data = await response.json();

      if (!data.ok) {
        console.error('Polling error:', data.description);
        return false;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;
        handleTelegramWebhook(update).catch(err => {
          console.error('Handle update error:', err);
        });
      }
      return true;
    } catch (err) {
      console.error('Polling request failed:', err.message);
      return false;
    }
  }

  // 删除已有的 webhook，切换到 getUpdates 模式
  try {
    const response = await fetch(`${TELEGRAM_API}/bot${BOT_TOKEN}/deleteWebhook`, {
      signal: AbortSignal.timeout(30000)
    });
    const result = await response.json();
    if (result.ok) console.log('✅ Webhook 已清除，开始轮询');
    else console.error('Webhook 清除失败:', result.description);
  } catch (error) {
    console.error('Webhook 清除失败:', error.message);
  }

  console.log('🔄 轮询中...');

  // 持续轮询
  while (true) {
    const ok = await poll();
    if (ok) {
      retryDelay = 1000;
      continue;
    }
    // Telegram/API/网络异常时指数退避，避免紧循环刷日志或触发限流。
    await new Promise(resolve => setTimeout(resolve, retryDelay));
    retryDelay = Math.min(retryDelay * 2, 30000);
  }
}
