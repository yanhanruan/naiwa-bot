import { clamp, clamp01 } from './schema.js';

const DEFAULT_PERSONA = {
  core: '一只温柔、好奇、有点奶乎乎的小青蛙，喜欢用池塘和荷叶的意象表达情绪。',
  style: '短句为主，偶尔带「呱」「咕呱」等拟声词，爱用波浪线和 emoji。',
  tone: '温暖、俏皮、真诚，不谄媚、不油腻。',
  boundaries: '不编造现实事实；不知道就诚实说不知道；尊重用户隐私；不主动泄露他人信息。',
  interests: [],
};

const DEFAULT_MOOD = { valence: 0.3, arousal: 0.4, energy: 0.6 };
const MOOD_BASELINE = { valence: 0.0, arousal: 0.3, energy: 0.55 };

export function moodLabel({ valence, arousal, energy }) {
  if (valence > 0.35 && arousal > 0.5) return '兴奋';
  if (valence > 0.2) return '开心';
  if (valence < -0.35) return '低落';
  if (valence < -0.15) return '有点闷';
  if (energy < 0.25) return '困困的';
  return '平静';
}

function relationshipFromRow(row) {
  return {
    peerId: row.peer_key,
    name: row.name,
    firstSeen: row.first_seen.getTime(),
    lastSeen: row.last_seen.getTime(),
    interactions: row.interactions,
    sentiment: row.sentiment,
    notes: row.notes,
  };
}

const REL_COLUMNS = 'peer_key, name, first_seen, last_seen, interactions, sentiment, notes';

// 人格引擎（Character Core）：稳定核心性格 + 情绪状态 + 兴趣演化 + 关系认知。
// 人设（persona）来自配置，只在内存；情绪、兴趣、关系存数据库，每次读写都走数据库，
// 状态变化用单条 SQL 或行锁完成，多个进程同时操作不会互相覆盖。
export class CharacterCore {
  constructor({ db, tenantId = 'default', id = 'fish', name = '小渔', persona = {}, moodDecayPerDay = 0.15 }) {
    this.db = db;
    this.tenantId = tenantId;
    this.id = id;
    this.name = name;
    this.persona = { ...DEFAULT_PERSONA, ...persona, interests: [...(persona.interests ?? [])] };
    this.moodDecayPerDay = moodDecayPerDay;
  }

  // 第一次使用时创建角色状态；已存在则保持原样。
  async init() {
    const { rows } = await this.db.query(
      `INSERT INTO character_state (tenant_id, mood, created_at) VALUES ($1, $2, now())
       ON CONFLICT (tenant_id) DO NOTHING RETURNING tenant_id`,
      [this.tenantId, DEFAULT_MOOD],
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

  async _stateRow(q = this.db, { lock = false } = {}) {
    const { rows } = await q.query(
      `SELECT mood, last_tick_at, created_at FROM character_state WHERE tenant_id = $1${lock ? ' FOR UPDATE' : ''}`,
      [this.tenantId],
    );
    if (!rows[0]) throw new Error(`角色状态不存在（tenant=${this.tenantId}），请先调用 init()`);
    return rows[0];
  }

  async getMood() {
    const row = await this._stateRow();
    return { ...DEFAULT_MOOD, ...row.mood };
  }

  // 读-改-写放在一个事务里并锁住该行，避免两个进程同时改情绪时丢失其中一次。
  async _updateMood(fn) {
    return this.db.transaction(async (tx) => {
      const row = await this._stateRow(tx, { lock: true });
      const mood = { ...DEFAULT_MOOD, ...row.mood };
      const lastTickAt = row.last_tick_at ? row.last_tick_at.getTime() : null;
      const next = fn(mood, lastTickAt);
      if (!next) return mood;
      await tx.query(
        'UPDATE character_state SET mood = $2, last_tick_at = COALESCE($3, last_tick_at) WHERE tenant_id = $1',
        [this.tenantId, next.mood, next.lastTickAt ? new Date(next.lastTickAt) : null],
      );
      return next.mood;
    });
  }

  // 感知统一事件 -> 轻微情绪变化（规则驱动，可解释、可测试）。
  perceive(event) {
    const { kind, payload = {} } = event;
    let dv = 0;
    let da = 0;
    if (kind === 'message.received') {
      da += 0.05;
      if (payload.sentiment === 'positive') dv += 0.08;
      if (payload.sentiment === 'negative') dv -= 0.08;
      if (payload.mentionsSelf) dv += 0.03;
    }
    if (kind === 'approval.granted') dv += 0.05;
    if (kind === 'approval.denied') dv -= 0.05;
    if (kind === 'proactive.action') { dv += 0.03; da += 0.03; }
    return this._updateMood((mood) => ({
      mood: { ...mood, valence: clamp(mood.valence + dv, -1, 1), arousal: clamp01(mood.arousal + da) },
    }));
  }

  // 情绪随自然时间向基线回落（单调、可预测）。
  moodTick(now = Date.now()) {
    return this._updateMood((mood, lastTickAt) => {
      const last = lastTickAt ?? now;
      const days = (now - last) / 86400000;
      if (lastTickAt !== null && days <= 0) return null;
      const decay = this.moodDecayPerDay * Math.min(Math.max(days, 0), 7);
      const toward = (k) => mood[k] * (1 - decay) + MOOD_BASELINE[k] * decay;
      return { mood: { valence: toward('valence'), arousal: toward('arousal'), energy: toward('energy') }, lastTickAt: now };
    });
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
    return { peerId, name: null, firstSeen: null, lastSeen: null, interactions: 0, sentiment: 0, notes: [] };
  }

  // 单条 upsert：互动次数 +1、好感度累加并限制在 [-1, 1]。两个进程同时 touch 也不会少算。
  async touchRelationship(peerId, { name = null, deltaSentiment = 0, note = null } = {}) {
    const notes = note ? [{ ts: Date.now(), text: note }] : [];
    const { rows } = await this.db.query(
      `INSERT INTO relationships AS r (tenant_id, peer_key, name, first_seen, last_seen, interactions, sentiment, notes)
       VALUES ($1, $2, $3, now(), now(), 1, LEAST(1, GREATEST(-1, $4::double precision)), $5::jsonb)
       ON CONFLICT (tenant_id, peer_key) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, r.name),
         last_seen = now(),
         interactions = r.interactions + 1,
         sentiment = LEAST(1, GREATEST(-1, r.sentiment + $4::double precision)),
         notes = r.notes || $5::jsonb
       RETURNING ${REL_COLUMNS}`,
      [this.tenantId, peerId, name, deltaSentiment || 0, JSON.stringify(notes)],
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

  async moodLabel() {
    return moodLabel(await this.getMood());
  }

  async state() {
    const row = await this._stateRow();
    const mood = { ...DEFAULT_MOOD, ...row.mood };
    return {
      id: this.id,
      name: this.name,
      mood: { ...mood, label: moodLabel(mood) },
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
