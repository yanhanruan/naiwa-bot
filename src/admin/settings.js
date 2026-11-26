// 设置（Module 9，见 docs/module-09-admin-design.md）：存在数据库的 bot_settings 表里，用 fish 命令改。
// - 奶蛙每 5 秒 refresh() 一次（见 src/admin/status.js），平时只读内存里的值，不花时间；
// - 命令直接写数据库；没有这一行就用默认值；
// - 读失败时 refresh() 抛错，内存里还是上一次的值，不会悄悄回到默认值。
import { entityKey } from '../identity.js';
import { placeOf } from '../memory/place.js';

// 每个群一个开关，三档。
export const GROUP_MODES = { on: '说话', at: '只回 @', off: '不说话' };

export const SETTING_DEFAULTS = {
  dailyBudgetCny: 20, // 每日花费上限（元，估算）；0 表示不限
  groupDefault: 'on', // 没单独设置的群
};

const KEYS = { budget: 'daily_budget_cny', ignore: 'ignore_qq', groupDefault: 'group_default' };
const GROUP_PREFIX = 'group:';
const QQ_NUMBER = /^\d{1,20}$/;

export class SettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SettingsError';
  }
}

const isMode = (value) => Object.hasOwn(GROUP_MODES, value);
const isBudget = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// 群号 → 群的地方 key（qq:group:200）。
function groupPlace(groupId) {
  if (!QQ_NUMBER.test(String(groupId))) throw new SettingsError('群号只能是数字');
  return entityKey('qq', 'group', String(groupId));
}

function checkQQ(qq) {
  if (!QQ_NUMBER.test(String(qq))) throw new SettingsError('QQ 号只能是数字');
  return String(qq);
}

/**
 * 把数据库里的几行读成设置。值不对的行（例如有人手改了数据库）按默认值，记在 problems 里。
 * @param {Array<{key: string, value: any, updated_at: Date}>} rows
 */
export function parseSettings(rows = []) {
  const values = {
    dailyBudgetCny: SETTING_DEFAULTS.dailyBudgetCny,
    budgetSetAt: null, // null 表示用的是默认值
    groupDefault: SETTING_DEFAULTS.groupDefault,
    groupDefaultSetAt: null,
    groups: new Map(), // 群的地方 key -> { mode, updatedAt }
    ignoreQQ: [],
    problems: [],
  };
  for (const row of rows) {
    const { key, value } = row;
    if (key === KEYS.budget) {
      if (isBudget(value)) Object.assign(values, { dailyBudgetCny: value, budgetSetAt: row.updated_at });
      else values.problems.push(key);
    } else if (key === KEYS.groupDefault) {
      if (isMode(value)) Object.assign(values, { groupDefault: value, groupDefaultSetAt: row.updated_at });
      else values.problems.push(key);
    } else if (key === KEYS.ignore) {
      if (Array.isArray(value) && value.every((qq) => typeof qq === 'string' && QQ_NUMBER.test(qq))) values.ignoreQQ = [...value];
      else values.problems.push(key);
    } else if (key.startsWith(GROUP_PREFIX)) {
      if (isMode(value)) values.groups.set(key.slice(GROUP_PREFIX.length), { mode: value, updatedAt: row.updated_at });
      else values.problems.push(key);
    } else {
      values.problems.push(key);
    }
  }
  values.ignoredKeys = new Set(values.ignoreQQ.map((qq) => entityKey('qq', 'user', qq)));
  return values;
}

export class Settings {
  /**
   * @param {object} opts
   * @param {object} opts.db 见 src/storage
   * @param {string} [opts.tenantId]
   */
  constructor({ db, tenantId = 'default' } = {}) {
    if (!db) throw new Error('Settings 需要 db（见 src/storage 的 openStorage）');
    this.db = db;
    this.tenantId = tenantId;
    this.values = parseSettings();
    this.readAt = null; // 最后一次读到设置的时间（数据库时钟）；null 表示还没读过
  }

  // 从数据库重新读一遍。失败时抛错，内存里的值不变。
  async refresh() {
    // 一条语句读：读到的设置和读的时间是同一刻的。
    const { rows } = await this.db.query(
      `SELECT now() AS read_at,
              (SELECT COALESCE(json_agg(json_build_object('key', key, 'value', value, 'updated_at', updated_at)), '[]'::json)
                 FROM bot_settings WHERE tenant_id = $1) AS rows`,
      [this.tenantId],
    );
    const list = typeof rows[0].rows === 'string' ? JSON.parse(rows[0].rows) : rows[0].rows;
    this.values = parseSettings(list.map((r) => ({ ...r, updated_at: new Date(r.updated_at) })));
    this.readAt = new Date(rows[0].read_at);
    return this.values;
  }

  // —— 奶蛙用：只读内存里的值 ——

  get dailyBudgetCny() {
    return this.values.dailyBudgetCny;
  }

  isIgnored(personKey) {
    return this.values.ignoredKeys.has(personKey);
  }

  /**
   * 这个会话按哪一档：私聊永远是 on；群里看单独设置，没有就跟着群默认。
   * @returns {'on'|'at'|'off'}
   */
  groupMode(conversationKey) {
    let place;
    try {
      place = placeOf(conversationKey);
    } catch {
      return 'on';
    }
    if (place.kind !== 'group') return 'on';
    return this.values.groups.get(place.key)?.mode ?? this.values.groupDefault;
  }

  // —— 命令用：直接写数据库 ——

  async setBudget(cny) {
    if (!isBudget(cny)) throw new SettingsError('上限要写数字（元），0 表示不限');
    await this._put(KEYS.budget, cny);
  }

  async resetBudget() {
    await this._delete(KEYS.budget);
  }

  /**
   * @param {string} groupId 群号，或者 'default'（没单独设置的群）
   * @param {'on'|'at'|'off'} mode
   */
  async setGroupMode(groupId, mode) {
    if (!isMode(mode)) throw new SettingsError('只能是 on（说话）、at（只回 @）、off（不说话）');
    await this._put(groupId === 'default' ? KEYS.groupDefault : GROUP_PREFIX + groupPlace(groupId), mode);
  }

  // 去掉这个群的单独设置，回到跟着群默认。
  async resetGroup(groupId) {
    await this._delete(GROUP_PREFIX + groupPlace(groupId));
  }

  // 加一个不理的 QQ 号。一条语句加完，命令和别的命令同时改也不会互相覆盖。返回是不是新加的。
  async addIgnore(qq) {
    const id = checkQQ(qq);
    const { rows } = await this.db.query(
      `INSERT INTO bot_settings (tenant_id, key, value) VALUES ($1, $2, jsonb_build_array($3::text))
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = bot_settings.value || jsonb_build_array($3::text), updated_at = now()
         WHERE NOT (bot_settings.value @> jsonb_build_array($3::text))
       RETURNING key`,
      [this.tenantId, KEYS.ignore, id],
    );
    return rows.length > 0;
  }

  // 去掉一个不理的 QQ 号。返回是不是真的去掉了（本来就没有的返回 false）。
  async removeIgnore(qq) {
    const id = checkQQ(qq);
    const { rows } = await this.db.query(
      `UPDATE bot_settings SET value = value - $3::text, updated_at = now()
        WHERE tenant_id = $1 AND key = $2 AND value @> jsonb_build_array($3::text) RETURNING key`,
      [this.tenantId, KEYS.ignore, id],
    );
    return rows.length > 0;
  }

  // 数据库现在的时间。命令改完设置后取一次：奶蛙在这之后读的设置一定包含这次改动。
  async dbNow() {
    const { rows } = await this.db.query('SELECT now() AS now');
    return new Date(rows[0].now);
  }

  async _put(key, value) {
    await this.db.query(
      `INSERT INTO bot_settings (tenant_id, key, value) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [this.tenantId, key, JSON.stringify(value)],
    );
  }

  async _delete(key) {
    await this.db.query('DELETE FROM bot_settings WHERE tenant_id = $1 AND key = $2', [this.tenantId, key]);
  }
}
