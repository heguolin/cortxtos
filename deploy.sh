#!/usr/bin/env bash
set -euo pipefail

# CortxtOS 一键部署 —— 目标机: CentOS Stream 9（腾讯云轻量）
# 用法: 把整个仓库放到服务器 /opt/cortxtos，然后 bash deploy.sh（幂等，可重复执行）

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

echo "==> [1/5] 安装 Docker（官方源，已装则跳过）"
if ! command -v docker >/dev/null 2>&1; then
  dnf -y install dnf-plugins-core
  dnf -y config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
  dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi
docker compose version >/dev/null 2>&1 || dnf -y install docker-compose-plugin

echo "==> [2/5] 系统 firewalld 放行 80/443（腾讯云控制台防火墙需在控制台另行放行）"
if command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=http >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-service=https >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
fi

echo "==> [3/5] 确保 swap ≥ 2G（小内存机器索引防 OOM）"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> [4/5] 准备 .env"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "已从模板生成 .env —— 请填入 APP_PASSWORD / LLM_API_KEY / LLM_BASE_URL 后重新执行本脚本"
  exit 1
fi
grep -q '^APP_PASSWORD=..*' .env || { echo ".env 里 APP_PASSWORD 还没填"; exit 1; }

echo "==> [5/5] 构建并启动"
docker compose up -d --build
sleep 3
docker compose ps
echo
echo "部署脚本已跑完。两件脚本做不了的事，请确认："
echo "  1) 腾讯云控制台 → 轻量应用服务器 → 防火墙：放行 80/443"
echo "  2) DNSPod：A 记录 cortxt.hgl123.icu -> 本机公网 IP"
