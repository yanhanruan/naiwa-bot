import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Fish } from '../src/index.js';
import { connectPGlite, migrate, openStorage } from '../src/storage/index.js';
import { testDb, closeTestDb } from './helpers.js';

// 默认在 PGlite 上跑。设置 TEST_DATABASE_URL 时，同一批测试也在真实 PostgreSQL 上跑，
// 那里有真正的多连接并发，用来验证“多个进程同时写不互相覆盖”。
const backends = [{ name: 'PGlite', open: testDb }];
if (process.env.TEST_DATABASE_URL) {
  let pg = null;
  backends.push({ name: 'PostgreSQL', open: () => (pg ??= openStorage({ databaseUrl: process.env.TEST_DATABASE_URL })) });
  after(async () => { if (pg) await (await pg).close(); });
}
after(closeTestDb);

// 同一租户的两个 Fish 实例，模拟同时运行的两个进程（例如机器人和 CLI）。
async function twoProcesses(open) {
  const db = await open();
  const tenantId = `test-${randomUUID()}`;
  return [await Fish.open({ db, tenantId }), await Fish.open({ db, tenantId })];
}

for (const { name, open } of backends) {
  test(`[${name}] 重新打开后数据仍在：兴趣、关系、情绪`, async () => {
    const [a] = await twoProcesses(open);
    await a.character.growInterest('荷叶', 0.4);
    await a.touch('qq:user:1', { name: '小甲', note: '第一次见面' });
    await a.reactTo({ platform: 'qq', kind: 'message.received', actor: 'x', payload: { sentiment: 'positive' } });
    const moodBefore = await a.character.getMood();

    const reopened = await Fish.open({ db: await open(), tenantId: a.tenantId });
    assert.deepEqual((await reopened.character.topInterests()).map((i) => i.topic), ['荷叶']);
    const rel = await reopened.character.getRelationship('qq:user:1');
    assert.equal(rel.name, '小甲');
    assert.deepEqual(rel.notes.map((n) => n.text), ['第一次见面']);
    assert.deepEqual(await reopened.character.getMood(), moodBefore);
  });

  test(`[${name}] 两个进程同时写：关系计数不丢`, async () => {
    const [a, b] = await twoProcesses(open);
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).touch('qq:user:7', { deltaSentiment: 0.01 })));
    const rel = await a.character.getRelationship('qq:user:7');
    assert.equal(rel.interactions, 20);
    assert.ok(Math.abs(rel.sentiment - 0.2) < 1e-9);
  });

  test(`[${name}] 两个进程同时改情绪：每次变化都生效`, async () => {
    const [a, b] = await twoProcesses(open);
    const start = await a.character.getMood();
    const ev = { kind: 'message.received', payload: { sentiment: 'positive' } };
    await Promise.all(Array.from({ length: 4 }, (_, i) => (i % 2 ? a : b).character.perceive(ev)));
    const mood = await a.character.getMood();
    assert.ok(Math.abs(mood.valence - (start.valence + 4 * 0.08)) < 1e-9);
    assert.ok(Math.abs(mood.arousal - (start.arousal + 4 * 0.05)) < 1e-9);
  });

  test(`[${name}] 租户之间数据隔离`, async () => {
    const [a] = await twoProcesses(open);
    const [b] = await twoProcesses(open);
    await a.touch('qq:user:1');
    assert.equal((await b.character.getRelationship('qq:user:1')).interactions, 0);
    assert.equal(await b.events.count({ kind: 'relationship.touched' }), 0);
  });
}

test('迁移可重复执行；失败的迁移整体回滚', async () => {
  const db = await connectPGlite();
  try {
    // 新增迁移文件时更新这里的列表。
    const all = ['001_init.sql', '002_model_usage.sql', '003_inbound_messages.sql', '004_context.sql', '005_scrub_recall_queries.sql',
      '006_memory_v2.sql'];
    assert.deepEqual(await migrate(db), all);
    assert.deepEqual(await migrate(db), []);

    const dir = mkdtempSync(join(tmpdir(), 'naiwa-migrations-'));
    try {
      writeFileSync(join(dir, '001_init.sql'), 'SELECT 1;');
      writeFileSync(join(dir, '002_ok.sql'), 'CREATE TABLE half_done (x int);');
      writeFileSync(join(dir, '003_broken.sql'), 'THIS IS NOT SQL;');
      await assert.rejects(migrate(db, { dir }), /003_broken\.sql/);
      const { rows } = await db.query("SELECT to_regclass('half_done') AS t");
      assert.equal(rows[0].t, null);
      const versions = await db.query('SELECT version FROM schema_migrations ORDER BY version');
      assert.deepEqual(versions.rows.map((r) => r.version), all);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await db.close();
  }
});

test('连不上数据库时直接报错，不以空数据启动', async () => {
  await assert.rejects(openStorage({ databaseUrl: '' }), /DATABASE_URL/);
  await assert.rejects(openStorage({ databaseUrl: 'postgres://nobody:wrong@127.0.0.1:1/none' }));
});
