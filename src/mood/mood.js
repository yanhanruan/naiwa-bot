// 奶蛙的心情（Module 8，见 docs/module-08-mood-design.md）。
// - 一条心情线，5 档：-2 很低落、-1 有点低落、0 平常、1 开心、2 很开心。基调和起伏都在这条线上。
// - 每天北京时间早上 5 点按权重抽一档当基调，用“租户 + 日期”当种子：重启后同一天还是同一档；负面的不连着两天。
// - 日内起伏：模型说“这一轮有人让你高兴 / 难受”，起伏往那边挪一步，攒够了换一档；最多离基调一档，每 2 小时往基调回一半，第二天清零。
//   防刷：同一个人一小时只算一次，同一个会话一小时最多算几次。这两个计数只在内存里，不落库，不记谁让它高兴或难受。
// - 只有一份（每个租户一行，表 mood_state），不按群、不按人存。
import { createHash } from 'node:crypto';

const HOUR_MS = 3_600_000;

export const MOOD_LEVELS = [
  { value: -2, name: '很低落', weight: 3 },
  { value: -1, name: '有点低落', weight: 10 },
  { value: 0, name: '平常', weight: 55 },
  { value: 1, name: '开心', weight: 25 },
  { value: 2, name: '很开心', weight: 7 },
];

export const MOOD_DEFAULTS = {
  step: 0.25, // 一次挪多少
  // 起伏到这么多就换一档（最多一档）。比两次（0.5）小一点：两次挪过去能停四十分钟左右，挪满（1）能停两个半小时左右，
  // 正好等于 0.5 的话，往回减一点点就掉回来了。
  shiftAt: 0.4,
  halfLifeMs: 2 * HOUR_MS, // 每过这么久，离基调的距离减半
  personWindowMs: HOUR_MS, // 同一个人这段时间里只算一次
  conversationWindowMs: HOUR_MS,
  conversationMax: 3, // 同一个会话这段时间里最多算几次
  dayStartHour: 5, // 北京时间几点换天
};

export const moodName = (value) => MOOD_LEVELS.find((l) => l.value === value)?.name;
export const moodValue = (name) => MOOD_LEVELS.find((l) => l.name === name)?.value;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// 某个时刻算哪一天：北京时间早上 dayStartHour 点换天。返回 'YYYY-MM-DD'。
export function moodDay(ms, dayStartHour = MOOD_DEFAULTS.dayStartHour) {
  return new Date(ms + (8 - dayStartHour) * HOUR_MS).toISOString().slice(0, 10);
}

// 按权重抽今天的基调。同一租户同一天结果固定；昨天是负面的，今天只在不负面的里抽。
export function drawBase({ tenantId, day, previousBase = null }) {
  const pool = previousBase !== null && previousBase < 0 ? MOOD_LEVELS.filter((l) => l.value >= 0) : MOOD_LEVELS;
  const total = pool.reduce((sum, l) => sum + l.weight, 0);
  const seed = createHash('sha256').update(`${tenantId}\u001f${day}`).digest().readUInt32BE(0) / 2 ** 32;
  let target = seed * total;
  for (const level of pool) {
    target -= level.weight;
    if (target < 0) return level.value;
  }
  return pool.at(-1).value;
}

export class Mood {
  /**
   * @param {object} opts
   * @param {object} opts.db 见 src/storage
   * @param {() => number} [opts.now] 毫秒时间戳，测试用
   * 其余见 MOOD_DEFAULTS。
   */
  constructor({ db, tenantId = 'default', now = () => Date.now(), ...options } = {}) {
    if (!db) throw new Error('Mood 需要 db（见 src/storage 的 openStorage）');
    this.db = db;
    this.tenantId = tenantId;
    this.now = now;
    const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
    this.options = { ...MOOD_DEFAULTS, ...given };
    this.personSeen = new Map(); // 人 -> 上一次算数的时间
    this.conversationSeen = new Map(); // 会话 -> 这段时间里算数的时间
  }

  /**
   * 现在的心情。今天第一次读时抽今天的基调（drawn 为 true）。
   * @returns {Promise<{day: string, base: number, ripple: number, level: number, manual: boolean, drawn: boolean}>}
   */
  async current() {
    return this.db.transaction((tx) => this._today(tx));
  }

  /**
   * 这一轮有人让它高兴（+1）或难受（-1）。超过上限的不算（counted 为 false，reason 说是哪个上限）。
   * @param {1|-1} direction
   * @param {{personKey: string, conversationKey: string}} who
   */
  async nudge(direction, { personKey, conversationKey }) {
    const now = this.now();
    const blocked = this._blocked(personKey, conversationKey, now);
    if (blocked) return { counted: false, reason: blocked, ...(await this.current()) };
    this._remember(personKey, conversationKey, now);
    return this.db.transaction(async (tx) => {
      const state = await this._today(tx);
      const ripple = clamp(state.ripple + Math.sign(direction) * this.options.step, -1, 1);
      await tx.query('UPDATE mood_state SET ripple = $2, ripple_at = $3 WHERE tenant_id = $1',
        [this.tenantId, ripple, new Date(now)]);
      return { counted: true, ...this._view(state, ripple) };
    });
  }

  // 运营用命令改今天的基调（起伏不动）。
  async set(name) {
    const value = moodValue(name);
    if (value === undefined) throw new Error(`没有这一档心情：${name}（可选：${MOOD_LEVELS.map((l) => l.name).join('、')}）`);
    return this.db.transaction(async (tx) => {
      const state = await this._today(tx);
      await tx.query('UPDATE mood_state SET base = $2, manual = true WHERE tenant_id = $1', [this.tenantId, value]);
      return this._view({ ...state, base: value, manual: true }, state.ripple);
    });
  }

  // 在事务里取今天这一行：没有就建，过了换天时间就换一天（起伏清零）。返回的 ripple 已经按时间往回减过。
  async _today(tx) {
    const now = this.now();
    const day = moodDay(now, this.options.dayStartHour);
    let row = await this._lockRow(tx);
    let created = false;
    if (!row) {
      // 第一次用：建一行。别的进程同时建了就用它的，不覆盖（覆盖会把它刚挪的起伏清掉）。
      const inserted = await tx.query(
        `INSERT INTO mood_state (tenant_id, day, base, ripple_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id) DO NOTHING RETURNING tenant_id`,
        [this.tenantId, day, drawBase({ tenantId: this.tenantId, day }), new Date(now)],
      );
      created = inserted.rows.length > 0;
      row = await this._lockRow(tx);
    }
    if (row.day === day) {
      const elapsed = Math.max(0, now - row.ripple_at.getTime());
      const ripple = row.ripple * 0.5 ** (elapsed / this.options.halfLifeMs);
      return { ...this._view({ day, base: row.base, manual: row.manual }, ripple), drawn: created };
    }
    // 换天了（这一行已经锁住）：重新抽，起伏清零。
    const base = drawBase({ tenantId: this.tenantId, day, previousBase: row.base });
    await tx.query(
      `UPDATE mood_state SET day = $2, base = $3, manual = false, previous_base = $4, ripple = 0, ripple_at = $5
        WHERE tenant_id = $1`,
      [this.tenantId, day, base, row.base, new Date(now)],
    );
    return { ...this._view({ day, base, manual: false }, 0), drawn: true };
  }

  async _lockRow(tx) {
    const { rows } = await tx.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, base, manual, ripple, ripple_at
         FROM mood_state WHERE tenant_id = $1 FOR UPDATE`,
      [this.tenantId],
    );
    return rows[0];
  }

  _view({ day, base, manual }, ripple) {
    const shift = Math.abs(ripple) >= this.options.shiftAt ? Math.sign(ripple) : 0;
    return { day, base, manual, ripple, level: clamp(base + shift, -2, 2) };
  }

  _blocked(personKey, conversationKey, now) {
    const last = this.personSeen.get(personKey);
    if (last !== undefined && now - last < this.options.personWindowMs) return 'person';
    const recent = (this.conversationSeen.get(conversationKey) ?? []).filter((at) => now - at < this.options.conversationWindowMs);
    if (recent.length >= this.options.conversationMax) return 'conversation';
    return null;
  }

  _remember(personKey, conversationKey, now) {
    this.personSeen.set(personKey, now);
    const recent = (this.conversationSeen.get(conversationKey) ?? []).filter((at) => now - at < this.options.conversationWindowMs);
    this.conversationSeen.set(conversationKey, [...recent, now]);
    if (this.personSeen.size + this.conversationSeen.size < 10_000) return;
    for (const [key, at] of this.personSeen) if (now - at >= this.options.personWindowMs) this.personSeen.delete(key);
    for (const [key, list] of this.conversationSeen) {
      if (!list.some((at) => now - at < this.options.conversationWindowMs)) this.conversationSeen.delete(key);
    }
  }
}
