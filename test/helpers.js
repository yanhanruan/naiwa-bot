import { randomUUID } from 'node:crypto';
import { Fish } from '../src/index.js';
import { openTestStorage } from '../src/storage/index.js';

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
