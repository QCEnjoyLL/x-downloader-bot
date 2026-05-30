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

**Docker CLI**

```bash
docker run -d \
  --name x-downloader-bot \
  -e BOT_TOKEN=你的token \
  -e POLLING=true \
  -v $(pwd)/data:/app/data \
  --restart unless-stopped \
  orangeqiu/x-downloader-bot:latest
```

**Docker Compose**

```bash
wget https://raw.githubusercontent.com/orangeqiu/x-downloader-bot/main/docker-compose.yml
echo "BOT_TOKEN=你的token" > .env
docker compose up -d
```

### 3. 两种运行模式

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| **轮询**（默认） | 主动拉取消息，`POLLING=true` | 内网、无公网 IP、懒人首选 |
| Webhook | Telegram 推送消息，需要 HTTPS | 有公网域名+证书 |

轮询模式启动即用，无需额外配置。Webhook 模式需先在页面上设置：`http://你的IP:3000/setup-webhook`。

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

## 镜像标签

每次推送到 master 分支自动构建，版本号根据提交内容自动递增：

| 提交前缀 | 版本变化 | 示例 |
|----------|----------|------|
| `feat: 新增功能` | 次版本 +1 | `v1.3.0` |
| `fix: 修复问题` | 补丁 +1 | `v1.2.1` |
| 含 `BREAKING CHANGE` | 主版本 +1 | `v2.0.0` |

标签：`latest` + `v{版本号}`（如 `v1.2.0`）

## 技术栈

- Node.js 20 / Express
- fxtwitter + vxtwitter API
- GitHub Actions 多架构构建（amd64 + arm64）

## License

MIT
