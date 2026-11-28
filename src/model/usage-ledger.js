import { beijingDate } from './pricing.js';

const EMPTY_USAGE = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, searches: 0, fetches: 0 };

// 模型用量账本：按北京时间的日期、会话、模型，累计调用次数、token、搜索次数和估算花费。
// - 存在数据库里，重启后不清零，每日花费上限才不会因为重启失效。
// - 每次累加是一条 upsert，多个进程同时写也不会丢计数。
// - 只存计数和金额，不存任何聊天内容。
export class ModelUsageLedger {
  constructor({ db, tenantId = 'default' } = {}) {
    if (!db) throw new Error('ModelUsageLedger 需要 db（见 src/storage 的 openStorage）');
    this.db = db;
    this.tenantId = tenantId;
  }

  // 删掉 keepDays 天以前（按北京时间的日期）的用量记录：私聊的会话编号里带着号码，不能一直留着（Module 10）。
  async prune({ keepDays = 90, at = new Date() } = {}) {
    const oldest = beijingDate(new Date(at.getTime() - (keepDays - 1) * 86_400_000));
    const { rowCount } = await this.db.query('DELETE FROM model_usage WHERE tenant_id = $1 AND day < $2::date', [this.tenantId, oldest]);
    return rowCount;
  }

  /**
   * 记一次调用。
   * @param {object} args
   * @param {Date} [args.at] 调用时间，决定记在哪一天（北京时间）
   * @param {string} [args.conversationKey]
   * @param {string} args.model
   * @param {object|null} [args.usage] 模型返回的用量；null 表示拿不到（例如超时），只记一次“用量未知的调用”
   * @param {number} args.costCny 这次调用的估算花费
   */
  async record({ at = new Date(), conversationKey, model, usage = null, costCny }) {
    const u = usage ?? EMPTY_USAGE;
    await this.db.query(
      `INSERT INTO model_usage (tenant_id, day, conversation_key, model, calls, unknown_calls,
         input_tokens, cached_tokens, output_tokens, reasoning_tokens, searches, fetches, cost_cny, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
       ON CONFLICT (tenant_id, day, conversation_key, model) DO UPDATE SET
         calls = model_usage.calls + EXCLUDED.calls,
         unknown_calls = model_usage.unknown_calls + EXCLUDED.unknown_calls,
         input_tokens = model_usage.input_tokens + EXCLUDED.input_tokens,
         cached_tokens = model_usage.cached_tokens + EXCLUDED.cached_tokens,
         output_tokens = model_usage.output_tokens + EXCLUDED.output_tokens,
         reasoning_tokens = model_usage.reasoning_tokens + EXCLUDED.reasoning_tokens,
         searches = model_usage.searches + EXCLUDED.searches,
         fetches = model_usage.fetches + EXCLUDED.fetches,
         cost_cny = model_usage.cost_cny + EXCLUDED.cost_cny,
         updated_at = now()`,
      [
        this.tenantId, beijingDate(at), conversationKey || '(none)', model, usage ? 1 : 0, usage ? 0 : 1,
        u.inputTokens, u.cachedTokens, u.outputTokens, u.reasoningTokens, u.searches, u.fetches, costCny,
      ],
    );
  }

  // 某一天（北京时间）的合计。calls 是拿到用量的调用次数，unknownCalls 是用量未知、按估算计费的次数。
  async day(at = new Date()) {
    const { rows } = await this.db.query(
      `SELECT COALESCE(SUM(cost_cny), 0)::float8 AS cost,
              COALESCE(SUM(calls), 0)::int AS calls,
              COALESCE(SUM(unknown_calls), 0)::int AS unknown_calls,
              COALESCE(SUM(input_tokens), 0)::float8 AS input_tokens,
              COALESCE(SUM(output_tokens), 0)::float8 AS output_tokens,
              COALESCE(SUM(searches), 0)::int AS searches
         FROM model_usage WHERE tenant_id = $1 AND day = $2`,
      [this.tenantId, beijingDate(at)],
    );
    const r = rows[0];
    return {
      day: beijingDate(at),
      costCny: Number(r.cost),
      calls: Number(r.calls),
      unknownCalls: Number(r.unknown_calls),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      searches: Number(r.searches),
    };
  }

  // 某一天（北京时间）按模型、按会话分开的花费，给 naiwa budget 看（Module 9）。calls 含用量未知的调用。
  async breakdown(at = new Date(), { topConversations = 3 } = {}) {
    const day = beijingDate(at);
    const byModel = await this.db.query(
      `SELECT model, SUM(cost_cny)::float8 AS cost, SUM(calls + unknown_calls)::int AS calls
         FROM model_usage WHERE tenant_id = $1 AND day = $2 GROUP BY model ORDER BY cost DESC`,
      [this.tenantId, day],
    );
    const byConversation = await this.db.query(
      `SELECT conversation_key, SUM(cost_cny)::float8 AS cost
         FROM model_usage WHERE tenant_id = $1 AND day = $2 GROUP BY conversation_key ORDER BY cost DESC LIMIT $3`,
      [this.tenantId, day, topConversations],
    );
    return {
      day,
      byModel: byModel.rows.map((r) => ({ model: r.model, costCny: Number(r.cost), calls: Number(r.calls) })),
      byConversation: byConversation.rows.map((r) => ({ conversationKey: r.conversation_key, costCny: Number(r.cost) })),
    };
  }
}
