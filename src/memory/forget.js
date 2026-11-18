import { parsePersonKey } from './place.js';

// 按人删除（见 docs/memory-v2-design.md 第 8 节）。必须先停掉机器人：调用方要先拿到运行锁，在同一条连接上用一个事务删完。
// 删除范围：
// - 关于他的事实、他私聊里的事实，以及出处用到他原话的群事；
// - 和他的私聊原话；他在群里说的原话，以及奶蛙对这些话的回复；
// - 他私聊会话的提炼进度；
// - 他的关系记录和代号（代号计数器不回退：他再来会拿到新代号）。
// 不删别人说的话里提到他的部分，那些属于别人那一轮对话，7 天后随原话到期删除。

// 会话 key：平台:account:账号:conversation:类型:对方（见 src/identity.js）。
const PRIVATE_WITH = `split_part(conversation_key, ':', 1) = $2
  AND split_part(conversation_key, ':', 5) = 'private' AND split_part(conversation_key, ':', 6) = $3`;

function senderAlias(content) {
  try {
    return JSON.parse(content)?.sender?.alias ?? null;
  } catch {
    return null;
  }
}

/**
 * 在调用方的事务里删除这个人的数据，返回各项删除的条数。
 * @param {{query: Function}} tx
 * @param {{tenantId: string, personKey: string}} opts
 */
export async function deletePersonData(tx, { tenantId, personKey }) {
  const person = parsePersonKey(personKey);
  if (!person) throw new TypeError(`人的 key 格式应为“平台:user:号码”，例如 qq:user:101：${personKey}`);
  const deleted = (result) => result.rows.length;

  const { rows: aliasRows } = await tx.query(
    'SELECT alias_no FROM person_aliases WHERE tenant_id = $1 AND person_key = $2', [tenantId, personKey],
  );
  const alias = aliasRows[0] ? `u${aliasRows[0].alias_no}` : null;

  const facts = deleted(await tx.query(
    `DELETE FROM memory_facts WHERE tenant_id = $1
       AND (subject_key = $2 OR place_key = $2 OR $2 = ANY(source_speakers)) RETURNING id`,
    [tenantId, personKey],
  ));
  const privateTurns = deleted(await tx.query(
    `DELETE FROM conversation_turns WHERE tenant_id = $1 AND ${PRIVATE_WITH} RETURNING id`,
    [tenantId, person.platform, person.id],
  ));

  // 群里：发言者代号是他的用户消息，加上同一条入站消息的奶蛙回复（一问一答写入时带同一个 message_key）。
  let groupTurns = 0;
  if (alias) {
    const { rows } = await tx.query(
      `SELECT id, conversation_key, role, content, message_key FROM conversation_turns
        WHERE tenant_id = $1 AND split_part(conversation_key, ':', 5) = 'group'`,
      [tenantId],
    );
    const his = rows.filter((r) => r.role === 'user' && senderAlias(r.content) === alias);
    const pairs = new Set(his.filter((r) => r.message_key).map((r) => `${r.conversation_key}\u001f${r.message_key}`));
    const ids = rows
      .filter((r) => his.includes(r) || (r.message_key && pairs.has(`${r.conversation_key}\u001f${r.message_key}`)))
      .map((r) => r.id);
    if (ids.length) {
      groupTurns = deleted(await tx.query('DELETE FROM conversation_turns WHERE id = ANY($1::bigint[]) RETURNING id', [ids]));
    }
  }

  const progress = deleted(await tx.query(
    `DELETE FROM memory_progress WHERE tenant_id = $1 AND ${PRIVATE_WITH} RETURNING 1`,
    [tenantId, person.platform, person.id],
  ));
  const relationships = deleted(await tx.query(
    'DELETE FROM relationships WHERE tenant_id = $1 AND peer_key = $2 RETURNING 1', [tenantId, personKey],
  ));
  const aliases = deleted(await tx.query(
    'DELETE FROM person_aliases WHERE tenant_id = $1 AND person_key = $2 RETURNING 1', [tenantId, personKey],
  ));
  return { facts, privateTurns, groupTurns, progress, relationships, aliases };
}
