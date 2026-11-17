#!/usr/bin/env bash
set -euo pipefail
# 从 backup.sh 生成的文件恢复 PostgreSQL。会用备份内容覆盖当前数据库里的同名表。
# 用法：scripts/restore.sh <备份文件> --yes
# 恢复前请先停止机器人和其他连接数据库的进程。
cd "$(dirname "$0")/.."
IN="${1:?用法: scripts/restore.sh <备份文件> --yes}"
if [[ "${2:-}" != "--yes" ]]; then
  echo "这会用 $IN 覆盖当前数据库。确认请加 --yes。" >&2
  exit 1
fi
docker compose exec -T db pg_restore -U naiwa -d naiwa --clean --if-exists --single-transaction --exit-on-error < "$IN"
echo "已从 $IN 恢复"
