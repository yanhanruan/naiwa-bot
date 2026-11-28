// 结构化日志：一行一个事件，固定字段 ts / level / event，其余是调用方给的字段。
// 约定：
// - event 用英文点号命名（例如 send.failed），方便检索；msg 是给人看的中文说明，可省略。
// - 一条消息经历的各个阶段都带上 messageKey，按它就能串起这条消息的完整经过。
// - 不记录聊天正文、昵称、token：日志只放标识、计数、耗时和错误。
// - 写日志失败不影响业务。
// - 设了 LOG_DIR 时另写一份到文件（Module 10）：每天一个文件、到 debug 级别、一行一个 JSON，超过 LOG_KEEP_DAYS（默认 14）天删掉。
//   终端和 docker logs 仍按 LOG_LEVEL。npm run trace 读这些文件。

import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL_TEXT = { debug: '调试', info: '信息', warn: '警告', error: '错误' };
const RESERVED = new Set(['ts', 'level', 'event']);
const ERROR_FIELDS = ['code', 'delivery', 'action', 'retcode', 'status', 'httpStatus', 'providerCode', 'traceId'];

// Error 对象直接 JSON.stringify 会变成 {}，这里只取消息和少量诊断字段，不带调用栈。
function serializeError(error) {
  if (!(error instanceof Error)) return { message: String(error) };
  const out = { name: error.name, message: error.message };
  for (const key of ERROR_FIELDS) if (error[key] !== undefined) out[key] = error[key];
  return out;
}

function copyFields(target, fields) {
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === undefined || RESERVED.has(key)) continue;
    target[key] = key === 'error' ? serializeError(value) : value;
  }
  return target;
}

function prettyValue(value) {
  if (typeof value === 'string' && value && !/[\s"=]/.test(value)) return value;
  return JSON.stringify(value);
}

function pretty(record) {
  const { ts, level, event, msg, error, ...rest } = record;
  const time = new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
  const parts = [time, LEVEL_TEXT[level], event];
  if (msg) parts.push(msg);
  for (const [key, value] of Object.entries(rest)) parts.push(`${key}=${prettyValue(value)}`);
  if (error) {
    parts.push(`error=${prettyValue(error.message)}`);
    for (const key of ERROR_FIELDS) if (error[key] !== undefined) parts.push(`error.${key}=${prettyValue(error[key])}`);
  }
  return parts.join(' ');
}

function defaultWrite(line, level) {
  (level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
}

/**
 * @param {object} [options]
 * @param {'debug'|'info'|'warn'|'error'} [options.level] 低于这个级别的不输出
 * @param {'json'|'pretty'} [options.format] json：一行一个 JSON；pretty：给人在终端里看
 * @param {(line: string, level: string, record: object) => void} [options.write]
 * @param {object} [options.bindings] 每一行都带上的字段（child() 用它叠加）
 */
export function createLogger({ level = 'info', format = 'json', write = defaultWrite, now = () => new Date(), bindings = {} } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;

  function emit(lvl, event, fields) {
    if (LEVELS[lvl] < min) return;
    const record = copyFields(copyFields({ ts: now().toISOString(), level: lvl, event }, bindings), fields);
    let line;
    try {
      line = format === 'pretty' ? pretty(record) : JSON.stringify(record);
    } catch {
      line = JSON.stringify({ ts: record.ts, level: lvl, event, logError: '字段无法序列化' });
    }
    try {
      write(line, lvl, record);
    } catch {
      // 日志写不出去也不能让业务出错。
    }
  }

  return {
    level: Object.keys(LEVELS).find((k) => LEVELS[k] === min),
    format,
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child: (more) => createLogger({ level, format, write, now, bindings: copyFields({ ...bindings }, more) }),
  };
}

// 北京时间的日期，例如 2026-11-26（中国没有夏令时，固定 +8 小时）。
export function beijingDay(at) {
  return new Date(new Date(at).getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

const LOG_FILE = /^([a-z]+)-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * 日志文件：<dir>/<prefix>-<北京日期>.jsonl，只有本人能读。
 * 写失败不抛错，只在标准错误里说一次（之后又写成功了再说一次）。
 */
export function createLogFile({ dir, prefix = 'bot', keepDays = 14, now = () => new Date(), onError = (text) => process.stderr.write(`${text}\n`) }) {
  const root = resolve(dir);
  let failing = false;
  return {
    dir: root,
    write(record) {
      try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        appendFileSync(join(root, `${prefix}-${beijingDay(record.ts)}.jsonl`), `${JSON.stringify(record)}\n`, { mode: 0o600 });
        if (failing) onError('日志文件又写得进去了');
        failing = false;
      } catch (error) {
        if (!failing) onError(`日志文件写不进去（${error?.code ?? error?.message ?? error}），先只打到终端`);
        failing = true;
      }
    },
    // 删掉 keepDays 天以前的日志文件（所有前缀都删：奶蛙、提醒服务写在同一个目录）。返回删了几个。
    prune() {
      const oldest = beijingDay(now().getTime() - (keepDays - 1) * 86_400_000);
      let removed = 0;
      let names = [];
      try {
        names = readdirSync(root);
      } catch {
        return 0;
      }
      for (const name of names) {
        const match = LOG_FILE.exec(name);
        if (!match || match[2] >= oldest) continue;
        try {
          unlinkSync(join(root, name));
          removed += 1;
        } catch {
          // 删不掉下次再删
        }
      }
      return removed;
    },
  };
}

// 运行时默认：LOG_LEVEL 控制级别；LOG_FORMAT 未设置时，终端里用 pretty，否则（例如 Docker）用 json。
// 设了 LOG_DIR：另写一份到文件（总是到 debug 级别），返回的 logger 多一个 pruneFiles()。
export function loggerFromEnv(env = process.env, stream = process.stdout, { prefix = 'bot', now } = {}) {
  const format = env.LOG_FORMAT === 'json' || env.LOG_FORMAT === 'pretty'
    ? env.LOG_FORMAT : (stream.isTTY ? 'pretty' : 'json');
  const level = env.LOG_LEVEL || 'info';
  if (!env.LOG_DIR) return { ...createLogger({ level, format }), pruneFiles: () => 0 };
  const keepDays = Number(env.LOG_KEEP_DAYS || 14);
  if (!Number.isInteger(keepDays) || keepDays < 1) throw new Error('LOG_KEEP_DAYS 必须是不小于 1 的整数');
  const file = createLogFile({ dir: env.LOG_DIR, prefix, keepDays, ...(now ? { now } : {}) });
  const consoleMin = LEVELS[level] ?? LEVELS.info;
  const write = (line, lvl, record) => {
    if (LEVELS[lvl] >= consoleMin) defaultWrite(line, lvl);
    file.write(record);
  };
  const logger = createLogger({ level: 'debug', format, write, ...(now ? { now } : {}) });
  return { ...logger, level: Object.keys(LEVELS).find((k) => LEVELS[k] === consoleMin), logDir: file.dir, pruneFiles: () => file.prune() };
}

export const silentLogger = createLogger({ write: () => {} });
