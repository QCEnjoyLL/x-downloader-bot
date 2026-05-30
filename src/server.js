// X Downloader Bot — Docker 部署版 Express 服务器入口
import 'dotenv/config';
import express from 'express';
import {
  handleTelegramWebhook,
  setupWebhook,
  getStatusHtml
} from './index.js';

const PORT = process.env.PORT || 3000;
const app = express();

// 解析 JSON body（Telegram webhook 发的是 JSON）
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

// Webhook 接收
app.post('/webhook', async (req, res) => {
  try {
    await handleTelegramWebhook(req.body);
    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(200).send('OK'); // 始终返回 200 避免 Telegram 重试
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
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🤖 X Downloader Bot running on port ${PORT}`);
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.error('⚠️  BOT_TOKEN 未设置！请检查 .env 文件');
  } else {
    console.log(`✅ BOT_TOKEN 已配置 (${token.substring(0, 10)}...)`);
  }
});
