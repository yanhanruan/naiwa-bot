import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, loggerFromEnv } from '../src/log.js';
import { OneBotError } from '../src/adapters/onebot-errors.js';

function capture(options = {}) {
  const lines = [];
  const logger = createLogger({ now: () => new Date('2026-11-17T06:00:00Z'), write: (line, level) => lines.push({ line, level }), ...options });
  return { logger, lines };
}

test('json 格式：一行一个事件，固定字段在前，child 叠加字段', () => {
  const { logger, lines } = capture();
  logger.child({ messageKey: 'm1' }).child({ component: 'test' }).info('send.ok', { durationMs: 12 });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0].line), {
    ts: '2026-11-17T06:00:00.000Z', level: 'info', event: 'send.ok', messageKey: 'm1', component: 'test', durationMs: 12,
  });
});

test('级别过滤：低于设定级别的不输出；未知级别按 info 处理', () => {
  const { logger, lines } = capture({ level: 'warn' });
  logger.debug('a');
  logger.info('b');
  logger.warn('c');
  logger.error('d');
  assert.deepEqual(lines.map((l) => [l.level, JSON.parse(l.line).event]), [['warn', 'c'], ['error', 'd']]);
  const fallback = capture({ level: 'verbose' });
  fallback.logger.debug('x');
  fallback.logger.info('y');
  assert.deepEqual(fallback.lines.map((l) => JSON.parse(l.line).event), ['y']);
});

test('错误对象只输出消息和诊断字段，不带调用栈；字段不能覆盖固定字段', () => {
  const { logger, lines } = capture();
  logger.error('send.failed', {
    error: new OneBotError('TIMEOUT', '超时', { delivery: 'unknown', action: 'send_group_msg' }),
    event: '伪造', level: 'debug', ts: 'x',
  });
  const record = JSON.parse(lines[0].line);
  assert.equal(record.event, 'send.failed');
  assert.equal(record.level, 'error');
  assert.deepEqual(record.error, { name: 'OneBotError', message: '超时', code: 'TIMEOUT', delivery: 'unknown', action: 'send_group_msg' });
  assert.ok(!lines[0].line.includes('at '));
});

test('pretty 格式：给人看的一行，带中文级别、说明和 key=value', () => {
  const { logger, lines } = capture({ format: 'pretty' });
  logger.warn('onebot.disconnected', { msg: 'OneBot 连接断开', code: 1006, reason: 'a b', error: new Error('网络断了') });
  const { line } = lines[0];
  assert.match(line, /警告 onebot\.disconnected OneBot 连接断开 code=1006 reason="a b" error=网络断了$/);
});

test('写日志出错不影响调用方；无法序列化的字段降级为提示', () => {
  const broken = createLogger({ write: () => { throw new Error('磁盘满了'); } });
  assert.doesNotThrow(() => broken.error('x', { a: 1 }));
  const { logger, lines } = capture();
  logger.info('big', { n: 10n });
  assert.equal(JSON.parse(lines[0].line).logError, '字段无法序列化');
});

test('loggerFromEnv：未指定格式时终端用 pretty，否则 json', () => {
  const tty = loggerFromEnv({ LOG_LEVEL: 'debug' }, { isTTY: true });
  assert.deepEqual([tty.level, tty.format], ['debug', 'pretty']);
  const piped = loggerFromEnv({}, { isTTY: false });
  assert.deepEqual([piped.level, piped.format], ['info', 'json']);
  assert.equal(loggerFromEnv({ LOG_FORMAT: 'json' }, { isTTY: true }).format, 'json');
});
