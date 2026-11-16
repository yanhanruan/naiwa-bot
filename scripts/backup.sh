#!/usr/bin/env bash
set -euo pipefail
# 备份 fish-os 数据目录（记忆/角色状态/事件）。
HOME_DIR="${FISH_HOME:-$HOME/.fish-os}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${1:-fish-os-backup-$STAMP.tar.gz}"
mkdir -p "$(dirname "$OUT")"
tar -czf "$OUT" -C "$(dirname "$HOME_DIR")" "$(basename "$HOME_DIR")"
echo "已备份 $HOME_DIR -> $OUT"
