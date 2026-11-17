# Module 4 导读：模型调用适配器

奶蛙每回复一条消息，都要调用一次 DeepSeek。这个模块把“调用模型”这件事做得可预期：多久一定有结果、什么错误会重试、群友看到什么，以及每天最多花多少钱。代码在 `src/model/`，处理器（`src/qq-handler.js`）只会拿到一段可以发出的文字，或者一个说明原因的 `ModelError`。

## 为什么要改

| 问题 | 怎么发生的 |
| --- | --- |
| 最坏要等 3 分钟以上 | 每次调用最多等 60 秒，失败后按“搜索、搜索、不搜索”最多试 3 次，最坏 180 多秒才放弃。群友早以为奶蛙掉线了 |
| 空回复用“？”占位 | 模型没给出内容时，处理器发一个“？” |
| 只看 HTTP 状态码 | DeepSeek 生成失败时 HTTP 照样返回 200，只在 `status` 里写 `failed`；被截断、被内容过滤时 `status` 是 `incomplete`。旧代码不看这个字段 |
| 错误原文进日志 | 报错时把 DeepSeek 返回内容的前 160 个字放进错误信息，日志里就有了对方的原文，可能带着输入片段 |
| 花费没有上限 | 没记录用了多少，也没法限制。有人连续刷 @，或者程序出错循环调用，都会一直花钱 |

## 现在怎么做

### 1. 一次回复的时限和重试

| 时限 | 默认 |
| --- | --- |
| 一次回复（含重试）的总时限 | 60 秒 |
| 第一次尝试最多等 | 45 秒，剩下的留给第二次 |
| 剩余时间少于这个就不再试 | 5 秒 |

- 最多尝试两次。第一次按配置来（默认联网搜索、开启思考）；**第二次不搜索、不思考**（`reasoning: { effort: "none" }`），最快也最省，最有可能在剩余时间里答完。实测这样一次调用 2.7 秒，花费约 0.0002 元。
- 只有“换一次可能成功”的错误才重试，见下一节的表。被限流（429）后等 3 秒再试；服务端错误、网络错误等 1 秒；超时、空回复、数据无法识别马上再试。
- DeepSeek 排队时会先发一串空行，再发 JSON。解析时会忽略开头的空白。

### 2. 错误分类

所有失败都抛 `ModelError`（`src/model/errors.js`）。`message` 是固定的中文说明，**不带对方返回的原文**；日志只额外记 HTTP 状态码、对方的错误码（只保留短的安全标识）和 trace id。

| code | 什么情况 | 重试 | 群友看到 |
| --- | --- | --- | --- |
| `TIMEOUT` | 超时，或对方返回 408 | 是 | 通用提示 |
| `NETWORK` | 连不上模型服务 | 是 | 通用提示 |
| `RATE_LIMITED` | 对方限流（429，v4-pro 每个账号最多 500 个并发请求） | 是 | 通用提示 |
| `SERVER_ERROR` | 5xx，或 HTTP 200 但 `status` 为 `failed` | 是 | 通用提示 |
| `BAD_RESPONSE` | 返回内容无法识别 | 是 | 通用提示 |
| `EMPTY` | 没有可以发出的文字 | 是 | 通用提示 |
| `FILTERED` | 模型按内容安全策略拒绝回答 | 否 | 婉拒提示 |
| `AUTH` | 401 / 403，API key 有问题 | 否 | 通用提示 |
| `INSUFFICIENT_BALANCE` | 402，DeepSeek 账户余额不足 | 否 | 通用提示 |
| `BAD_REQUEST` | 400 / 404 / 422 等，请求参数有问题（例如输入超出上下文长度） | 否 | 通用提示 |
| `BUDGET_EXCEEDED` | 今天的花费已达上限（见第 4 节） | 否 | 花费上限提示 |
| `CONVERSATION_RATE_LIMITED` | 这个会话调用太频繁（见第 5 节） | 否 | 限速提示（只提示一次） |

### 3. 检查返回结果

HTTP 200 不代表成功，还要看响应里的 `status`：

- `completed`：取出 `output` 里 `message` 的文字。文字为空就是 `EMPTY`。
- `incomplete`，原因是 `max_output_tokens`：回复被长度上限截断。有文字的话保留到**最后一个完整句子**（例如“第一句。第二句！第三句没说”只发前两句），并记一条 `model.truncated` 警告；完整的部分不到一半，就保留原文、末尾加“…”。一个字都没有（例如长度上限全被思考用掉了）就是 `EMPTY`，会重试。
- `incomplete`，原因是 `content_filter`：`FILTERED`，不重试。
- `failed`：`SERVER_ERROR`，会重试。

处理器也不再用“？”占位：模型给不出文字，就按失败处理，发通用提示。

### 4. 花费估算与每日上限

**估算。** 每次调用只要返回了 `usage`，就按官方人民币价格（`src/model/pricing.js`）算出花费，记进数据库的 `model_usage` 表。生成失败、被截断、被过滤的调用也可能计费，所以有 `usage` 就记。

deepseek-v4-pro 的价格（元，2026-11-17 查阅[官方价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)）：

| | 高峰时段 | 空闲时段 |
| --- | --- | --- |
| 输入（缓存命中），每百万 token | 0.3 | 0.15 |
| 输入（缓存未命中），每百万 token | 9 | 4.5 |
| 输出（含思考），每百万 token | 27 | 13.5 |
| 联网搜索 / 读网页，每次 | 0.005 | 0.005 |

高峰时段是北京时间周一至周五 9:00–12:00、14:00–18:00。官方高峰不含法定节假日，这里不识别节假日，一律按工作日算，节假日会**算得偏高**，不会偏低。

算例（实测的一次带搜索的调用，空闲时段）：输入 6400 个 token，其中缓存命中 2944 个；输出 326 个；搜索 2 次、读网页 1 次。

```
(6400 − 2944) × 4.5 + 2944 × 0.15 + 326 × 13.5 = 20394.6 → 0.0204 元
2 + 1 次 × 0.005 元                              → 0.015 元
合计约 0.035 元
```

可以看到搜索费用占了不小的比例，所以上限按金额而不是 token 数来算。

**拿不到用量的调用。** 超时的请求已经发出，对方可能已经生成完并计费，只是我们拿不到 `usage`。这种调用按当天的平均花费估算（当天还没有记录时按 0.05 元），记为“用量未知的调用”，宁可多算。

**上限。** 每次调用前，先查今天（北京时间）已经花了多少：

- 达到上限（默认 20 元）：不再调用模型，抛 `BUDGET_EXCEEDED`，北京时间零点自动恢复。当天第一次触发时记一条 `model.budget_exceeded` 错误日志，方便运维发现。
- 超过上限的 80%：记一条 `model.budget_warning` 警告，每天一次。

账本存在数据库里，**重启不会清零**。几条消息同时到达时，它们都可能在上限之前通过检查，所以实际花费可能略微超过上限。这是估算，实际扣费以 DeepSeek 账单为准。

**查今天花了多少：**

```bash
docker compose exec db psql -U naiwa -d naiwa -c "SELECT conversation_key, calls, unknown_calls, searches, round(cost_cny::numeric, 4) AS cost_cny FROM model_usage WHERE day = (now() AT TIME ZONE 'Asia/Shanghai')::date ORDER BY cost_cny DESC"
```

### 5. 按会话限速

每个会话（一个群或一个私聊）默认**每分钟最多调用 10 次、每小时最多 120 次**（`src/model/rate-limiter.js`）：

- 超过时不调用模型。这段受限时间里，只有第一次被拒时提示一次，之后静默。
- 被拒绝的请求不计数，所以窗口过了就自动恢复，不会因为一直有人刷而越限越久。
- 只在进程内记录，重启后清零。它是防刷屏用的，防花费失控靠上一节的每日上限。

检查顺序是先查每日上限、再查会话限速：额度用完时，被限速的会话也照样收到额度提示。

### 6. 群友看到什么

模型给不出回复时，奶蛙发固定的提示，**不含任何内部错误信息**。这些提示不是角色的真实回复，不进入对话历史和记忆。文字在 `src/qq-handler.js` 的 `NOTICES` 里，可以直接改：

| 情况 | 提示 | 什么时候发 |
| --- | --- | --- |
| 今天的花费已达上限 | 今天的蛙力用完了，明天再聊 | 每次被叫到都发 |
| 这个会话调用太频繁 | （咕噜…说得太快啦，我歇一会儿再聊） | 每段受限时间只发一次 |
| 模型按内容安全策略拒答 | （这个话题我不太方便聊～） | 每次 |
| 其他失败 | （咕噜…我卡了一下，稍后再试） | 每次 |

### 7. 日志

模型调用的日志和 Module 3 一样带 `messageKey`，可以和这条消息的其他日志串起来：

```
19:11:12 信息 model.done messageKey=… attempts=1 webSearch=true inputTokens=6400 cachedTokens=2944 outputTokens=326 reasoningTokens=152 searches=2 fetches=1 costCny=0.0354 ms=7364 traceId=3e7a…
```

| 事件 | 级别 | 说明 |
| --- | --- | --- |
| `model.done` | 信息 | 成功：尝试了几次、token、搜索次数、这条回复的估算花费、耗时、trace id |
| `model.attempt_failed` | 警告 | 某次尝试失败：错误码、HTTP 状态码、对方的错误码、trace id、是否可重试 |
| `model.attempt` | 调试 | 每次尝试拿到的响应：`status`、截断原因、文字长度、用量 |
| `model.truncated` | 警告 | 回复被长度上限截断 |
| `model.budget_warning` / `model.budget_exceeded` | 警告 / 错误 | 今天的花费超过 80% / 达到上限，每天各一次 |
| `model.rate_limited` | 警告 / 信息 | 会话限速：第一次被拒记警告，之后记信息 |
| `model.usage_record_failed` | 错误 | 用量没能入账，今天的花费会少算 |
| `reply.limited` / `reply.filtered` / `reply.failed` | 信息 / 警告 / 错误 | 处理器层面：触发限制 / 被内容过滤 / 其他失败 |

`message.done` 的 `outcome` 新增了几种取值：`budget_exceeded`、`rate_limited`、`rate_limited_silent`（没有发提示）、`filtered`，并带上 `errorCode`。

`traceId` 来自响应头 `x-ds-trace-id`，向 DeepSeek 反馈问题时提供它就能定位到具体请求。

### 8. 配置

写在 `.env` 里，都有默认值：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MODEL_DAILY_BUDGET_CNY` | `20` | 每日花费上限（元，估算）；`0` 表示不限 |
| `MODEL_RATE_PER_MINUTE` | `10` | 每个会话每分钟最多调用几次；`0` 表示不限 |
| `MODEL_RATE_PER_HOUR` | `120` | 每个会话每小时最多调用几次；`0` 表示不限 |
| `DEEPSEEK_WEB_SEARCH` | 开启 | 设为 `off` 关闭联网搜索 |
| `DEEPSEEK_REASONING_EFFORT` | 模型默认 | 思考强度，例如 `none` 关闭思考（更快、更省） |

数字写错（不是数字或小于 0）时，启动直接报错退出，不会悄悄当成“不限”。

## 实测的 DeepSeek 返回格式（2026-11-17）

文档有几处说法互相矛盾，下面以两次真实调用为准：

| 项目 | 结果 |
| --- | --- |
| 联网搜索工具 | `{ "type": "web_search" }` 在 deepseek-v4-pro 上可用，响应的 `tools` 里会原样回显；`output` 里有 `web_search_call`（`action.type` 为 `search` 或 `open_page`）。另一个工具名 `deepseek_web_search` 是“深度搜索”，搜得更多、读的网页更多，输入 token 多一倍 |
| `usage` | `input_tokens`（含缓存命中）、`input_tokens_details.cached_tokens`、`output_tokens`（含思考）、`output_tokens_details.reasoning_tokens`、`total_tokens`、`server_tool_use.{tool_search, tool_fetch, tool_image_search}`（全为 0 时省略） |
| 思考 | v4-pro 默认开启，`output` 里有 `reasoning` 项；`reasoning: { effort: "none" }` 可以关闭，关闭后 `reasoning_tokens` 为 0 |
| 响应头 | 没有限流相关的头，也没有 `Retry-After`；有 `x-ds-trace-id` |

## 测试

```bash
npm test
```

- `test/model.test.js`：用一个本地 HTTP 服务扮演 DeepSeek，覆盖：
  - 正常返回：请求格式、用量入账、日志里没有正文和 API key；
  - 排队时先收到空行；
  - 空回复、被截断、截断后为空、内容过滤；
  - HTTP 200 但 `status` 为 `failed`；
  - 429、5xx、返回内容无法识别；
  - 鉴权、余额、参数错误不重试，对方返回的原文不进错误信息和日志；
  - 第一次超时后第二次成功、一直不响应、剩余时间不够再试、连不上服务；
  - 每日花费上限（含 80% 警告、第二天恢复）、按会话限速。
- `test/model-cost.test.js`：高峰时段判断、北京时间的日期划分、花费估算、截断处理、限速器的两个窗口，以及用量账本（日期累计、租户隔离、多进程同时记账不丢计数，设置 `TEST_DATABASE_URL` 时也在真实 PostgreSQL 上跑）。
- `test/message.test.js`：处理器在花费上限、会话限速、内容过滤、空回复时发什么，以及调用模型时带上消息 key 和会话 key。

## 本模块没做的

- 发送失败后的重试、消息排队处理（Module 5）。
- 群内按人限速：现在只按会话限速，一个人刷屏会占掉整个群的额度。
- 节假日日历：节假日按工作日估算（偏高）。
- 精确记账：同时到达的几条消息可能一起越过上限；超时的调用只能估算。
- 管理命令查看花费、调整上限（Module 9）。目前用上面的 SQL 查。
- 流式输出。
