// 全局、持久的代号：每个人（用户 key）在一个租户里只有一个代号 u1、u2…，任何群和私聊里都一样，重启不变。
// 模型只看到代号，看不到 QQ 号或内部 key；同一个代号在不同会话里出现，模型就知道是同一个人。
// 代号按第一次出现的顺序分配，分配后不会再变，所以可以放心缓存在进程里。
// （forget-person 删代号前必须停机器人，重启后缓存是空的，见 docs/memory-v2-design.md 第 8 节。）
// 分配代号要写表：走 writer（持锁连接，见 src/storage/run-lock.js）；查询走 db（连接池）。
export class PersonAliases {
  constructor({ db, writer = db, tenantId = 'default' } = {}) {
    if (!db) throw new Error('PersonAliases 需要 db（见 src/storage 的 openStorage）');
    this.db = db;
    this.writer = writer;
    this.tenantId = tenantId;
    this.cache = new Map(); // personKey -> 'u12'
  }

  /**
   * 取一批人的代号，没有的按传入顺序分配。返回 Map(personKey -> 代号)。
   * @param {Array<string|null|undefined>} keys 空值会被忽略
   */
  async resolve(keys) {
    const wanted = [...new Set(keys.filter(Boolean))];
    const found = await this.known(wanted);
    const unassigned = wanted.filter((key) => !found.has(key));
    if (unassigned.length) await this._assign(unassigned);
    return new Map(wanted.map((key) => [key, this.cache.get(key)]));
  }

  /**
   * 只查已经有的代号，不分配新的：没有代号的人不在结果里，也不会因此在数据库里留下记录。
   * 用于群里最近的聊天里只在旁边说话、没找过奶蛙的人。
   * @param {Array<string|null|undefined>} keys 空值会被忽略
   * @returns {Promise<Map<string, string>>}
   */
  async known(keys) {
    const wanted = [...new Set(keys.filter(Boolean))];
    const missing = wanted.filter((key) => !this.cache.has(key));
    if (missing.length) {
      const { rows } = await this.db.query(
        'SELECT person_key, alias_no FROM person_aliases WHERE tenant_id = $1 AND person_key = ANY($2::text[])',
        [this.tenantId, missing],
      );
      for (const row of rows) this.cache.set(row.person_key, `u${row.alias_no}`);
    }
    return new Map(wanted.filter((key) => this.cache.has(key)).map((key) => [key, this.cache.get(key)]));
  }

  /**
   * 反查：代号 → 人的 key。查不到的（例如这个人已被 forget-person 删除）不在结果里。
   * @param {string[]} aliases 形如 u12
   * @returns {Promise<Map<string, string>>}
   */
  async keysOf(aliases) {
    const numbers = [...new Set(aliases)].map((a) => /^u(\d+)$/.exec(a)).filter(Boolean).map((m) => Number(m[1]));
    if (!numbers.length) return new Map();
    const { rows } = await this.db.query(
      'SELECT person_key, alias_no FROM person_aliases WHERE tenant_id = $1 AND alias_no = ANY($2::int[])',
      [this.tenantId, numbers],
    );
    return new Map(rows.map((row) => [`u${row.alias_no}`, row.person_key]));
  }

  // 先锁住这个租户的计数器，再检查、分配：另一个进程刚分配过的代号这时一定看得到，不会重号。
  async _assign(keys) {
    const assigned = await this.writer.transaction(async (tx) => {
      await tx.query(
        'INSERT INTO person_alias_counters (tenant_id, last_no) VALUES ($1, 0) ON CONFLICT (tenant_id) DO NOTHING',
        [this.tenantId],
      );
      const { rows: [counter] } = await tx.query(
        'SELECT last_no FROM person_alias_counters WHERE tenant_id = $1 FOR UPDATE',
        [this.tenantId],
      );
      const { rows: existing } = await tx.query(
        'SELECT person_key, alias_no FROM person_aliases WHERE tenant_id = $1 AND person_key = ANY($2::text[])',
        [this.tenantId, keys],
      );
      const result = new Map(existing.map((row) => [row.person_key, row.alias_no]));
      let lastNo = counter.last_no;
      for (const key of keys) {
        if (result.has(key)) continue;
        lastNo += 1;
        await tx.query(
          'INSERT INTO person_aliases (tenant_id, person_key, alias_no) VALUES ($1, $2, $3)',
          [this.tenantId, key, lastNo],
        );
        result.set(key, lastNo);
      }
      if (lastNo !== counter.last_no) {
        await tx.query('UPDATE person_alias_counters SET last_no = $2 WHERE tenant_id = $1', [this.tenantId, lastNo]);
      }
      return result;
    });
    for (const [key, no] of assigned) this.cache.set(key, `u${no}`);
  }
}
