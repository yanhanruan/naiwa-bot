-- 001：初始表结构。所有业务表带 tenant_id，目前只有一个默认租户 'default'。

CREATE TABLE events (
  id        uuid PRIMARY KEY,
  tenant_id text        NOT NULL,
  ts        timestamptz NOT NULL,
  platform  text        NOT NULL,
  kind      text        NOT NULL,
  actor     text,
  target    text,
  payload   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  privacy   text        NOT NULL,
  meta      jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX events_tenant_ts_idx ON events (tenant_id, ts);
CREATE INDEX events_tenant_kind_idx ON events (tenant_id, kind);

CREATE TABLE memories (
  id         uuid PRIMARY KEY,
  tenant_id  text             NOT NULL,
  ts         timestamptz      NOT NULL,
  type       text             NOT NULL CHECK (type IN ('episodic', 'semantic', 'relational', 'interest', 'self')),
  content    text             NOT NULL CHECK (content <> ''),
  summary    text             NOT NULL,
  tags       text[]           NOT NULL DEFAULT '{}',
  peers      text[]           NOT NULL DEFAULT '{}',
  importance double precision NOT NULL CHECK (importance >= 0 AND importance <= 1),
  access     text             NOT NULL CHECK (access <> ''),
  meta       jsonb            NOT NULL DEFAULT '{}'::jsonb,
  -- 去重键：去空白、转小写后的正文；太短（< 6 字）时为 NULL，不参与去重。
  dedupe_key text
);
-- 同一可见范围内正文相同只存一条。由数据库保证，多个进程同时写入也不会重复。
CREATE UNIQUE INDEX memories_dedupe_idx ON memories (tenant_id, type, access, dedupe_key);
CREATE INDEX memories_tenant_access_idx ON memories (tenant_id, access);

CREATE TABLE character_state (
  tenant_id    text PRIMARY KEY,
  mood         jsonb       NOT NULL,
  last_tick_at timestamptz,
  created_at   timestamptz NOT NULL
);

CREATE TABLE interests (
  tenant_id  text             NOT NULL,
  topic      text             NOT NULL,
  weight     double precision NOT NULL CHECK (weight >= 0 AND weight <= 1),
  updated_at timestamptz      NOT NULL,
  PRIMARY KEY (tenant_id, topic)
);

CREATE TABLE relationships (
  tenant_id    text             NOT NULL,
  peer_key     text             NOT NULL,
  name         text,
  first_seen   timestamptz      NOT NULL,
  last_seen    timestamptz      NOT NULL,
  interactions integer          NOT NULL,
  sentiment    double precision NOT NULL CHECK (sentiment >= -1 AND sentiment <= 1),
  notes        jsonb            NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (tenant_id, peer_key)
);
