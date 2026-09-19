#!/usr/bin/env bash
set -euo pipefail

# CortxtOS 一键更新：拉代码 → 重建启动 → 健康检查 → 清理旧镜像
cd /opt/cortxtos

echo "==> [1/4] 拉取最新代码"
OLD_HEAD="$(git rev-parse --short HEAD)"
git pull --ff-only
NEW_HEAD="$(git rev-parse --short HEAD)"
[ "$OLD_HEAD" = "$NEW_HEAD" ] && echo "已是最新 ($NEW_HEAD)，仅重建" || echo "更新: $OLD_HEAD -> $NEW_HEAD"

echo "==> [2/4] 重建并启动"
docker compose up -d --build

echo "==> [3/4] 健康检查"
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
    echo "healthz OK"
    docker compose ps
    echo "==> [4/4] 清理悬空镜像"
    docker image prune -f >/dev/null 2>&1 || true
    echo "更新完成 ✦  https://cortxt.hgl123.icu"
    exit 0
  fi
  sleep 2
done

echo "健康检查失败！查看日志: docker compose logs app --tail 50"
exit 1
