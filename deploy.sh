#!/usr/bin/env bash
set -euo pipefail

# CortxtOS 一键部署 —— 目标机: CentOS Stream 9（腾讯云轻量）
# 用法: 把整个仓库放到服务器 /opt/cortxtos，然后 bash deploy.sh（幂等，可重复执行）

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

echo "==> [1/6] 安装 Docker（国内镜像源优先，已装则跳过）"
if ! command -v docker >/dev/null 2>&1; then
  dnf -y install dnf-plugins-core
  REPO_OK=0
  for REPO_URL in \
    https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo \
    https://mirrors.tuna.tsinghua.edu.cn/docker-ce/linux/centos/docker-ce.repo \
    https://download.docker.com/linux/centos/docker-ce.repo; do
    echo "尝试仓库源: $REPO_URL"
    if dnf -y config-manager --add-repo "$REPO_URL" 2>/dev/null; then
      # docker-ce.repo 里的下载地址同步替换成对应镜像
      MIRROR_HOST="$(echo "$REPO_URL" | sed -E 's|https://([^/]+)/.*|\1|')"
      case "$MIRROR_HOST" in
        mirrors.aliyun.com) sed -i 's|download.docker.com|mirrors.aliyun.com/docker-ce|g' /etc/yum.repos.d/docker-ce.repo ;;
        mirrors.tuna.tsinghua.edu.cn) sed -i 's|download.docker.com|mirrors.tuna.tsinghua.edu.cn/docker-ce|g' /etc/yum.repos.d/docker-ce.repo ;;
      esac
      REPO_OK=1
      break
    fi
    rm -f /etc/yum.repos.d/docker-ce.repo
  done
  [ "$REPO_OK" = "1" ] || { echo "所有 docker-ce 仓库源均不可达"; exit 1; }
  dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi
docker compose version >/dev/null 2>&1 || dnf -y install docker-compose-plugin

# 腾讯云内网镜像源兜底（Hub 抽风时基础镜像拉不动）；仅在未配置任何加速时写入
if [ -d /etc/docker ] && ! grep -qs 'registry-mirrors' /etc/docker/daemon.json 2>/dev/null; then
  echo '{"registry-mirrors": ["https://mirror.ccs.tencentyun.com"]}' > /etc/docker/daemon.json
  systemctl restart docker 2>/dev/null || true
  echo "已配置腾讯云内网镜像加速 mirror.ccs.tencentyun.com"
fi

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

echo "==> [4/6] 准备 .env"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "已从模板生成 .env —— 请填入 APP_PASSWORD / LLM_API_KEY / LLM_BASE_URL 后重新执行本脚本"
  exit 1
fi
grep -q '^APP_PASSWORD=..*' .env || { echo ".env 里 APP_PASSWORD 还没填"; exit 1; }

echo "==> [5/6] 每日备份 cron（02:30，保留 14 份）"
chmod +x "$APP_DIR/backup.sh"
if ! crontab -l 2>/dev/null | grep -q 'backup.sh'; then
  (crontab -l 2>/dev/null; echo "30 2 * * * bash $APP_DIR/backup.sh >> /var/log/cortxt-backup.log 2>&1") | crontab -
  echo "已安装备份 cron"
fi

echo "==> [6/6] 构建并启动"
docker compose up -d --build
sleep 3
docker compose ps
echo
echo "部署脚本已跑完。两件脚本做不了的事，请确认："
echo "  1) 腾讯云控制台 → 轻量应用服务器 → 防火墙：放行 80/443"
echo "  2) DNSPod：A 记录 cortxt.hgl123.icu -> 本机公网 IP"
