#!/bin/sh
# 恢复演练（Module 10）：把一份备份恢复进临时库 naiwa_drill，检查完删掉。不碰线上库，奶蛙照常跑。
# 用法（宿主机）：scripts/restore-drill.sh [备份文件]   不写就用 backups/ 里最新的
# 结果写进 backups/drill-latest.json，npm run trace 和提醒服务读它。每日备份（backup 服务）备份完也会跑一次。
set -eu
if [ -z "${IN_BACKUP_CONTAINER:-}" ]; then
  # 在宿主机上：借 backup 服务的环境（数据库地址、密码、备份目录）临时起一个容器来跑。只认 backups/ 里的文件。
  cd "$(dirname "$0")/.."
  if [ -n "${1:-}" ]; then
    exec docker compose run --rm --no-deps -T backup sh /scripts/restore-drill.sh "$(basename "$1")"
  fi
  exec docker compose run --rm --no-deps -T backup sh /scripts/restore-drill.sh
fi

DIR=/backups
DRILL=naiwa_drill
FILE="${1:-$(ls -1 "$DIR" | grep -E '^naiwa-pg-[0-9]{8}-[0-9]{6}\.dump$' | sort | tail -1 || true)}"

result() { # ok(true/false) 说明
  printf '{"at":"%s","file":"%s","ok":%s,"detail":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$FILE" "$1" "$2" > "$DIR/drill-latest.json.tmp"
  mv "$DIR/drill-latest.json.tmp" "$DIR/drill-latest.json"
  if [ "$1" = true ]; then echo "$FILE 可以恢复：$2"; else echo "$FILE 恢复演练失败：$2" >&2; fi
}

if [ -z "$FILE" ] || [ ! -f "$DIR/$FILE" ]; then
  echo "找不到备份文件：${FILE:-backups/ 里没有备份}" >&2
  exit 1
fi
trap 'dropdb --if-exists "$DRILL" 2>/dev/null || true' EXIT
dropdb --if-exists "$DRILL"
createdb "$DRILL"
if ! pg_restore -d "$DRILL" --no-owner --exit-on-error < "$DIR/$FILE" 2> /tmp/drill-error; then
  result false "恢复出错：$(head -c 200 /tmp/drill-error | tr '\n"\\' '   ')"
  exit 1
fi
q() { psql -d "$DRILL" -Atc "$1"; }
MIGRATION=$(q "SELECT max(version) FROM schema_migrations" | cut -c1-3)
TURNS=$(q "SELECT count(*) FROM conversation_turns")
FACTS=$(q "SELECT count(*) FROM memory_facts")
ALIASES=$(q "SELECT count(*) FROM person_aliases")
result true "迁移到 $MIGRATION，原话 $TURNS 行，事实 $FACTS 条，代号 $ALIASES 个"
