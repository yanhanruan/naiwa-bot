#!/usr/bin/env bash
set -euo pipefail
# 备份 PostgreSQL（docker compose 的 db 服务）为 pg_dump 自定义格式文件。
# 用法：scripts/backup.sh [输出文件]   默认 backups/naiwa-pg-<时间>.dump
cd "$(dirname "$0")/.."
umask 077  # 备份包含聊天记录，只允许本人读取
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${1:-backups/naiwa-pg-$STAMP.dump}"
mkdir -p "$(dirname "$OUT")"
TMP="$OUT.partial"
docker compose exec -T db pg_dump -U naiwa -d naiwa --format=custom > "$TMP"
# 校验：能被 pg_restore 读出目录才算备份成功
docker compose exec -T db pg_restore --list < "$TMP" > /dev/null
mv "$TMP" "$OUT"
echo "已备份 -> $OUT（$(wc -c < "$OUT" | tr -d ' ') 字节）"
