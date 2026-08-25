FROM node:20-alpine

WORKDIR /app

# 直播回放(broadcasts)需要 yt-dlp + ffmpeg 合并 HLS 切片。
# 显式启用 community 源（ffmpeg 及其依赖在此），并用 pip 装最新 yt-dlp（X 解析对版本敏感，apk 稳定分支偏旧）。
RUN ALPINE_VER=$(cut -d'.' -f1,2 < /etc/alpine-release) && \
    echo "https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VER}/community" >> /etc/apk/repositories && \
    apk add --no-cache ffmpeg python3 py3-pip && \
    pip3 install --no-cache-dir --break-system-packages yt-dlp

# 安装依赖（仅生产）
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# 复制源码
COPY src/ ./src/

# 确保数据目录存在
RUN mkdir -p /app/data /app/downloads

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
