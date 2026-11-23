import { parsePersonKey } from './place.js';

// 按人删除（见 docs/memory-v2-design.md 第 8 节）。必须先停掉机器人：调用方要先拿到运行锁，在同一条连接上用一个事务删完。
// 删除范围：
// - 关于他的事实、他私聊里的事实，以及出处用到他原话的群事；
// - 和他的私聊原话；他在群里说的原话，以及奶蛙对这些话的回复；
// - 他私聊会话的提炼进度；
// - 他的关系记录和代号（代号计数器不回退：他再来会拿到新代号）；
// - 事件表里和他有关的记录（目前是“和奶蛙互动过”，不含聊天内容）。旧系统留下的旧格式事件（只写号码、不带平台）认不出来。
// 不删别人说的话里提到他的部分，那些属于别人那一轮对话，7 天后随原话到期删除。
//
// countPersonData 只数不删（预览用，只读，机器人运行时也可以用）；deletePersonData 用同样的条件删除。

// 会话 key：平台:account:账号:conversation:类型:对方（见 src/identity.js）。
const PRIVATE_WITH = `split_part(conversation_key, ':', 1) = $2
  AND split_part(conversation_key, ':', 5) = 'private' AND split_part(conversation_key, ':', 6) = $3`;

// 每一项：表、条件、参数。条件里 $1 都是租户。
function targets({ tenantId, personKey }, person, groupTurnIds) {
  return {
    facts: ['memory_facts', '(subject_key = $2 OR place_key = $2 OR $2 = ANY(source_speakers))', [tenantId, personKey]],
    privateTurns: ['conversation_turns', PRIVATE_WITH, [tenantId, person.platform, person.id]],
    groupTurns: ['conversation_turns', 'id = ANY($2::bigint[])', [tenantId, groupTurnIds]],
    progress: ['memory_progress', PRIVATE_WITH, [tenantId, person.platform, person.id]],
    relationships: ['relationships', 'peer_key = $2', [tenantId, personKey]],
    aliases: ['person_aliases', 'person_key = $2', [tenantId, personKey]],
    // 关系事件写的是 target = 他、privacy = private:他（src/fish.js 的 touch）；actor 留给以后以他为主语的事件。
    events: ['events', '(target = $2 OR actor = $2 OR privacy = $3)', [tenantId, personKey, `private:${personKey}`]],
  };
}

function senderAlias(content) {
  try {
    return JSON.parse(content)?.sender?.alias ?? null;
  } catch {
    return null;
  }
}

// 他在群里说的原话，加上同一条入站消息的奶蛙回复（一问一答写入时带同一个 message_key）。
// 原话表没有“谁说的”这一列，只能从信封里的代号认出来。
async function groupTurnIds(q, { tenantId, personKey }) {
  const { rows: aliasRows } = await q.query(
    'SELECT alias_no FROM person_aliases WHERE tenant_id = $1 AND person_key = $2', [tenantId, personKey],
  );
  if (!aliasRows[0]) return [];
  const alias = `u${aliasRows[0].alias_no}`;
  const { rows } = await q.query(
    `SELECT id, conversation_key, role, content, message_key FROM conversation_turns
      WHERE tenant_id = $1 AND split_part(conversation_key, ':', 5) = 'group'`,
    [tenantId],
  );
  const his = new Set(rows.filter((r) => r.role === 'user' && senderAlias(r.content) === alias));
  const pair = (r) => `${r.conversation_key}\u001f${r.message_key}`;
  const pairs = new Set([...his].filter((r) => r.message_key).map(pair));
  return rows.filter((r) => his.has(r) || (r.message_key && pairs.has(pair(r)))).map((r) => r.id);
}

async function run(q, args, verb) {
  const person = parsePersonKey(args.personKey);
  if (!person) throw new TypeError(`人的 key 格式应为“平台:user:号码”，例如 qq:user:101：${args.personKey}`);
  // 先算群聊原话：要用代号认人，代号在最后才删。
  const list = targets(args, person, await groupTurnIds(q, args));
  const counts = {};
  for (const [name, [table, where, params]] of Object.entries(list)) {
    const { rows } = verb === 'count'
      ? await q.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND ${where}`, params)
      : await q.query(`WITH d AS (DELETE FROM ${table} WHERE tenant_id = $1 AND ${where} RETURNING 1)
                       SELECT count(*)::int AS n FROM d`, params);
    counts[name] = rows[0].n;
  }
  return counts;
}

/**
 * 数一数这个人有多少数据会被删除，什么都不改。
 * @param {{query: Function}} q
 * @param {{tenantId: string, personKey: string}} args
 */
export function countPersonData(q, args) {
  return run(q, args, 'count');
}

/**
 * 在调用方的事务里删除这个人的数据，返回各项删除的条数。
 * @param {{query: Function}} tx
 * @param {{tenantId: string, personKey: string}} args
 */
export function deletePersonData(tx, args) {
  return run(tx, args, 'delete');
}
