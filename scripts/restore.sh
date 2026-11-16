#!/usr/bin/env bash
set -euo pipefail
# 恢复 fish-os 数据目录。
HOME_DIR="${FISH_HOME:-$HOME/.fish-os}"
IN="${1:?用法: restore.sh <backup.tar.gz>}"
mkdir -p "$HOME_DIR"
tar -xzf "$IN" -C "$(dirname "$HOME_DIR")"
echo "已从 $IN 恢复到 $HOME_DIR"
