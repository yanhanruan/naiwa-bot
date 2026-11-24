import { clamp01 } from './schema.js';

const DEFAULT_PERSONA = {
  core: '一只温柔、好奇、有点奶乎乎的小青蛙，喜欢用池塘和荷叶的意象表达情绪。',
  style: '短句为主，偶尔带「呱」「咕呱」等拟声词，爱用波浪线和 emoji。',
  tone: '温暖、俏皮、真诚，不谄媚、不油腻。',
  boundaries: '不编造现实事实；不知道就诚实说不知道；尊重用户隐私；不主动泄露他人信息。',
  interests: [],
};

function relationshipFromRow(row) {
  return {
    peerId: row.peer_key,
    name: row.name,
    firstSeen: row.first_seen.getTime(),
    lastSeen: row.last_seen.getTime(),
    interactions: row.interactions,
    groupInteractions: row.group_interactions,
    groupFirstSeen: row.group_first_seen ? row.group_first_seen.getTime() : null,
  };
}

const REL_COLUMNS = 'peer_key, name, first_seen, last_seen, interactions, group_interactions, group_first_seen';

// 人格引擎（Character Core）：稳定核心性格 + 兴趣演化 + 关系认知。心情在 src/mood/（Module 8）。
// 人设（persona）来自配置，只在内存；兴趣、关系存数据库，每次读写都走数据库，
// 状态变化用单条 SQL 或行锁完成，多个进程同时操作不会互相覆盖。
// 关系记录会被 forget-person 删除，写入走 writer（持锁连接，见 src/storage/run-lock.js）；其余走 db。
export class CharacterCore {
  constructor({ db, writer = db, tenantId = 'default', id = 'fish', name = '奶蛙', persona = {} }) {
    this.db = db;
    this.writer = writer;
    this.tenantId = tenantId;
    this.id = id;
    this.name = name;
    this.persona = { ...DEFAULT_PERSONA, ...persona, interests: [...(persona.interests ?? [])] };
  }

  // 第一次使用时创建角色状态；已存在则保持原样。
  async init() {
    const { rows } = await this.db.query(
      `INSERT INTO character_state (tenant_id, created_at) VALUES ($1, now())
       ON CONFLICT (tenant_id) DO NOTHING RETURNING tenant_id`,
      [this.tenantId],
    );
    if (rows.length) {
      for (const i of this.persona.interests) {
        const topic = typeof i === 'string' ? i : i.topic;
        const weight = typeof i === 'string' ? 0.5 : clamp01(i.weight);
        await this.db.query(
          `INSERT INTO interests (tenant_id, topic, weight, updated_at) VALUES ($1, $2, $3, now())
           ON CONFLICT DO NOTHING`,
          [this.tenantId, topic, weight],
        );
      }
    }
    return this;
  }

  async _stateRow() {
    const { rows } = await this.db.query(
      'SELECT created_at FROM character_state WHERE tenant_id = $1',
      [this.tenantId],
    );
    if (!rows[0]) throw new Error(`角色状态不存在（tenant=${this.tenantId}），请先调用 init()`);
    return rows[0];
  }

  // 兴趣：增长/衰减，weight 归一化在 [0,1]。单条 SQL 完成，并发安全。
  async growInterest(topic, delta = 0.1) {
    const { rows } = await this.db.query(
      `INSERT INTO interests AS i (tenant_id, topic, weight, updated_at)
       VALUES ($1, $2, LEAST(1, GREATEST(0, 0.3 + $3::double precision)), now())
       ON CONFLICT (tenant_id, topic) DO UPDATE
         SET weight = LEAST(1, GREATEST(0, i.weight + $3::double precision)), updated_at = now()
       RETURNING topic, weight, updated_at`,
      [this.tenantId, topic, delta],
    );
    const r = rows[0];
    return { topic: r.topic, weight: r.weight, updatedAt: r.updated_at.getTime() };
  }

  async topInterests(n = 5) {
    const { rows } = await this.db.query(
      `SELECT topic, weight, updated_at FROM interests WHERE tenant_id = $1 ORDER BY weight DESC, topic LIMIT $2`,
      [this.tenantId, n],
    );
    return rows.map((r) => ({ topic: r.topic, weight: r.weight, updatedAt: r.updated_at.getTime() }));
  }

  async getRelationship(peerId) {
    const { rows } = await this.db.query(
      `SELECT ${REL_COLUMNS} FROM relationships WHERE tenant_id = $1 AND peer_key = $2`,
      [this.tenantId, peerId],
    );
    if (rows[0]) return relationshipFromRow(rows[0]);
    return {
      peerId, name: null, firstSeen: null, lastSeen: null, interactions: 0, groupInteractions: 0, groupFirstSeen: null,
    };
  }

  // 单条 upsert：互动次数 +1。两个进程同时 touch 也不会少算。
  // inGroup：这次互动发生在群里，群聊计数也 +1（群里的熟悉程度只看它，见 src/context/impressions.js）。
  async touchRelationship(peerId, { name = null, inGroup = false } = {}) {
    const { rows } = await this.writer.query(
      `INSERT INTO relationships AS r (tenant_id, peer_key, name, first_seen, last_seen, interactions,
         group_interactions, group_first_seen)
       VALUES ($1, $2, $3, now(), now(), 1, CASE WHEN $4::boolean THEN 1 ELSE 0 END, CASE WHEN $4::boolean THEN now() END)
       ON CONFLICT (tenant_id, peer_key) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, r.name),
         last_seen = now(),
         interactions = r.interactions + 1,
         group_interactions = r.group_interactions + EXCLUDED.group_interactions,
         group_first_seen = COALESCE(r.group_first_seen, EXCLUDED.group_first_seen)
       RETURNING ${REL_COLUMNS}`,
      [this.tenantId, peerId, name, inGroup],
    );
    return relationshipFromRow(rows[0]);
  }

  async relationships() {
    const { rows } = await this.db.query(
      `SELECT ${REL_COLUMNS} FROM relationships WHERE tenant_id = $1 ORDER BY first_seen, peer_key`,
      [this.tenantId],
    );
    return rows.map(relationshipFromRow);
  }

  async state() {
    const row = await this._stateRow();
    return {
      id: this.id,
      name: this.name,
      interests: await this.topInterests(10),
      relationships: await this.relationships(),
      persona: {
        core: this.persona.core,
        style: this.persona.style,
        tone: this.persona.tone,
        boundaries: this.persona.boundaries,
      },
      createdAt: row.created_at.getTime(),
    };
  }
}
