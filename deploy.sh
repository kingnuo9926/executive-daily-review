#!/usr/bin/env bash
# 高管日复盘 App · 一键部署到 lms.kingnuo.cn（Docker）
# 用法：bash deploy.sh
# 说明：将本工程（排除 .git/.workbuddy/data 等敏感目录）打包推送到远端，
#       在远端用 docker compose 构建镜像并以 6601 端口对外提供服务。
set -euo pipefail

REMOTE="root@lms.kingnuo.cn"
PORT=17122
KEY="$HOME/.ssh/kingnuo_lms_key"
REMOTE_DIR="/opt/executive-daily-review"

SSH="ssh -p ${PORT} -i ${KEY} -o StrictHostKeyChecking=no ${REMOTE}"
SCP="scp -P ${PORT} -i ${KEY} -o StrictHostKeyChecking=no"

LOCAL_ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "==> [1/3] 打包工程并传输到 ${REMOTE}:${REMOTE_DIR}"
ssh -p ${PORT} -i ${KEY} -o StrictHostKeyChecking=no ${REMOTE} "mkdir -p ${REMOTE_DIR}"
tar --exclude='.git' --exclude='.workbuddy' --exclude='data' --exclude='node_modules' \
    --exclude='*.log' -czf - -C "${LOCAL_ROOT}" . \
  | ssh -p ${PORT} -i ${KEY} -o StrictHostKeyChecking=no ${REMOTE} "tar -xzf - -C ${REMOTE_DIR}"

echo "==> [2/3] 远端构建镜像并启动（端口 6601）"
${SSH} "cd ${REMOTE_DIR} && docker compose build && docker compose up -d"

echo "==> [3/3] 等待容器就绪并自检"
sleep 3
${SSH} "cd ${REMOTE_DIR} && docker compose ps && echo '--- health ---' && curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:6601/"

echo "==> 完成。访问：http://lms.kingnuo.cn:6601"
