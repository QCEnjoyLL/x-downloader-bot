FROM node:20-alpine

WORKDIR /app

# 安装依赖（仅生产）
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --production

# 复制源码
COPY src/ ./src/

# 确保数据目录存在
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "src/server.js"]
