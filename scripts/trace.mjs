#!/usr/bin/env node
// 查卡在哪（Module 10，见 docs/module-10-deploy-design.md 第 4.3 节）。
//   npm run trace                                    整体情况
//   npm run trace -- 群 <群号> [QQ <号码>] [日期] [时间]  这个群（这个人）那段时间每一句走到了哪一步
//   npm run trace -- 私聊 <号码> [日期] [时间]
//   npm run trace -- <messageKey>                    一条消息的全部日志
// 日期：今天、昨天、前天、11-25；时间：14:05（前后 10 分钟）。不写时间：写了日期就是那一整天，都没写就是最近 30 分钟。
// 逐句记录只读日志文件（LOG_DIR，默认 ./logs），奶蛙、数据库都停着也能查；“现在”那一行要读数据库，连不上就直说。
// 奶蛙停着、本机又没装 Node：docker compose run --rm --no-deps bot node scripts/trace.mjs …
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  parseArgs, readLogs, statusTimeline, conversationReport, messageReport, overviewLines, nowLine, clock,
} from '../src/ops/trace.js';
import { backupState, BACKUP_STALE_MS } from '../src/ops/backups.js';
import { readStatus } from '../src/admin/status.js';
import { Settings } from '../src/admin/settings.js';
import { ModelUsageLedger } from '../src/model/usage-ledger.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const logDir = resolve(process.env.LOG_DIR || join(root, 'logs'));
const backupDir = resolve(process.env.BACKUP_DIR || join(root, 'backups'));
const now = Date.now();

let q;
try {
  q = parseArgs(process.argv.slice(2), now);
} catch (error) {
  console.error(`${error.message}。用法：npm run trace -- 群 <群号> [QQ <号码>] [昨天|11-25] [14:05]，或者私聊 <号码>，或者什么都不写看整体`);
  process.exit(1);
}

const logs = readLogs(logDir, { to: q.mode === 'overview' ? now : q.to });
if (q.mode === 'message') {
  for (const line of messageReport(q.messageKey, logs)) console.log(line);
  process.exit(0);
}

// 读数据库：奶蛙现在的状态、今天的花费。连不上（或者 3 秒没连上）就算了。
async function fromDatabase() {
  if (!process.env.DATABASE_URL) return null;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3_000, query_timeout: 5_000 });
  try {
    await client.connect();
    const status = await readStatus(client);
    const settings = new Settings({ db: client });
    await settings.refresh();
    const today = await new ModelUsageLedger({ db: client }).day();
    return { status, budget: settings.dailyBudgetCny, spent: today.costCny };
  } catch {
    return null;
  } finally {
    await client.end().catch(() => {});
  }
}

const db = await fromDatabase();
const timeline = statusTimeline(logs.records);
console.log(nowLine(db?.status ?? null, timeline, now));
if (!logs.records.length) console.log(`日志目录 ${logDir} 里还没有日志（奶蛙要设了 LOG_DIR 才写文件）`);

if (q.mode === 'overview') {
  const [recent, problems] = overviewLines(logs, now);
  console.log(db ? `${recent}；今天花了 ¥${db.spent.toFixed(2)} / ${db.budget ? db.budget : '不限'}` : recent);
  console.log(problems);
  const { latest, drill } = backupState(backupDir);
  if (!latest) console.log('最近一次备份：⚠ 还没有');
  else {
    const stale = now - latest.at > BACKUP_STALE_MS ? '⚠ 超过一天半了，' : '';
    const drilled = drill?.file === latest.file
      ? (drill.ok ? `，可以恢复（${clock(Date.parse(drill.at), now)} 演练过）` : `，⚠ 恢复演练失败：${drill.detail ?? ''}`)
      : '，还没演练过';
    console.log(`最近一次备份：${stale}${clock(latest.at, now)}${drilled}`);
  }
} else {
  for (const line of conversationReport(q, logs, now)) console.log(line);
}
