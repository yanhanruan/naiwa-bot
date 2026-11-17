// 结构化日志：一行一个事件，固定字段 ts / level / event，其余是调用方给的字段。
// 约定：
// - event 用英文点号命名（例如 send.failed），方便检索；msg 是给人看的中文说明，可省略。
// - 一条消息经历的各个阶段都带上 messageKey，按它就能串起这条消息的完整经过。
// - 不记录聊天正文、昵称、token：日志只放标识、计数、耗时和错误。
// - 写日志失败不影响业务。

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

// 运行时默认：LOG_LEVEL 控制级别；LOG_FORMAT 未设置时，终端里用 pretty，否则（例如 Docker）用 json。
export function loggerFromEnv(env = process.env, stream = process.stdout) {
  const format = env.LOG_FORMAT === 'json' || env.LOG_FORMAT === 'pretty'
    ? env.LOG_FORMAT : (stream.isTTY ? 'pretty' : 'json');
  return createLogger({ level: env.LOG_LEVEL || 'info', format });
}

export const silentLogger = createLogger({ write: () => {} });
