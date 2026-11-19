import { randomUUID } from 'node:crypto';
import { Fish } from '../src/index.js';
import { openTestStorage } from '../src/storage/index.js';
import { createLogger } from '../src/log.js';

// 每个测试文件共用一个进程内 PostgreSQL（PGlite），每条鱼用独立租户，测试之间互不影响。
let dbPromise = null;

export function testDb() {
  dbPromise ??= openTestStorage();
  return dbPromise;
}

export async function closeTestDb() {
  if (dbPromise) await (await dbPromise).close();
  dbPromise = null;
}

export async function openFish({ tenantId = `test-${randomUUID()}`, ...opts } = {}) {
  const db = await testDb();
  return (await Fish.open({ db, tenantId, ...opts })).start();
}

// 多数入口测试不关心群里什么时候说话：群里每条消息都按“一定回”处理。Module 7 的规则另有测试（test/group-chat.test.js）。
export function replyToEveryone() {
  return { classify: () => ({ action: 'reply', reason: 'test' }), isIgnored: () => false, noteCalled() {}, noteSent() {} };
}

// 轮询等待某个条件成立（每 5 毫秒查一次），超时抛错。
export async function waitFor(check, { timeoutMs = 3000, what = '条件满足' } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`等待超时：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// 把日志收集到数组里，供断言使用：entries 是每行日志的结构化记录，lines 是实际输出的文本。
export function captureLogger({ level = 'debug', format = 'json' } = {}) {
  const entries = [];
  const lines = [];
  const logger = createLogger({ level, format, write: (line, _level, record) => { lines.push(line); entries.push(record); } });
  return { logger, entries, lines, find: (event) => entries.filter((e) => e.event === event) };
}
