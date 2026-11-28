#!/bin/sh
# 每日备份（Module 10，在 docker compose 的 backup 服务里跑）：
# - 北京时间 4 点以后、当天还没有备份，就备份一次；启动时上一次该做的没做（比如 Mac 那时关着）也马上补上；
# - 校验能读出目录才算成功；删掉 BACKUP_KEEP_DAYS（默认 7）天以前的备份；
# - 备份完做一次恢复演练（scripts/restore-drill.sh），结果写进 backups/drill-latest.json。
set -u
export TZ=CST-8 # 北京时间（镜像里没有时区数据库，用 POSIX 写法）
KEEP=${BACKUP_KEEP_DAYS:-7}
umask 077 # 备份里有聊天记录，只允许本人读

# 最近一次应该备份的时刻：今天 4 点（还没到 4 点就是昨天 4 点），写成和文件名一样的“年月日-时分秒”。
due() {
  if [ "$(date +%H)" -ge 4 ]; then day=$(date +%Y%m%d); else day=$(date -d "@$(( $(date +%s) - 86400 ))" +%Y%m%d); fi
  echo "$day-040000"
}
latest() {
  ls -1 /backups 2> /dev/null | grep -E '^naiwa-pg-[0-9]{8}-[0-9]{6}\.dump$' | sort | tail -1 | sed -E 's/^naiwa-pg-(.*)\.dump$/\1/'
}
backup() {
  out="/backups/naiwa-pg-$(date +%Y%m%d-%H%M%S).dump"
  if pg_dump --format=custom > "$out.partial" && pg_restore --list "$out.partial" > /dev/null; then
    mv "$out.partial" "$out"
    echo "$(date '+%F %T') 已备份 $(basename "$out")（$(wc -c < "$out" | tr -d ' ') 字节）"
    find /backups -maxdepth 1 -name 'naiwa-pg-*.dump' -mmin +$((KEEP * 1440)) -print -delete | sed 's|^/backups/|删掉过期备份 |'
    sh /scripts/restore-drill.sh "$(basename "$out")" || true
  else
    rm -f "$out.partial"
    echo "$(date '+%F %T') 备份失败，10 分钟后再试" >&2
  fi
}

# docker compose stop 时马上退出（sh 当 1 号进程时不处理就要等 10 秒被强杀）；sleep 放后台等，信号才能马上处理。
trap 'exit 0' TERM INT
echo "每日备份：北京时间 4 点，留 $KEEP 天"
while :; do
  last=$(latest)
  if [ -z "$last" ] || expr "$last" \< "$(due)" > /dev/null; then backup; fi
  sleep 600 &
  wait $!
done
