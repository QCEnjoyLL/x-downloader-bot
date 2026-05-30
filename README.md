# X Downloader Bot

> Telegram 机器人 — 自动提取 Twitter/X 视频和图片，直接下载发送最高清文件。

[![Docker Pulls](https://img.shields.io/docker/pulls/orangeqiu/x-downloader-bot)](https://hub.docker.com/r/orangeqiu/x-downloader-bot)

## 功能

- 🎬 自动解析 Twitter/X 链接，提取视频和图片
- 📥 默认下载模式，直接发送视频文件到 Telegram
- 🎯 默认最高清，自动选择最高码率
- 🔗 上传后附带多清晰度链接
- 💾 视频自动保存到本地（`./downloads` 目录）
- 🔄 双重 API（fxtwitter + vxtwitter），自动回退
- 🚀 可选本地 Bot API，上传上限 **50MB → 2GB**
- 🐳 Docker 部署，支持 amd64 / arm64

## 快速开始

### 1. 创建 Telegram Bot

找 [@BotFather](https://t.me/BotFather)，发送 `/newbot`，获取 Token。

### 2. 部署

**Docker Compose（推荐）**

```bash
# 下载配置
wget https://raw.githubusercontent.com/QCEnjoyLL/x-downloader-bot/master/docker-compose.yml
wget https://raw.githubusercontent.com/QCEnjoyLL/x-downloader-bot/master/.env.example -O .env

# 编辑 .env 填入 BOT_TOKEN
# 如果要突破 50MB 限制，还需填入 TELEGRAM_API_ID 和 TELEGRAM_API_HASH

docker compose up -d
```

**Docker CLI**

```bash
docker run -d --name xbot \
  -e BOT_TOKEN=你的token \
  -e POLLING=true \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/downloads:/app/downloads \
  --restart unless-stopped \
  orangeqiu/x-downloader-bot:latest
```

### 3. 验证

```bash
docker compose logs -f
# 看到 🔄 轮询中... 即成功
```

发送 `/start` 给机器人，收到回复就 OK。

## 两种运行模式

| 模式 | 说明 |
|------|------|
| **轮询**（默认，`POLLING=true`） | 主动拉取消息，无需公网 IP，启动即用 |
| Webhook | Telegram 推送，需要 HTTPS 公网地址 |

## 上传限制

| 模式 | 上限 |
|------|------|
| 云端 API（默认） | 50 MB |
| 本地 Bot API | **2 GB** |

启用 2GB：

```bash
# .env 中添加（先去 https://my.telegram.org/apps 创建应用）
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=abcdef1234567890abcdef1234567890
docker compose up -d
```

## 命令

| 命令 | 说明 |
|------|------|
| `/start` | 欢迎信息 |
| `/mode` | 查看/切换下载或链接模式 |
| `/quality high\|medium\|low` | 视频画质偏好 |

发送 Twitter/X 链接（`x.com/xxx/status/123` 或 `twitter.com/xxx/status/123`），机器人自动下载最高清视频并发送。

## 目录结构

```
.
├── data/prefs.json      # 用户偏好
├── downloads/           # 下载的视频文件
├── telegram-api/        # 本地 API 缓存
└── .env                 # 环境变量
```

## 配置

| 变量 | 说明 | 默认 |
|------|------|------|
| `BOT_TOKEN` | Telegram Bot Token | — |
| `POLLING` | 轮询模式 | `true` |
| `PORT` | 服务端口 | `3000` |
| `TELEGRAM_API_ID` | 本地 API ID（可选） | — |
| `TELEGRAM_API_HASH` | 本地 API Hash（可选） | — |
| `TELEGRAM_API_URL` | API 地址 | `https://api.telegram.org` |

## 镜像标签

每次推送自动构建，版本号根据 commit 内容递增：

| 提交前缀 | 版本变化 |
|----------|----------|
| `feat: xxx` | 次版本 +1 |
| `fix: xxx` | 补丁 +1 |
| `BREAKING CHANGE` | 主版本 +1 |

标签：`latest` + `v{版本号}`

## License

MIT
