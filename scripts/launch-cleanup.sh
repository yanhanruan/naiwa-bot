#!/usr/bin/env bash
# 上线前清理第 1 步（Module 10，见 docs/deploy.md“上线那天”）：只列出要删的东西，什么都不删。
# 开发期的文件分散在主工作区和各个分支工作区里：按“和本仓库同一个目录下的 naiwa-bot*”逐个找 data/、backups/、logs/，
# 再加上数据库卷。哪一项该有东西却是 0，先停下来查是不是走错了目录。
set -euo pipefail
cd "$(dirname "$0")/.."
PARENT="$(cd .. && pwd)"
echo "要删的开发期数据（在 $PARENT 下）："
found=0
for repo in "$PARENT"/naiwa-bot*/; do
  for sub in data backups logs; do
    dir="${repo}${sub}"
    [[ -d "$dir" ]] || continue
    count=$(find "$dir" -type f | wc -l | tr -d ' ')
    size=$(du -sh "$dir" | cut -f1)
    printf '  %-60s %4s 个文件  %s\n' "${dir#"$PARENT"/}" "$count" "$size"
    found=$((found + count))
  done
done
echo "  共 $found 个文件"
volume="naiwa-bot_naiwa-pg"
if docker volume inspect "$volume" > /dev/null 2>&1; then
  echo "  Docker 卷 $volume（数据库本身）"
else
  echo "  Docker 卷 $volume：没找到（是不是已经删了？）"
fi
echo "这一步什么都没删。确认无误后照 docs/deploy.md“上线那天”往下做。"
