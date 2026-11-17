import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Fish } from '../src/index.js';
import { loadLegacyData, importLegacyData } from '../src/storage/import-json.js';
import { testDb, closeTestDb } from './helpers.js';

after(closeTestDb);

function legacyDir(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'naiwa-legacy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return dir;
}

const mem = (content, extra = {}) => ({
  id: randomUUID(), ts: 1700000000000, type: 'episodic', content, summary: content,
  tags: [], peers: [], importance: 0.5, access: 'self', meta: {}, ...extra,
});

test('旧数据导入：数量核对一致，可重复执行，导入后可正常使用', async (t) => {
  const dir = legacyDir(t, {
    'memory.json': [mem('第一条旧的情节记忆'), mem('第二条旧的情节记忆', { access: 'public' }), mem('第二条旧的情节记忆', { access: 'public' })],
    'events.json': [{ id: randomUUID(), ts: 1700000000000, platform: 'qq', kind: 'message.received', actor: 'x', target: null, payload: {}, privacy: 'self', meta: {} }],
    'character.json': {
      mood: { valence: 0.5, arousal: 0.2, energy: 0.7 }, interests: [{ topic: '荷叶', weight: 0.6, updatedAt: 1700000000000 }],
      relationships: { 101: { peerId: '101', name: '老朋友', firstSeen: 1700000000000, lastSeen: 1700000001000, interactions: 3, sentiment: 0.2, notes: [] } },
      createdAt: 1690000000000,
    },
  });
  const db = await testDb();
  const tenantId = `import-${randomUUID()}`;
  const data = loadLegacyData(dir);

  const first = await importLegacyData(db, data, { tenantId });
  assert.equal(first.memories.imported, 2);
  assert.equal(first.memories.duplicateContent.length, 1); // 同范围相同正文只留一条
  assert.equal(first.events.imported, 1);
  assert.equal(first.character.state, 'imported');
  assert.equal(first.character.relationships.imported, 1);

  const second = await importLegacyData(db, data, { tenantId });
  assert.equal(second.memories.imported, 0);
  assert.equal(second.memories.alreadyImported, 2);
  assert.equal(second.events.alreadyImported, 1);
  assert.equal(second.character.state, 'kept-existing');

  const fish = await Fish.open({ db, tenantId });
  assert.equal(await fish.memory.count(), 2);
  assert.deepEqual(await fish.character.getMood(), { valence: 0.5, arousal: 0.2, energy: 0.7 });
  assert.equal((await fish.character.getRelationship('101')).interactions, 3);
  assert.equal((await fish.character.state()).createdAt, 1690000000000);
});

test('旧数据损坏或不合法时导入直接失败，不写入任何数据', async (t) => {
  assert.throws(() => loadLegacyData(legacyDir(t, { 'memory.json': '[{"id": ' })), /memory\.json 无法解析/);
  assert.throws(() => loadLegacyData(legacyDir(t, { 'memory.json': [{ ...mem('x'), type: 'nope' }] })), /第 1 条不合法/);
  assert.throws(() => loadLegacyData(legacyDir(t, { 'events.json': { not: 'array' } })), /不是数组/);
});

test('导入中途出错时整体回滚', async (t) => {
  const db = await testDb();
  const tenantId = `import-${randomUUID()}`;
  const good = mem('应该被回滚的记忆内容');
  const bad = mem('导致失败的记忆内容', { importance: 0.5, id: 'not-a-uuid' });
  await assert.rejects(importLegacyData(db, { memories: [good, bad], events: [], character: null, missing: [] }, { tenantId }));
  const fish = await Fish.open({ db, tenantId });
  assert.equal(await fish.memory.count(), 0);
});
