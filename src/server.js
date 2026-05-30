// X Downloader Bot — Docker 部署版 Express 服务器入口
import 'dotenv/config';
import express from 'express';
import {
  handleTelegramWebhook,
  setupWebhook,
  getStatusHtml
} from './index.js';

const PORT = process.env.PORT || 3000;
const POLLING = process.env.POLLING === 'true';
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const TELEGRAM_API = process.env.TELEGRAM_API_URL || 'https://api.telegram.org';

const app = express();
app.use(express.json());

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
  try {
    await handleTelegramWebhook(req.body);
    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(200).send('OK');
  }
});

// Webhook 设置助手
app.get('/setup-webhook', async (req, res) => {
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
  console.log(`✅ BOT_TOKEN 已配置 (${BOT_TOKEN.substring(0, 10)}...)`);

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

  async function poll() {
    try {
      const url = `${TELEGRAM_API}/bot${BOT_TOKEN}/getUpdates?timeout=30&offset=${offset}`;
      const response = await fetch(url);
      const data = await response.json();

      if (!data.ok) {
        console.error('Polling error:', data.description);
        return;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;
        handleTelegramWebhook(update).catch(err => {
          console.error('Handle update error:', err);
        });
      }
    } catch (err) {
      console.error('Polling request failed:', err.message);
    }
  }

  // 删除已有的 webhook，切换到 getUpdates 模式
  try {
    await fetch(`${TELEGRAM_API}/bot${BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`);
    console.log('✅ Webhook 已清除，开始轮询');
  } catch {}

  console.log('🔄 轮询中...');

  // 持续轮询
  while (true) {
    await poll();
    // getUpdates 长连接断开后立即重连
  }
}
