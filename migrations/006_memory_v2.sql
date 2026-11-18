-- 006：记忆 v2（见 docs/memory-v2-design.md）。
-- 原话（conversation_turns）不改；新增事实表和提炼进度表；群聊熟悉度改为关系表里的计数；删除 memories 表。

-- 1. 事实：模型从原话里提出、程序审核后写入的短句，每条带出处原话。
--    subject_key：关于谁（人的 key；群事是群的地方 key）。
--    place_key：出自哪里，不带机器人账号。群：qq:group:200；私聊：对方的 key，例如 qq:user:101。
CREATE TABLE memory_facts (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       text        NOT NULL,
  subject_key     text        NOT NULL,
  item            text        NOT NULL CHECK (item IN ('call_name', 'profile', 'recent', 'group_event')),
  content         text        NOT NULL CHECK (char_length(content) BETWEEN 1 AND 60),
  place_key       text        NOT NULL,
  place_kind      text        NOT NULL CHECK (place_kind IN ('private', 'group')),
  source_turn_ids bigint[]    NOT NULL,
  source_quote    text        NOT NULL CHECK (char_length(source_quote) <= 80), -- 出处原话的副本，跟着事实一起删除
  source_speakers text[]      NOT NULL,                                         -- 出处原话是谁说的
  said_at         timestamptz NOT NULL, -- 出处原话的时间（多句取最晚）；新旧、显示、到期都按它
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- 群事只能出自群聊，而且关于这个群本身。
  CHECK (item <> 'group_event' OR (place_kind = 'group' AND subject_key = place_key))
);
CREATE INDEX memory_facts_place_idx ON memory_facts (tenant_id, place_key);
CREATE INDEX memory_facts_subject_idx ON memory_facts (tenant_id, subject_key, item);
CREATE INDEX memory_facts_expires_idx ON memory_facts (expires_at);
CREATE INDEX memory_facts_speakers_idx ON memory_facts USING gin (source_speakers);

-- 2. 提炼进度：每个会话提炼到了哪条原话，以及这一段连续失败了几次。
CREATE TABLE memory_progress (
  tenant_id        text        NOT NULL,
  conversation_key text        NOT NULL,
  last_turn_id     bigint      NOT NULL,
  failures         integer     NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, conversation_key)
);
-- 上线前的原话不提炼：已有会话的进度设到当前最后一条。
INSERT INTO memory_progress (tenant_id, conversation_key, last_turn_id)
SELECT tenant_id, conversation_key, max(id) FROM conversation_turns GROUP BY tenant_id, conversation_key;

-- 3. 群聊熟悉度：原来数群聊情节记忆的条数，情节记忆停写后改为计数。
--    按原来的算法补算：每条群聊情节记忆算这条记录涉及的每个人一次（同一条里同一个人只算一次）。
ALTER TABLE relationships ADD COLUMN group_interactions integer NOT NULL DEFAULT 0;
ALTER TABLE relationships ADD COLUMN group_first_seen timestamptz;
UPDATE relationships AS r
   SET group_interactions = s.n, group_first_seen = s.first_at
  FROM (
    SELECT m.tenant_id, u.peer_key, count(*)::int AS n, min(m.ts) AS first_at
      FROM memories AS m
      CROSS JOIN LATERAL (SELECT DISTINCT unnest(m.peers) AS peer_key) AS u
     WHERE m.type = 'episodic' AND m.access LIKE 'conversation:%:conversation:group:%'
     GROUP BY m.tenant_id, u.peer_key
  ) AS s
 WHERE r.tenant_id = s.tenant_id AND r.peer_key = s.peer_key;

-- 4. 删除 memories 表：新设计里没有地方用它。
DROP TABLE memories;
