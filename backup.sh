#!/usr/bin/env bash
set -euo pipefail

# CortxtOS 数据备份：打包 /data → /backups，保留最近 14 份（DESIGN §9.4）
# 挂到 cron 每日执行；恢复 = 解包回 /data 后重启容器

DATA_DIR="${CORTEXT_DATA_DIR:-/opt/cortxtos/data}"
BACKUP_DIR="${CORTEXT_BACKUP_DIR:-/backups}"
KEEP="${CORTEXT_BACKUP_KEEP:-14}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="$BACKUP_DIR/cortxt-$STAMP.tar.gz"

tar -czf "$TARGET" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"

# 保留最近 KEEP 份
ls -1t "$BACKUP_DIR"/cortxt-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f

echo "[$(date '+%F %T')] 备份完成: $TARGET"
