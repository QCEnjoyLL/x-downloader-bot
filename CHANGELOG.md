# 更新日志

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
