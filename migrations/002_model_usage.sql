-- 002：模型用量账本。按北京时间的日期、会话、模型累计，用来估算每天的花费、执行每日花费上限。
-- 只存计数和金额，不存任何聊天内容。

CREATE TABLE model_usage (
  tenant_id        text             NOT NULL,
  day              date             NOT NULL, -- 北京时间的日期
  conversation_key text             NOT NULL,
  model            text             NOT NULL,
  calls            integer          NOT NULL DEFAULT 0, -- 拿到用量的调用次数
  unknown_calls    integer          NOT NULL DEFAULT 0, -- 超时等拿不到用量的调用，花费按估算计入
  input_tokens     bigint           NOT NULL DEFAULT 0, -- 含缓存命中的部分
  cached_tokens    bigint           NOT NULL DEFAULT 0,
  output_tokens    bigint           NOT NULL DEFAULT 0, -- 含思考消耗的部分
  reasoning_tokens bigint           NOT NULL DEFAULT 0,
  searches         integer          NOT NULL DEFAULT 0,
  fetches          integer          NOT NULL DEFAULT 0,
  cost_cny         double precision NOT NULL DEFAULT 0, -- 按官方价格估算，实际扣费以 DeepSeek 账单为准
  updated_at       timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day, conversation_key, model)
);
