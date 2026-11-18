const DAY_MS = 86_400_000;

// 对一个人的印象（跟着人走，在任何群和私聊里都会放进提示，奶蛙靠它认人）。
// 规则印象：只用不含聊天内容的统计，不调模型，不会泄露任何对话内容。
// - QQ 昵称：用当前这条消息带来的昵称（群名片只用于单条消息显示，不在这里）。
//   不从关系记录取：私聊过的人才有关系记录，群里带不带昵称就会暴露“奶蛙私下跟他说过话”。
// - 熟悉程度：群聊里只按这个人在群里和奶蛙的互动来算（关系记录里的群聊计数，所有群合计），
//   所以同一个人在群 A、群 B 看到的印象一致；私聊互动不计入，群友就推断不出这个人私下找过奶蛙。
//   私聊里用全部互动。
// 记得的具体事（称呼、个人情况等）不在这里，见 src/memory/facts.js。
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
    const { rows } = await this.db.query(
      `SELECT interactions, first_seen, group_interactions, group_first_seen
         FROM relationships WHERE tenant_id = $1 AND peer_key = $2`,
      [this.tenantId, personKey],
    );
    const row = rows[0];
    const stats = !row ? { count: 0, firstAt: null }
      : inGroup ? { count: Number(row.group_interactions), firstAt: row.group_first_seen }
        : { count: Number(row.interactions), firstAt: row.first_seen };
    return [
      `代号 ${alias}${nickname ? `，QQ 昵称「${nickname}」` : ''}。`,
      familiarity(stats.count, stats.firstAt, now, inGroup ? '在群里' : ''),
    ].join('\n');
  }
}

function familiarity(count, firstAt, now, where) {
  if (!count) return where ? '这是你们第一次在群里说话。' : '这是你们第一次说话。';
  const days = firstAt ? Math.floor((now.getTime() - new Date(firstAt).getTime()) / DAY_MS) : 0;
  const since = days <= 0 ? '最早一次是今天' : `最早一次是 ${days} 天前`;
  return `你们${where}聊过 ${count} 次，${since}。`;
}
