# X Downloader Bot

> Telegram 机器人 — 自动提取 Twitter/X 视频和图片，直接下载发送最高清文件。

[![Docker Pulls](https://img.shields.io/docker/pulls/orangeqiu/x-downloader-bot)](https://hub.docker.com/r/orangeqiu/x-downloader-bot)

## 功能

- 🎬 自动解析 Twitter/X 链接，提取视频和图片
- 🔴 支持**直播回放**（`x.com/i/broadcasts/...`）解析（内置 yt-dlp + ffmpeg，合并 HLS 为 mp4）
- ⚡ **多链接并发**处理，回复迅速；每个视频引用你发送的原链接，方便对应
- 📏 下载前用 HEAD 取**真实文件大小**（不再是粗略预估）
- 📥 默认下载模式，直接发送视频文件到 Telegram
- 🎯 默认最高清，自动选择最高码率
- 🔗 上传后附带多清晰度链接
- 💾 视频自动保存到本地（`./downloads` 目录）
- 🌊 视频流式落盘并从磁盘上传，大文件不再整段载入内存
- 📤 上传完成传输后显示 Telegram 处理状态和等待时间
- 🧰 Telegram 更新先写入 SQLite 持久化队列，异常重启后自动续跑
- 🛡️ 支持 Chat 白名单、请求限速、单消息链接上限和全局媒体并发
- 💽 支持下载文件保留期、目录配额和磁盘剩余空间保护
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
# HOST_PORT 可修改宿主机端口；COMPOSE_PROFILES 控制是否启用本地 API

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

### 4. 更新

```bash
docker compose pull && docker compose up -d
```

## 两种运行模式

| 模式 | 说明 |
|------|------|
| **轮询**（默认，`POLLING=true`） | 主动拉取消息，无需公网 IP，启动即用 |
| Webhook | Telegram 推送，需要 HTTPS 公网地址及安全密钥 |

Webhook 模式必须配置 `WEBHOOK_URL`、`WEBHOOK_SECRET` 和 `WEBHOOK_SETUP_KEY`。启动后调用一次受保护的设置入口：

```bash
# .env
POLLING=false
WEBHOOK_URL=https://bot.example.com/webhook
WEBHOOK_SECRET=随机字符串
WEBHOOK_SETUP_KEY=另一段随机字符串

curl -H "X-Webhook-Setup-Key: 另一段随机字符串" \
  "https://bot.example.com/setup-webhook"
```

`WEBHOOK_SECRET` 会同时注册给 Telegram，并用于校验每次 Webhook 请求；设置密钥通过请求头传递，避免出现在 URL 日志中。不要把两个密钥写进公开日志或提交到仓库。

## 上传限制

| 模式 | 上限 |
|------|------|
| 云端 API（默认） | 50 MB |
| 本地 Bot API | **2 GB** |

启用 2GB：

```bash
# .env 中添加（先去 https://my.telegram.org/apps 创建应用）
COMPOSE_PROFILES=local-api
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=abcdef1234567890abcdef1234567890

docker compose up -d
```

将 `COMPOSE_PROFILES` 留空即可禁用 API 容器，Bot 会使用官方 API（50MB）。设为 `local-api` 后，普通的 `docker compose up -d` 会同时以 `TELEGRAM_LOCAL=1`（`--local`）模式启动 API 容器，Bot 也会自动切换到 `http://api:8081`（约 2GB），无需再设置 `TELEGRAM_API_URL`。该变量仅用于手动覆盖 API 地址。接近 2GB 的文件虽然采用磁盘流式传输，但仍需预留足够的磁盘空间、上传时间和带宽。

## 命令

| 命令 | 说明 |
|------|------|
| `/start` | 欢迎信息 |
| `/mode` | 查看/切换下载或链接模式 |
| `/quality high\|medium\|low` | 视频画质偏好 |

发送 Twitter/X 链接（`x.com/xxx/status/123` 或 `twitter.com/xxx/status/123`），机器人自动下载最高清视频并发送。直播回放发送 `x.com/i/broadcasts/xxx` 即可。多条链接可一次性发送，会并发处理。

## 目录结构

```
.
├── data/prefs.json      # 用户偏好（首次使用 /mode 或 /quality 后生成）
├── data/jobs.sqlite     # Telegram update 持久化任务队列
├── downloads/           # 下载的视频文件（上传失败会保留）
├── telegram-api/        # 本地 API 缓存
└── .env                 # 环境变量
```

## 配置

| 变量 | 说明 | 默认 |
|------|------|------|
| `BOT_TOKEN` | Telegram Bot Token | — |
| `POLLING` | 轮询模式 | `true` |
| `HOST_PORT` | Docker Compose 暴露到宿主机的端口 | `3000` |
| `PORT` | Bot 内部监听端口（Compose 固定为 3000） | `3000` |
| `CLEANUP_VIDEOS` | 上传成功后立即删除本地视频；关闭后仍受保留期约束 | `true` |
| `DOWNLOAD_CONCURRENCY` | 所有用户共享的媒体下载/上传并发上限（1–10） | `3` |
| `UPDATE_CONCURRENCY` | 持久化 update 队列工作线程数（1–32） | `8` |
| `JOB_MAX_ATTEMPTS` | update 任务失败后的最大尝试次数 | `3` |
| `MAX_LINKS_PER_MESSAGE` | 每条消息最多处理的链接数 | `5` |
| `MAX_REQUESTS_PER_MINUTE` | 每个 Chat 每分钟最多请求数 | `10` |
| `ALLOWED_CHAT_IDS` | Chat ID 白名单，逗号分隔；留空允许所有 Chat | — |
| `DOWNLOAD_RETENTION_HOURS` | 下载文件保留小时数；`0` 表示不定时清理 | `24` |
| `MAX_DOWNLOAD_DISK_GB` | 下载目录最大容量；`0` 表示不限制 | `20` |
| `MIN_FREE_DISK_GB` | 下载时必须保留的磁盘可用空间；`0` 表示不限制 | `1` |
| `DEBUG_UPDATES` | 记录完整消息内容（仅调试使用） | `false` |
| `BROADCAST_RESOLVER_URL` | 直播回放第三方解析兜底接口（`{url}` 占位，可选） | — |
| `ALLOW_PRIVATE_DOWNLOADS` | 允许下载解析到本机/私网的 URL（有 SSRF 风险） | `false` |
| `COMPOSE_PROFILES` | `local-api` 启用本地 API 容器，留空禁用 | — |
| `TELEGRAM_API_ID` | 本地 API ID（可选） | — |
| `TELEGRAM_API_HASH` | 本地 API Hash（可选） | — |
| `TELEGRAM_API_URL` | API 地址覆盖；留空时根据 `COMPOSE_PROFILES` 自动选择 | 自动 |
| `WEBHOOK_URL` | 公网 HTTPS Webhook 完整地址 | — |
| `WEBHOOK_SECRET` | Telegram 请求校验密钥 | — |
| `WEBHOOK_SETUP_KEY` | `/setup-webhook` 管理入口密钥 | — |

## 本地开发与检查

```bash
npm install
npm test
npm start
```

本地运行要求 Node.js 22.5 或更高版本。自测不需要真实 Bot Token；实际启动和端到端 Telegram 验证需要在 `.env` 中配置 Token。

## 稳定性与访问控制

轮询和 Webhook 收到的 Telegram update 都会先写入 `data/jobs.sqlite`，写入成功后才确认接收。相同 `update_id` 不会重复入队；进程异常退出时，正在执行的任务会在下次启动后重新进入队列。失败任务按指数退避重试，达到 `JOB_MAX_ATTEMPTS` 后保留为失败状态，便于通过 `/health` 查看统计。

公开部署建议配置 `ALLOWED_CHAT_IDS`，例如 `123456789,-1001234567890`。限速按 Chat 计算；`DOWNLOAD_CONCURRENCY` 是整个进程的全局上限，不会因用户增多而无限增加下载、上传和磁盘压力。

下载目录每小时清理超过 `DOWNLOAD_RETENTION_HOURS` 的文件。即使 `CLEANUP_VIDEOS=false`，文件默认也只保留 24 小时；需要永久保留时再将 `DOWNLOAD_RETENTION_HOURS=0`。`MAX_DOWNLOAD_DISK_GB` 和 `MIN_FREE_DISK_GB` 会在下载前及下载过程中阻止磁盘被占满。

## 镜像标签与发行版

每次推送 master 自动构建，版本号从 `package.json` 读取，手动修改即可控制版本。构建成功后还会**自动创建对应的 GitHub Release**（含源码 zip/tar.gz），更新说明取自 [`CHANGELOG.md`](CHANGELOG.md) 中对应版本段落。

| 标签 | 说明 |
|------|------|
| `latest` | 最新版本 |
| `v1.8.3` | 对应 package.json 中的版本 |

> [Releases 页面](https://github.com/QCEnjoyLL/x-downloader-bot/releases) 与镜像版本一一对应。

## License

MIT
