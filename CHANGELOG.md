# 更新日志

## v1.7.0
- 修复链接模式处理纯文本或图片推文时引用未定义消息 ID 的错误，并修复损坏的提示字符
- Docker Compose 默认改用官方 Telegram API；本地 2GB API 改为 `local-api` profile 显式启用
- 普通视频、直链和直播回放改为磁盘流式下载/上传，显著降低大文件内存占用
- Webhook 增加 secret token 校验和受保护的设置入口，并改为先响应再异步处理；默认不再记录完整消息内容
- 轮询失败增加指数退避，重启时不再丢弃待处理更新
- 用户偏好改为串行、原子写入；补充超时、并发范围限制和项目元数据

## v1.6.6
- 上传更稳健：流式上传遇到任何失败（含 Telegram 返回 ok:false）都自动回退到 fetch，确保上传不被新代码破坏

## v1.6.5
- 上传视频也显示实时进度（百分比 + 已传/总大小）：改用流式 multipart 上传（http/https 手写请求 + Content-Length），按块写入并计字节；fetch 仅作传输失败时的回退

## v1.6.4
- `/start` 回复当前版本号
- 直播回放上传时用 ffprobe 读取真实宽高并传给 Telegram，修复手机端长宽比显示错误

## v1.6.3
- 普通视频下载也显示实时进度（百分比 + 已下载/总大小，每约 4 秒刷新）
- 下载超时从 60 秒放宽到 10 分钟，避免大文件被中途打断
- 发行版(Release)改用本 CHANGELOG 对应版本段落作为更新说明

## v1.6.2
- CI：每次发布自动创建对应版本的 GitHub Release（自动附带源码 zip/tar.gz）
- 增加 concurrency 分组，避免重复构建竞态

## v1.6.1
- 直播回放下载实时进度：yt-dlp 输出逐行进容器日志，Telegram 消息显示百分比

## v1.6.0
- 视频大小改用 HEAD 真实 `Content-Length`（不再 bitrate 粗估），`formatFileSize` 支持 GB
- 多链接并发下载（`DOWNLOAD_CONCURRENCY`，默认 3），每条链接独立状态消息、回复迅速
- 下载完成的视频引用原推文链接（`reply_to` + caption 内 `🔗 源链接`），便于一一对应
- 新增直播回放(broadcasts)解析：`x.com/i/broadcasts/ID`，yt-dlp + ffmpeg 合并 HLS，含可配置第三方兜底
