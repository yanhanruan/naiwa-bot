import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fish } from '../src/index.js';
import { PersonAliases } from '../src/context/aliases.js';
import { ConversationHistory } from '../src/context/history.js';
import { PersonImpressions } from '../src/context/impressions.js';
import { connectPGlite, migrate, openStorage } from '../src/storage/index.js';
import { testDb, closeTestDb } from './helpers.js';

// 默认在 PGlite 上测；设置 TEST_DATABASE_URL 时也在真实 PostgreSQL 上测（有真正的并发）。
const backends = [{ name: 'PGlite', open: testDb }];
if (process.env.TEST_DATABASE_URL) {
  let pg = null;
  backends.push({ name: 'PostgreSQL', open: () => (pg ??= openStorage({ databaseUrl: process.env.TEST_DATABASE_URL })) });
  after(async () => { if (pg) await (await pg).close(); });
}
after(closeTestDb);

const tenant = () => `test-${randomUUID()}`;
const GROUP_A = 'qq:account:900:conversation:group:200';
const GROUP_B = 'qq:account:900:conversation:group:201';
const PRIVATE = 'qq:account:900:conversation:private:101';

for (const { name, open } of backends) {
  test(`[${name}] 全局代号：按第一次出现的顺序分配；“重启”后不变；租户之间独立`, async () => {
    const db = await open();
    const tenantId = tenant();
    const aliases = new PersonAliases({ db, tenantId });
    assert.deepEqual([...await aliases.resolve(['甲', '乙', '甲'])], [['甲', 'u1'], ['乙', 'u2']]);
    assert.deepEqual([...await aliases.resolve(['丙', '甲'])], [['丙', 'u3'], ['甲', 'u1']]);
    const restarted = new PersonAliases({ db, tenantId }); // 新进程：没有缓存，从数据库读
    assert.deepEqual([...await restarted.resolve(['乙', '丙', '丁'])], [['乙', 'u2'], ['丙', 'u3'], ['丁', 'u4']]);
    assert.deepEqual([...await new PersonAliases({ db, tenantId: tenant() }).resolve(['丁'])], [['丁', 'u1']]);
  });

  test(`[${name}] 全局代号：两个进程同时给同一批人分配，也不会重号或一人两号`, async () => {
    const db = await open();
    const tenantId = tenant();
    const people = Array.from({ length: 8 }, (_, i) => `p${i}`);
    const results = await Promise.all([0, 1, 2].map(() => new PersonAliases({ db, tenantId }).resolve(people)));
    for (const result of results) assert.deepEqual([...result], [...results[0]]);
    assert.equal(new Set(results[0].values()).size, people.length);
  });

  test(`[${name}] 短期历史：按顺序取最近几条；超过 24 小时的不当上文；7 天前的被清理；会话之间隔离`, async () => {
    const db = await open();
    const tenantId = tenant();
    const history = new ConversationHistory({ db, tenantId, maxEntries: 4 });
    for (let i = 1; i <= 3; i += 1) {
      await history.append(GROUP_A, [{ role: 'user', content: `问${i}` }, { role: 'assistant', content: `答${i}` }], { messageKey: `m${i}` });
    }
    await history.append(GROUP_B, [{ role: 'user', content: '别的群' }, { role: 'assistant', content: '别的回复' }]);
    assert.deepEqual((await history.recent(GROUP_A)).map((t) => t.content), ['问2', '答2', '问3', '答3']);
    assert.deepEqual((await history.recent(PRIVATE)), []);

    // 把第 3 轮改成 25 小时前：不再当上文；第 1 轮改成 8 天前：会被清理
    await db.query(`UPDATE conversation_turns SET created_at = now() - interval '25 hours' WHERE tenant_id = $1 AND message_key = 'm3'`, [tenantId]);
    await db.query(`UPDATE conversation_turns SET created_at = now() - interval '8 days' WHERE tenant_id = $1 AND message_key = 'm1'`, [tenantId]);
    assert.deepEqual((await history.recent(GROUP_A)).map((t) => t.content), ['问2', '答2']);
    assert.equal(await history.prune(), 2);
    assert.equal(await new ConversationHistory({ db, tenantId: tenant() }).prune(), 0);
  });

  test(`[${name}] 规则印象：群里只按群聊互动算，各群一致；私聊用全部互动；印象里没有任何聊天内容`, async () => {
    const db = await open();
    const fish = await Fish.open({ db, tenantId: tenant() });
    const impressions = new PersonImpressions({ db, tenantId: fish.tenantId });
    const person = 'qq:user:101';
    const now = new Date();

    const stranger = await impressions.describe(person, { alias: 'u1', inGroup: true, now });
    assert.equal(stranger, '代号 u1。\n这是你们第一次在群里说话。');

    // 私聊里聊了 3 次：只私聊过的人，在群里的印象和陌生人完全一样，看不出私下跟奶蛙说过话
    for (let i = 0; i < 3; i += 1) await fish.touch(person, { name: '小甲' });
    assert.equal(await impressions.describe(person, { alias: 'u1', inGroup: true, now }), stranger);

    // 群里 2 次（两个群合计）
    for (let i = 0; i < 2; i += 1) await fish.touch(person, { name: '小甲', inGroup: true });
    const inGroup = await impressions.describe(person, { alias: 'u1', nickname: '小甲', inGroup: true, now });
    assert.equal(inGroup, '代号 u1，QQ 昵称「小甲」。\n你们在群里聊过 2 次，最早一次是今天。');
    const inPrivate = await impressions.describe(person, { alias: 'u1', nickname: '小甲', inGroup: false, now });
    assert.equal(inPrivate, '代号 u1，QQ 昵称「小甲」。\n你们聊过 5 次，最早一次是今天。');
  });
}

test('迁移 005：抹掉历史检索事件里的查询原文，只留字数；其他事件不动', async () => {
  const migrations = fileURLToPath(new URL('../migrations/', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'naiwa-m005-'));
  const db = await connectPGlite();
  try {
    for (const file of readdirSync(migrations).filter((f) => f < '005')) cpSync(join(migrations, file), join(dir, file));
    await migrate(db, { dir });
    const insert = (kind, payload) => db.query(
      `INSERT INTO events (id, tenant_id, ts, platform, kind, payload, privacy) VALUES ($1, 't', now(), 'fish-os', $2, $3, 'self')`,
      [randomUUID(), kind, payload],
    );
    await insert('memory.retrieved', { query: '我的暗号是红色鲸鱼', requester: 'conv', count: 2 });
    await insert('memory.retrieved', { queryChars: 3, requester: 'conv', count: 0 }); // 新写法，不受影响
    await insert('memory.added', { query: '不是检索事件，不动' });
    cpSync(join(migrations, '005_scrub_recall_queries.sql'), join(dir, '005_scrub_recall_queries.sql'));
    assert.deepEqual(await migrate(db, { dir }), ['005_scrub_recall_queries.sql']);
    const { rows } = await db.query('SELECT kind, payload FROM events ORDER BY kind, payload::text');
    assert.deepEqual(rows.map((r) => r.payload), [
      { query: '不是检索事件，不动' },
      { queryChars: 3, requester: 'conv', count: 0 },
      { queryChars: 9, requester: 'conv', count: 2 },
    ]);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
