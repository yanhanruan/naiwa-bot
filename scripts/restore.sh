#!/usr/bin/env bash
set -euo pipefail
# 从 backup.sh 生成的文件恢复 PostgreSQL。会用备份内容覆盖当前数据库里的同名表。
# 用法：scripts/restore.sh <备份文件> --yes
# - 还有别的程序连着数据库（奶蛙在跑，或者 fish 命令没退出）就拒绝：奶蛙内存里记着“几号代号是谁”，
#   恢复以后会和数据库对不上，可能把话记到别人头上。
# - 恢复前先用 backup.sh 备份一份当前数据库，恢复错了还能退回去。
# - 这份备份之后才按人删除（forget-person）的人，恢复会把他的数据带回来，恢复完要对他重新执行一次。
cd "$(dirname "$0")/.."
IN="${1:?用法: scripts/restore.sh <备份文件> --yes}"
if [[ "${2:-}" != "--yes" ]]; then
  echo "这会用 $IN 覆盖当前数据库。确认请加 --yes。" >&2
  exit 1
fi
OTHERS="$(docker compose exec -T db psql -U naiwa -d naiwa -Atc \
  "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'")"
if [[ "$OTHERS" != "0" ]]; then
  echo "还有 $OTHERS 个连接连着数据库（奶蛙在跑，或者别的程序没退出），拒绝恢复：请先全部停掉。" >&2
  exit 1
fi
if [[ ! -f "$IN" ]]; then
  echo "找不到备份文件：$IN" >&2
  exit 1
fi
echo "恢复前先备份当前数据库："
scripts/backup.sh
docker compose exec -T db pg_restore -U naiwa -d naiwa --clean --if-exists --single-transaction --exit-on-error < "$IN"
echo "已从 $IN 恢复。这份备份之后按人删除过的人，请对他们重新执行一次 forget-person。"
