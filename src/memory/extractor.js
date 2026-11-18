import { silentLogger } from '../log.js';
import { placeOf } from './place.js';
import { pickFacts, writeFact } from './facts.js';
import { EXTRACTION_PROMPT, buildExtractionInput, checkFact, parseFacts, renderTurn } from './extraction.js';

// 后台提炼（见 docs/memory-v2-design.md 第 6 节）。
// - 每分钟找一次有未提炼原话的会话：最后一条未提炼的原话已经过去 quietMs，或者攒到 batchForce 条，就提炼这一段。
// - 一次最多 batchMax 条；先给最多 contextTurns 条已经提炼过的原话当上文。
// - 写入事实和推进进度在同一个事务里，走持锁连接；推进时带上条件“进度还是开始时看到的那个值”，
//   两个进程同时提炼同一段时，后提交的那个回滚，不会重复写入。
// - 模型出错、输出解析不了：失败次数加一，下一轮再试；连续 maxFailures 次就跳过这一段。今日花费到上限不算失败。
// - 日志里不写聊天内容和事实内容，只写数量和原因。
export const MEMORY_DEFAULTS = {
  quietMs: 10 * 60_000,
  batchForce: 40,
  batchMax: 60,
  contextTurns: 6,
  knownMax: 20,
  maxFailures: 3,
  intervalMs: 60_000,
  maxOutputTokens: 800,
};

class ProgressConflict extends Error {}

export class MemoryExtractor {
  /**
   * @param {object} opts
   * @param {object} opts.db 读取用（连接池）
   * @param {object} [opts.writer] 写事实和进度用（持锁连接）；不传就用 db
   * @param {{chat: Function}} opts.brain 提炼用的模型（见 src/model/brain.js）
   * @param {import('../context/aliases.js').PersonAliases} opts.aliases 代号 → 人
   * @param {import('./facts.js').FactStore} opts.facts
   */
  constructor({ db, writer = db, tenantId = 'default', brain, aliases, facts, logger = silentLogger,
    now = () => new Date(), ...options } = {}) {
    if (!db || !brain || !aliases || !facts) throw new Error('MemoryExtractor 需要 db、brain、aliases、facts');
    this.db = db;
    this.writer = writer;
    this.tenantId = tenantId;
    this.brain = brain;
    this.aliases = aliases;
    this.facts = facts;
    this.log = logger;
    this.now = now;
    const given = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
    this.options = { ...MEMORY_DEFAULTS, ...given };
    this.timer = null;
    this.running = null;
    this.stopped = false;
  }

  start() {
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref?.();
    return this;
  }

  // 停止定时器。正在等模型的那一段不等它：模型返回后发现已停止就放弃，进度没推进，重启后重做。
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }

  async tick() {
    if (this.running || this.stopped) return;
    this.running = this.runDue().catch((error) => {
      this.log.error('memory.tick_failed', { msg: '后台提炼出错', error });
    });
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  // 该提炼的会话，按最后一条原话的时间从早到晚。
  async dueConversations() {
    const { rows } = await this.db.query(
      `SELECT t.conversation_key, count(*)::int AS pending, max(t.created_at) AS last_at
         FROM conversation_turns AS t
         LEFT JOIN memory_progress AS p ON p.tenant_id = t.tenant_id AND p.conversation_key = t.conversation_key
        WHERE t.tenant_id = $1 AND t.id > COALESCE(p.last_turn_id, 0)
        GROUP BY t.conversation_key
        ORDER BY last_at`,
      [this.tenantId],
    );
    const now = this.now().getTime();
    return rows
      .filter((r) => r.pending >= this.options.batchForce || now - r.last_at.getTime() >= this.options.quietMs)
      .map((r) => r.conversation_key);
  }

  // 一个接一个提炼该提炼的会话。今日花费到上限时停下，等第二天。
  async runDue() {
    const results = [];
    for (const conversationKey of await this.dueConversations()) {
      if (this.stopped) break;
      let result;
      try {
        result = await this.runConversation(conversationKey);
      } catch (error) {
        // 一个会话出意外错误（例如读数据库失败），不拖累其他会话；进度没动，下一轮再试。
        this.log.error('memory.conversation_failed', { msg: '提炼这个会话时出错', conversationKey, error });
        result = { outcome: 'error' };
      }
      results.push({ conversationKey, ...result });
      if (result.outcome === 'budget') break;
    }
    return results;
  }

  async _progress(conversationKey) {
    const { rows } = await this.db.query(
      'SELECT last_turn_id, failures FROM memory_progress WHERE tenant_id = $1 AND conversation_key = $2',
      [this.tenantId, conversationKey],
    );
    return rows[0] ? { last: Number(rows[0].last_turn_id), failures: rows[0].failures } : { last: 0, failures: 0 };
  }

  // 把进度从 expected 改成 next（没有这一行就新建）。进度已经被别人改过时什么都不做，返回 false。
  async _setProgress(q, conversationKey, expected, next, failures) {
    const { rows } = await q.query(
      `INSERT INTO memory_progress AS p (tenant_id, conversation_key, last_turn_id, failures, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tenant_id, conversation_key) DO UPDATE
         SET last_turn_id = EXCLUDED.last_turn_id, failures = EXCLUDED.failures, updated_at = now()
         WHERE p.last_turn_id = $5
       RETURNING 1`,
      [this.tenantId, conversationKey, next, failures, expected],
    );
    return rows.length > 0;
  }

  /**
   * 提炼一个会话里还没提炼的下一段。
   * @returns {Promise<{outcome: 'empty'|'extracted'|'failed'|'skipped'|'budget'|'conflict'|'stopped', written?: number, dropped?: object}>}
   */
  async runConversation(conversationKey) {
    const log = this.log.child({ conversationKey });
    const place = placeOf(conversationKey);
    const progress = await this._progress(conversationKey);
    const { rows } = await this.db.query(
      `SELECT id, role, content, created_at FROM conversation_turns
        WHERE tenant_id = $1 AND conversation_key = $2 AND id > $3 ORDER BY id LIMIT $4`,
      [this.tenantId, conversationKey, progress.last, this.options.batchMax],
    );
    if (!rows.length) return { outcome: 'empty' };
    const { rows: before } = await this.db.query(
      `SELECT id, role, content, created_at FROM conversation_turns
        WHERE tenant_id = $1 AND conversation_key = $2 AND id <= $3 ORDER BY id DESC LIMIT $4`,
      [this.tenantId, conversationKey, progress.last, this.options.contextTurns],
    );
    const batch = rows.map(renderTurn);
    const context = before.reverse().map(renderTurn);
    const batchEnd = batch.at(-1).id;

    // 说话人的代号全局固定，能反查出是谁。
    const personOf = await this.aliases.keysOf(batch.map((t) => t.alias).filter(Boolean));
    const aliasOfKey = new Map([...personOf].map(([alias, key]) => [key, alias]));
    const speakers = [...personOf.values()];
    const known = pickFacts(await this.facts.inView(place.key, speakers), { people: speakers, place, limit: this.options.knownMax })
      .facts.map((f) => ({ about: f.item === 'group_event' ? '群' : aliasOfKey.get(f.subject), item: f.item, content: f.content }));

    let raws;
    try {
      const text = await this.brain.chat([
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content: buildExtractionInput({ placeKind: place.kind, context, batch, known }) },
      ], { conversationKey: `memory:${conversationKey}`, webSearch: false, maxOutputTokens: this.options.maxOutputTokens });
      raws = parseFacts(text);
    } catch (error) {
      if (error?.code === 'BUDGET_EXCEEDED') {
        log.info('memory.budget_wait', { msg: '今日模型花费已达上限，明天再提炼' });
        return { outcome: 'budget' };
      }
      if (this.stopped) return { outcome: 'stopped' };
      return this._fail(log, conversationKey, progress, batchEnd, batch.length, error);
    }
    if (this.stopped) return { outcome: 'stopped' };

    const dropped = {};
    const count = (reason) => { dropped[reason] = (dropped[reason] ?? 0) + 1; };
    const accepted = [];
    for (const raw of raws) {
      const checked = checkFact(raw, { batch, place, personOf });
      if (checked.ok) accepted.push(checked.fact);
      else count(checked.reason);
    }

    let result;
    try {
      result = await this.writer.transaction(async (tx) => {
        // 先推进进度：同时提炼同一段的另一个进程会在这里排队，等前一个提交后发现进度变了。
        if (!await this._setProgress(tx, conversationKey, progress.last, batchEnd, 0)) throw new ProgressConflict();
        const outcome = { written: 0, replaced: 0, dropped: {} };
        for (const fact of accepted) {
          const r = await writeFact(tx, this.tenantId, fact);
          if (r.written) {
            outcome.written += 1;
            outcome.replaced += r.replaced;
          } else {
            outcome.dropped[r.reason] = (outcome.dropped[r.reason] ?? 0) + 1;
          }
        }
        return outcome;
      });
    } catch (error) {
      if (error instanceof ProgressConflict) {
        log.info('memory.conflict', { msg: '这一段已经被别的进程提炼过，本次不写入' });
        return { outcome: 'conflict' };
      }
      // 写入出错（例如持锁连接断开）：整个事务已回滚，按失败处理，免得每分钟重复调用模型。
      return this._fail(log, conversationKey, progress, batchEnd, batch.length, error);
    }
    for (const [reason, n] of Object.entries(result.dropped)) dropped[reason] = (dropped[reason] ?? 0) + n;
    log.info('memory.extracted', {
      turns: batch.length, proposed: raws.length, written: result.written, replaced: result.replaced || undefined,
      dropped: Object.keys(dropped).length ? dropped : undefined,
    });
    return { outcome: 'extracted', written: result.written, dropped };
  }

  async _fail(log, conversationKey, progress, batchEnd, turns, error) {
    const failures = progress.failures + 1;
    const skip = failures >= this.options.maxFailures;
    try {
      await this._setProgress(this.writer, conversationKey, progress.last, skip ? batchEnd : progress.last, skip ? 0 : failures);
    } catch (writeError) {
      log.error('memory.progress_failed', { msg: '记录提炼失败次数时出错', error: writeError });
    }
    if (skip) {
      log.error('memory.batch_skipped', { msg: `这一段连续提炼失败 ${failures} 次，已跳过`, code: error?.code, turns, error });
      return { outcome: 'skipped', failures };
    }
    log.warn('memory.extract_failed', { msg: '提炼失败，下一轮再试', code: error?.code, failures, error });
    return { outcome: 'failed', failures };
  }
}
