-- 004：上下文与长期记忆（Module 6）。

-- 1. 全局、持久的代号：每个人在一个租户里只有一个代号（u1、u2…），任何群和私聊里都一样，重启不变。
CREATE TABLE person_aliases (
  tenant_id  text        NOT NULL,
  person_key text        NOT NULL,
  alias_no   integer     NOT NULL CHECK (alias_no > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, person_key),
  UNIQUE (tenant_id, alias_no)
);
-- 每个租户已经分配到的最大编号。分配新代号时锁住这一行，多个进程同时分配也不会重号。
CREATE TABLE person_alias_counters (
  tenant_id text    PRIMARY KEY,
  last_no   integer NOT NULL
);

-- 2. 短期对话历史：每个会话最近几轮发给模型的消息，重启后仍在；超过 7 天的定期删除。
--    用户消息存发给模型的信封（代号、昵称、消息段），助手消息存发出的回复。
CREATE TABLE conversation_turns (
  id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        text        NOT NULL,
  conversation_key text        NOT NULL,
  role             text        NOT NULL CHECK (role IN ('user', 'assistant')),
  content          text        NOT NULL,
  message_key      text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversation_turns_recent_idx ON conversation_turns (tenant_id, conversation_key, id DESC);
CREATE INDEX conversation_turns_created_idx ON conversation_turns (created_at);

-- 3. 相同内容可以属于不同的人：去重键带上 peers（去重、按字节序排序，用 \x1f 连接，与 src/memory.js 的 dedupeKey 一致）。
--    没有 peers 的记录不变。只会让去重键更细，不会产生新的冲突。
UPDATE memories AS m SET dedupe_key = m.dedupe_key || chr(31) || (
  SELECT string_agg(p, chr(31) ORDER BY p) FROM (SELECT DISTINCT unnest(m.peers) COLLATE "C" AS p) AS s
) WHERE m.dedupe_key IS NOT NULL AND cardinality(m.peers) > 0;

-- 4. 按人统计互动（规则印象）要按 peers 查记忆。
CREATE INDEX memories_peers_idx ON memories USING gin (peers);
