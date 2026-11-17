import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateEvent, validateMemoryRecord, clamp, clamp01 } from '../schema.js';
import { dedupeKey } from '../memory.js';

// 把旧版 JSON 数据目录（memory.json / events.json / character.json）导入 PostgreSQL。
// - 严格读取：文件损坏或记录不合法直接报错，整个导入不生效（一个事务）。
// - 可重复执行：按原 id 插入，已导入的记录跳过，不会重复。
// - 不覆盖：数据库里已有的角色状态、兴趣、关系保持不变，并在报告里列出。
// - 原 JSON 文件只读不改，可作为回滚依据。

function readJson(dir, file, fallback) {
  const path = join(dir, file);
  if (!existsSync(path)) return { value: fallback, missing: true };
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')), missing: false };
  } catch (error) {
    throw new Error(`${file} 无法解析，导入中止：${error.message}`);
  }
}

const ms = (v) => (typeof v === 'number' && Number.isFinite(v) ? new Date(v) : null);

export function loadLegacyData(dir) {
  const memory = readJson(dir, 'memory.json', []);
  const events = readJson(dir, 'events.json', []);
  const character = readJson(dir, 'character.json', null);
  if (!Array.isArray(memory.value)) throw new Error('memory.json 不是数组，导入中止');
  if (!Array.isArray(events.value)) throw new Error('events.json 不是数组，导入中止');
  memory.value.forEach((r, i) => {
    const v = validateMemoryRecord(r);
    if (!v.ok) throw new Error(`memory.json 第 ${i + 1} 条不合法：${v.errors.join('; ')}`);
  });
  events.value.forEach((e, i) => {
    const v = validateEvent(e);
    if (!v.ok) throw new Error(`events.json 第 ${i + 1} 条不合法：${v.errors.join('; ')}`);
  });
  const missing = ['memory.json', 'events.json', 'character.json']
    .filter((f, i) => [memory, events, character][i].missing);
  return { memories: memory.value, events: events.value, character: character.value, missing };
}

export async function importLegacyData(db, data, { tenantId = 'default' } = {}) {
  const report = {
    tenantId,
    missingFiles: data.missing,
    memories: { source: data.memories.length, imported: 0, alreadyImported: 0, duplicateContent: [] },
    events: { source: data.events.length, imported: 0, alreadyImported: 0 },
    character: { state: 'none', interests: { source: 0, imported: 0, kept: 0 }, relationships: { source: 0, imported: 0, kept: 0 } },
  };

  await db.transaction(async (tx) => {
    for (const r of data.memories) {
      const { rows } = await tx.query(
        `INSERT INTO memories (tenant_id, id, ts, type, content, summary, tags, peers, importance, access, meta, dedupe_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT DO NOTHING RETURNING id`,
        [tenantId, r.id, ms(r.ts), r.type, r.content, r.summary ?? r.content, r.tags, r.peers,
          clamp(r.importance, 0, 1), r.access, r.meta ?? {}, dedupeKey(r.content)],
      );
      if (rows.length) { report.memories.imported += 1; continue; }
      const existing = await tx.query('SELECT 1 FROM memories WHERE id = $1', [r.id]);
      if (existing.rows.length) report.memories.alreadyImported += 1;
      else report.memories.duplicateContent.push(r.id); // 同范围内正文相同，按去重规则只保留一条
    }

    for (const e of data.events) {
      const { rows } = await tx.query(
        `INSERT INTO events (tenant_id, id, ts, platform, kind, actor, target, payload, privacy, meta)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [tenantId, e.id, ms(e.ts), e.platform, e.kind, e.actor == null ? null : String(e.actor), e.target ?? null,
          e.payload ?? {}, e.privacy ?? 'self', e.meta ?? {}],
      );
      if (rows.length) report.events.imported += 1;
      else report.events.alreadyImported += 1;
    }

    const ch = data.character;
    if (ch) {
      const { rows } = await tx.query(
        `INSERT INTO character_state (tenant_id, mood, last_tick_at, created_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id) DO NOTHING RETURNING tenant_id`,
        [tenantId, ch.mood ?? {}, ms(ch.lastTickAt), ms(ch.createdAt) ?? new Date()],
      );
      report.character.state = rows.length ? 'imported' : 'kept-existing';

      const interests = Array.isArray(ch.interests) ? ch.interests : [];
      report.character.interests.source = interests.length;
      for (const i of interests) {
        const res = await tx.query(
          `INSERT INTO interests (tenant_id, topic, weight, updated_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING RETURNING topic`,
          [tenantId, i.topic, clamp01(i.weight), ms(i.updatedAt) ?? new Date()],
        );
        report.character.interests[res.rows.length ? 'imported' : 'kept'] += 1;
      }

      const rels = Object.entries(ch.relationships ?? {});
      report.character.relationships.source = rels.length;
      for (const [key, rel] of rels) {
        const firstSeen = ms(rel.firstSeen) ?? ms(rel.lastSeen) ?? new Date();
        const res = await tx.query(
          `INSERT INTO relationships (tenant_id, peer_key, name, first_seen, last_seen, interactions, sentiment, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
           ON CONFLICT DO NOTHING RETURNING peer_key`,
          [tenantId, rel.peerId ?? key, rel.name ?? null, firstSeen, ms(rel.lastSeen) ?? firstSeen,
            Number.isInteger(rel.interactions) ? rel.interactions : 0, clamp(rel.sentiment ?? 0, -1, 1),
            JSON.stringify(Array.isArray(rel.notes) ? rel.notes : [])],
        );
        report.character.relationships[res.rows.length ? 'imported' : 'kept'] += 1;
      }
    }

    // 核对：每条源记录要么在库里，要么是被去重规则合并的重复内容。
    const memIds = data.memories.map((r) => r.id);
    const evIds = data.events.map((e) => e.id);
    const m = await tx.query('SELECT count(*)::int AS n FROM memories WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [tenantId, memIds]);
    const e = await tx.query('SELECT count(*)::int AS n FROM events WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [tenantId, evIds]);
    if (m.rows[0].n + report.memories.duplicateContent.length !== memIds.length) {
      throw new Error(`记忆核对失败：源 ${memIds.length} 条，库中 ${m.rows[0].n} 条，重复 ${report.memories.duplicateContent.length} 条`);
    }
    if (e.rows[0].n !== evIds.length) {
      throw new Error(`事件核对失败：源 ${evIds.length} 条，库中 ${e.rows[0].n} 条（可能有 id 属于其他租户）`);
    }
  });

  return report;
}
