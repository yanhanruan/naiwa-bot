-- 008：管理命令（见 docs/module-09-admin-design.md）。
-- 只加表，不动旧表：旧代码的奶蛙在跑时执行这个迁移也没有影响。

-- 1. 设置：一项一行，用 fish 命令改；没有这一行就用默认值（src/admin/settings.js）。
--    key：daily_budget_cny（数字）、ignore_qq（QQ 号字符串的数组）、group_default、group:qq:group:200（'on' | 'at' | 'off'）。
CREATE TABLE bot_settings (
  tenant_id  text        NOT NULL,
  key        text        NOT NULL,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- 2. 运行状态：每个租户一行，由奶蛙自己写（src/admin/status.js），naiwa status 和掉线提醒读。
--    只有时间和状态，不存聊天内容、不存 QQ 号。
CREATE TABLE bot_status (
  tenant_id        text        PRIMARY KEY,
  started_at       timestamptz NOT NULL,
  heartbeat_at     timestamptz NOT NULL, -- 每 5 秒写一次（数据库时钟）
  stopped_at       timestamptz,          -- 正常退出时写；启动时清空
  pid              integer,
  code_dir         text,                 -- 从哪个目录跑的
  code_branch      text,
  code_commit      text,
  onebot_connected boolean     NOT NULL DEFAULT false,
  onebot_since     timestamptz,          -- 连上或断开的时间
  last_message_at  timestamptz,          -- 最后收到一条消息
  last_reply_at    timestamptz,          -- 最后发出一条
  settings_read_at timestamptz           -- 最后一次读到设置（数据库时钟）
);
