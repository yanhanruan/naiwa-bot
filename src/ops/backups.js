// 备份目录里的情况（Module 10）：最近一次备份、最近一次恢复演练的结果。trace 和提醒服务都读这里。
// 备份文件由 scripts/backup.sh 或 backup 服务（scripts/backup-daily.sh）写，名字是 naiwa-pg-<年月日>-<时分秒>.dump；
// 演练结果由 scripts/restore-drill.sh 写进 drill-latest.json。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DUMP = /^naiwa-pg-\d{8}-\d{6}\.dump$/;

/** @returns {{latest: {file: string, at: number}|null, drill: {at: string, file: string, ok: boolean, detail?: string}|null}} */
export function backupState(dir) {
  if (!dir || !existsSync(dir)) return { latest: null, drill: null };
  let latest = null;
  for (const file of readdirSync(dir)) {
    if (!DUMP.test(file)) continue;
    const at = statSync(join(dir, file)).mtimeMs;
    if (!latest || at > latest.at) latest = { file, at };
  }
  let drill = null;
  try {
    drill = JSON.parse(readFileSync(join(dir, 'drill-latest.json'), 'utf8'));
  } catch {
    // 还没演练过
  }
  return { latest, drill };
}

// 超过一天半没有新备份算“太久”。
export const BACKUP_STALE_MS = 36 * 3_600_000;
