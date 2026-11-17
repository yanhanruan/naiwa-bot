import { scope } from '../schema.js';

const DAY_MS = 86_400_000;

// 对一个人的印象（跟着人走，在任何群和私聊里都会放进提示，奶蛙靠它认人）。
// 目前是规则印象：只用不含聊天内容的统计，不调模型，不会泄露任何对话内容。
// - QQ 昵称：用当前这条消息带来的昵称（群名片只用于单条消息显示，不在这里）。
//   不从关系记录取：私聊过的人才有关系记录，群里带不带昵称就会暴露“奶蛙私下跟他说过话”。
// - 熟悉程度：群聊里只按这个人在群里和奶蛙的互动来算（所有群合计），所以同一个人在群 A、群 B 看到的印象一致；
//   私聊互动不计入，群友就推断不出这个人私下找过奶蛙。群聊里完全不读关系记录。私聊里用全部互动（关系记录）。
// - person:<人> 范围的记忆：专门存放“跟着人走”的印象（为以后的模型提炼印象、运维备注预留；目前还没有写入入口）。
//   注意不是 private:<人>：那是“某人的私事”，绝不能进群。
// 好感度目前每条消息都加分，没有意义（Module 8 重做），暂不放进印象。
export class PersonImpressions {
  constructor({ db, tenantId = 'default' } = {}) {
    if (!db) throw new Error('PersonImpressions 需要 db（见 src/storage 的 openStorage）');
    this.db = db;
    this.tenantId = tenantId;
  }

  /**
   * 生成一段给模型看的印象说明。
   * @param {string} personKey
   * @param {{alias: string, nickname?: string|null, inGroup: boolean, now?: Date}} opts nickname 取自当前这条消息
   */
  async describe(personKey, { alias, nickname = null, inGroup, now = new Date() }) {
    const [stats, notes] = await Promise.all([
      inGroup ? this._groupStats(personKey) : this._allStats(personKey), this._personNotes(personKey),
    ]);
    const lines = [
      `代号 ${alias}${nickname ? `，QQ 昵称「${nickname}」` : ''}。`,
      familiarity(stats.count, stats.firstAt, now, inGroup ? '在群里' : ''),
    ];
    for (const note of notes) lines.push(`- ${note}`);
    return lines.join('\n');
  }

  // 全部互动（只在私聊里用）：关系记录里的互动次数和第一次见面的时间。
  async _allStats(personKey) {
    const { rows } = await this.db.query(
      'SELECT first_seen, interactions FROM relationships WHERE tenant_id = $1 AND peer_key = $2',
      [this.tenantId, personKey],
    );
    const row = rows[0];
    return row ? { count: Number(row.interactions), firstAt: row.first_seen } : { count: 0, firstAt: null };
  }

  // 这个人在所有群里和奶蛙的互动：群聊情节记忆的条数和最早时间。
  async _groupStats(personKey) {
    const { rows } = await this.db.query(
      `SELECT count(*)::int AS n, min(ts) AS first_at FROM memories
        WHERE tenant_id = $1 AND type = 'episodic' AND peers @> ARRAY[$2]::text[]
          AND access LIKE 'conversation:%:conversation:group:%'`,
      [this.tenantId, personKey],
    );
    return { count: Number(rows[0].n), firstAt: rows[0].first_at };
  }

  async _personNotes(personKey) {
    const { rows } = await this.db.query(
      `SELECT summary FROM memories WHERE tenant_id = $1 AND access = $2
        ORDER BY importance DESC, ts DESC LIMIT 3`,
      [this.tenantId, scope.person(personKey)],
    );
    return rows.map((row) => row.summary);
  }
}

function familiarity(count, firstAt, now, where) {
  if (!count) return where ? '这是你们第一次在群里说话。' : '这是你们第一次说话。';
  const days = firstAt ? Math.floor((now.getTime() - new Date(firstAt).getTime()) / DAY_MS) : 0;
  const since = days <= 0 ? '最早一次是今天' : `最早一次是 ${days} 天前`;
  return `你们${where}聊过 ${count} 次，${since}。`;
}
