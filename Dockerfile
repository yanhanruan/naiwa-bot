# 奶蛙的镜像（Module 10）：docker compose 的 bot、alert 服务都用它。node:22-alpine 要自己先拉好。
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY bin ./bin
COPY migrations ./migrations
COPY persona ./persona
COPY scripts/trace.mjs scripts/alert-check.mjs ./scripts/
# 跑的是哪个提交：npm run deploy 构建时传进来，naiwa status 和启动日志里显示（容器里没有 git）。
ARG GIT_COMMIT=
ENV GIT_COMMIT=$GIT_COMMIT
ENV LOG_DIR=/app/logs BACKUP_DIR=/app/backups
CMD ["node", "bin/fish-bot.mjs"]
