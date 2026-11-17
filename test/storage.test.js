import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Fish, scope, OPERATOR, visibleTo } from '../src/index.js';
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
  test(`[${name}] 重新打开后数据仍在：记忆、兴趣、关系、情绪`, async () => {
    const [a] = await twoProcesses(open);
    await a.remember({ type: 'semantic', content: '用户最喜欢的颜色是绿色', access: 'public' });
    await a.character.growInterest('荷叶', 0.4);
    await a.touch('qq:user:1', { name: '小甲', note: '第一次见面' });
    await a.reactTo({ platform: 'qq', kind: 'message.received', actor: 'x', payload: { sentiment: 'positive' } });
    const moodBefore = await a.character.getMood();

    const reopened = await Fish.open({ db: await open(), tenantId: a.tenantId });
    assert.equal((await reopened.recall({ query: '绿色' })).length, 1);
    assert.deepEqual((await reopened.character.topInterests()).map((i) => i.topic), ['荷叶']);
    const rel = await reopened.character.getRelationship('qq:user:1');
    assert.equal(rel.name, '小甲');
    assert.deepEqual(rel.notes.map((n) => n.text), ['第一次见面']);
    assert.deepEqual(await reopened.character.getMood(), moodBefore);
  });

  test(`[${name}] 两个进程同时写：关系计数不丢、相同记忆只存一条`, async () => {
    const [a, b] = await twoProcesses(open);
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).touch('qq:user:7', { deltaSentiment: 0.01 })));
    const rel = await a.character.getRelationship('qq:user:7');
    assert.equal(rel.interactions, 20);
    assert.ok(Math.abs(rel.sentiment - 0.2) < 1e-9);

    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      (i % 2 ? a : b).remember({ type: 'episodic', content: '两边同时记住的同一件事', access: 'public' })));
    assert.equal(results.filter((r) => r.added).length, 1);
    assert.equal(await a.memory.count(), 1);
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

  test(`[${name}] 另一个进程删掉的记忆，不会被运行中的进程写回`, async () => {
    const [bot, cli] = await twoProcesses(open);
    await bot.remember({ type: 'episodic', content: '要被删掉的那件事情', access: 'public' });
    const [rec] = await cli.memory.export();
    assert.equal((await cli.memory.forget(rec.id)).ok, true);
    await bot.remember({ type: 'episodic', content: '删除之后新发生的事情', access: 'public' });
    const left = (await bot.memory.export()).map((r) => r.content);
    assert.deepEqual(left, ['删除之后新发生的事情']);
  });

  test(`[${name}] 租户之间数据隔离`, async () => {
    const [a] = await twoProcesses(open);
    const [b] = await twoProcesses(open);
    await a.remember({ type: 'semantic', content: '只属于租户甲的公开信息', access: 'public' });
    await a.touch('qq:user:1');
    assert.equal(await b.memory.count(), 0);
    assert.equal((await b.recall({ query: '租户甲' })).length, 0);
    assert.equal((await b.character.getRelationship('qq:user:1')).interactions, 0);
    assert.equal(await b.events.count({ kind: 'memory.added' }), 0);
  });

  test(`[${name}] SQL 可见性与隔离规则一致`, async () => {
    const [f] = await twoProcesses(open);
    const conv = 'qq:account:9:conversation:group:2';
    await f.remember({ type: 'episodic', content: '公开的记忆内容', access: scope.PUBLIC });
    await f.remember({ type: 'episodic', content: '甲的私有记忆内容', access: scope.private('甲'), peers: ['甲'] });
    await f.remember({ type: 'episodic', content: '某个群会话的记忆', access: scope.conversation(conv) });
    await f.remember({ type: 'episodic', content: '群里甲参与的记忆', access: scope.group('g1'), peers: ['甲'] });
    await f.remember({ type: 'episodic', content: '角色自己的记忆哦', access: scope.SELF });
    await f.remember({ type: 'relational', content: '对甲的印象：喜欢鲸鱼', access: scope.person('甲'), peers: ['甲'] });
    const seen = async (requester) => (await f.recall({ requester, limit: 99 })).map((r) => r.content).sort();
    assert.deepEqual(await seen('甲'), ['公开的记忆内容', '甲的私有记忆内容', '群里甲参与的记忆', '对甲的印象：喜欢鲸鱼'].sort());
    assert.deepEqual(await seen('乙'), ['公开的记忆内容']);
    assert.deepEqual(await seen(conv), ['公开的记忆内容', '某个群会话的记忆'].sort());
    // self 不再能看全部：只看自我记忆和公开记忆。运维身份才能看全部。
    assert.deepEqual(await seen('self'), ['公开的记忆内容', '角色自己的记忆哦'].sort());
    assert.equal((await seen(OPERATOR)).length, 6);
    // SQL 的可见性必须与 JS 的 visibleTo 逐条一致。
    const all = await f.memory.export({ requester: OPERATOR });
    for (const requester of ['甲', '乙', conv, 'self', OPERATOR]) {
      assert.deepEqual(await seen(requester), all.filter((r) => visibleTo(r, requester)).map((r) => r.content).sort(), requester);
    }
    const [secret] = all.filter((r) => r.access === scope.private('甲'));
    assert.deepEqual(await f.memory.forget(secret.id, '乙'), { ok: false, reason: 'forbidden' });
    assert.deepEqual(await f.memory.forget('not-a-uuid'), { ok: false, reason: 'not-found' });
  });
}

test('迁移可重复执行；失败的迁移整体回滚', async () => {
  const db = await connectPGlite();
  try {
    // 新增迁移文件时更新这里的列表。
    const all = ['001_init.sql', '002_model_usage.sql', '003_inbound_messages.sql', '004_context.sql', '005_scrub_recall_queries.sql'];
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
