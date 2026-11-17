-- 003：入站消息记录。每条需要处理（叫到了奶蛙）的消息一行：用来去重，并如实记录处理结果。
-- 只存标识和结果，不存聊天内容。状态的含义见 src/runtime/inbox.js。

CREATE TABLE inbound_messages (
  tenant_id        text        NOT NULL,
  message_key      text        NOT NULL,
  conversation_key text        NOT NULL,
  message_ts       timestamptz NOT NULL, -- 消息本身的时间（OneBot 事件里的 time）
  received_at      timestamptz NOT NULL, -- 奶蛙收到的时间
  status           text        NOT NULL CHECK (status IN (
                     'queued', 'processing', 'replied', 'notice', 'silent', 'send_failed', 'dropped', 'skipped', 'abandoned')),
  outcome          text,                 -- 更细的结果，与日志 message.done 的 outcome 一致
  error_code       text,
  delivery         text,                 -- 发送失败时：not_sent（肯定没发出）或 unknown（可能已发出）
  sent_message_id  text,
  send_attempts    integer     NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, message_key)
);
CREATE INDEX inbound_messages_received_idx ON inbound_messages (tenant_id, received_at);
CREATE INDEX inbound_messages_unfinished_idx ON inbound_messages (tenant_id, status) WHERE status IN ('queued', 'processing');
