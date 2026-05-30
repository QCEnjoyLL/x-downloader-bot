# X Downloader Bot

> Telegram 机器人 — 自动提取 Twitter/X 视频和图片，直接下载发送最高清文件。

[![Docker Pulls](https://img.shields.io/docker/pulls/orangeqiu/x-downloader-bot)](https://hub.docker.com/r/orangeqiu/x-downloader-bot)

## 功能

- 🎬 自动解析 Twitter/X 链接，提取视频和图片
- 📥 默认下载模式，直接发送视频文件到 Telegram
- 🎯 默认最高清，自动选择最高码率
- 🔄 双重 API（fxtwitter + vxtwitter），自动回退
- 📏 智能大小预估，超过 50MB 自动发送链接
- 🐳 Docker 部署，支持 amd64 / arm64

## 快速开始

### 1. 创建 Telegram Bot

找 [@BotFather](https://t.me/BotFather)，发送 `/newbot`，获取 Token。

### 2. 部署

```bash
# 从 Docker Hub 拉取
docker pull orangeqiu/x-downloader-bot

# 或用 docker-compose
wget https://raw.githubusercontent.com/orangeqiu/x-downloader-bot/main/docker-compose.yml
echo "BOT_TOKEN=你的token" > .env
docker compose up -d
```

### 3. 设置 Webhook

浏览器打开 `http://你的服务器IP:3000/setup-webhook`，点击设置按钮即可。

> Telegram 要求 webhook URL 必须是 **HTTPS**。建议使用 nginx 反向代理 + Let's Encrypt，或 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)。

## 命令

| 命令 | 说明 |
|------|------|
| `/start` | 欢迎信息 |
| `/mode` | 查看/切换下载或链接模式 |
| `/quality high\|medium\|low` | 视频画质偏好 |

发送 Twitter/X 链接，机器人自动下载最高清视频发送给你。

支持的链接：`twitter.com/xxx/status/123` `x.com/xxx/status/123`

## 配置

| 变量 | 说明 | 默认 |
|------|------|------|
| `BOT_TOKEN` | Telegram Bot Token（必需） | — |
| `PORT` | 服务端口 | `3000` |

## 本地开发

```bash
cp .env.example .env    # 编辑填入 BOT_TOKEN
npm install
npm run dev             # 热重载
```

## 技术栈

- Node.js 20 / Express
- fxtwitter + vxtwitter API
- GitHub Actions 多架构构建（amd64 + arm64）

## License

MIT
