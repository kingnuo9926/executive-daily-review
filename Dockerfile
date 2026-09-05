# 高管日复盘 App · Docker 镜像
# 零外部依赖（仅 Node 内置模块），无需 npm install。
FROM node:18-alpine

WORKDIR /app

# 仅复制运行所需文件；本地敏感数据 data/ 与 .workbuddy 在 .dockerignore 中已排除
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

# 容器内监听端口（由 PORT 控制，默认 3000）；宿主机经 6601 映射进来
ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000

# 健康检查：探测首页是否可访问（busybox wget 内置）
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/ >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
