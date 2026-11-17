# Module 3 导读：OneBot 传输层

奶蛙通过 OneBot v11 正向 WebSocket 连接 SnowLuma，收消息、发消息都走这条连接。这个模块把“连接本身”做可靠，业务代码（`src/qq-handler.js`）不需要关心断线、超时和节流。

## 为什么要改

旧客户端只能在一切正常时工作：

| 问题 | 怎么发生的 |
| --- | --- |
| 一帧坏数据就让进程崩溃 | SnowLuma 发来 JSON `null` 时，旧代码读 `data.post_type` 抛错。在 WebSocket 回调里抛出的异常会让 Node 进程直接退出（已用旧代码实测） |
| 请求可能永远挂起 | 请求没有超时。SnowLuma 卡住或响应丢了，等这个响应的消息处理就永远停在那里 |
| 连接“假活” | TCP 没断但对方不再回应时（例如 SnowLuma 卡死），旧代码收不到 close，就一直以为自己在线，实际什么消息都收不到 |
| 被踢后每秒重连 | 旧代码一连上就把重连等待时间重置为 1 秒。如果对方“连上就断开”，就会每秒重连一次 |
| 发得太快有封号风险 | 没有任何发送间隔。几条 @ 同时到达，就会连着发出几条回复 |
| 出了问题不好查 | 日志是零散的句子，没法把同一条消息经历的各个阶段串起来 |

## 现在怎么做

### 1. 一个长期存在的客户端

```js
const client = new OneBotClient({ url, token, logger, onEvent });
client.start();   // 开始连接；之后断线会自动重连，直到 stop()
// ……
client.stop();    // 停止：不再重连，等待中的请求立即结束
```

入口 `bin/fish-bot.mjs` 不再自己写重连循环，只调用 `start()` 和 `stop()`。`client.status()` 返回连接状态、QQ 账号是否在线、等待中的请求数和排队中的发送数。

地址必须以 `ws://` 或 `wss://` 开头，否则创建客户端时就直接报错。地址写错是配置问题，重试多少次也不会好。报错里不回显地址，因为写错的地址里可能带着 token 或密码。

### 2. 断线重连

- 等待时间按 1 秒、2 秒、4 秒……翻倍，最长 30 秒。每次再乘一个 0.5～1 之间的随机系数，避免多个实例同时重连。
- 连接保持 10 秒以上才算“稳定”，之后再断线，等待时间才从 1 秒重新开始。“连上就被踢”的情况下，等待时间会继续增长。

### 3. 超时与“假活”检测

| 时限 | 默认 | 超时后 |
| --- | --- | --- |
| 建立连接 | 10 秒 | 放弃这次连接，按退避时间重连 |
| 请求响应 | 15 秒 | 请求以 `TIMEOUT` 失败（结果未知，见下一节） |
| 收不到任何数据 | 30 秒，或心跳间隔的 1.5 倍（取较大者） | 主动发一个 `get_status` 探测 |
| 探测响应 | 10 秒 | 判定连接假活，主动断开并重连 |

- 心跳、事件、响应都算“收到数据”。
- SnowLuma 每 30 秒发一次心跳（实测），心跳里写明了间隔 `interval: 30000`。客户端按心跳间隔的 1.5 倍放宽阈值，所以连接 SnowLuma 时，是 45 秒收不到数据才探测，心跳稍晚一点不会误探测。连接假活最迟大约 1 分钟会被发现（45 秒 + 检查间隔 + 10 秒探测）。
- 探测即使返回失败（例如不支持 `get_status`），也说明对方还在回应，不会断开。

### 4. 错误分类：消息到底发没发出去

所有请求失败都抛 `OneBotError`。`code` 说明原因，`delivery` 说明消息是否可能已经送达：

| code | 含义 | delivery |
| --- | --- | --- |
| `NOT_CONNECTED` | 发请求时没有连接 | `not_sent`：肯定没发出 |
| `QUEUE_FULL` | 发送队列已满 | `not_sent` |
| `QUEUE_TIMEOUT` | 预计排队太久，放弃 | `not_sent` |
| `ACTION_FAILED` | SnowLuma 明确返回失败 | `not_sent` |
| `TIMEOUT` | 请求发出后没等到响应 | `unknown`：可能已经发出 |
| `CONNECTION_LOST` | 等响应时连接断了 | `unknown` |
| `STOPPED` | 客户端已停止 | 排队中的为 `not_sent`，已发出的为 `unknown` |

为什么要区分：`not_sent` 的消息可以放心重试；`unknown` 的消息重试可能让群友收到两条一样的回复。处理器目前对两种失败都不记录这条回复（发送失败不当成已发生）。重试策略留给 Module 5。

### 5. 发送节流

所有 `send_*` 动作排成一队，按顺序逐条发。上一条有了结果，下一条才开始：

| 规则 | 默认 |
| --- | --- |
| 相邻两条的间隔 | 至少 1.5 秒，再加 0～1 秒随机，避免机械的固定节奏 |
| 每分钟最多 | 20 条 |
| 队列最多 | 20 条，满了直接拒绝 |
| 排队上限 | 预计要等超过 60 秒的直接放弃。聊天回复晚到一分钟已经没有意义，不如明确失败 |

- 查询类动作（`get_status` 等）不排队。
- 断线期间的发送直接失败，不排队等重连。

这些默认值在 `src/adapters/send-throttle.js` 的 `THROTTLE_DEFAULTS` 里。

### 6. 异常数据不崩进程

下面这些情况都只记日志，连接和进程照常运行：

- 坏 JSON、二进制帧、`null` 或数组这类非对象数据；
- 无法识别的数据结构；
- 不对应任何请求的响应（多半是超时后迟到的响应）；
- 事件处理函数同步抛错，或者返回的 Promise 被拒绝。

坏数据可能成批出现，所以日志每 10 秒最多记一条，并带上累计数量。日志不记录数据内容。

### 7. 结构化日志（原属 Module 10，提前）

日志一行一个事件，固定有 `ts`、`level`、`event` 三个字段。在终端里显示成给人看的格式：

```
15:04:29 信息 onebot.connected 已连接 OneBot endpoint=ws://127.0.0.1:3001 reconnects=0
15:04:30 警告 onebot.disconnected OneBot 连接断开 code=1006 lifetimeMs=1504
15:04:30 信息 onebot.reconnect_scheduled delayMs=711 failures=1
```

不在终端里运行时（例如 Docker），输出每行一个 JSON，方便收集和检索：

```json
{"ts":"2026-11-17T07:04:29.000Z","level":"info","event":"message.done","messageKey":"qq:account:…:message:-12345","outcome":"replied","recorded":true,"replyMs":5120,"sendMs":1630,"totalMs":6790}
```

**按 `messageKey` 串起一条消息。** 被处理的每条消息依次记录：

1. `message.accepted`：决定回复；
2. 如果某个阶段失败：`reply.failed`、`send.failed`（带 `delivery`）或 `record.failed`；
3. `message.done`：结果（`replied`、`fallback`、`send_failed`）、是否已记录、各阶段耗时。

传输层的日志（例如 `onebot.request_timeout`、`onebot.send_dropped`）也会带上同一个 `messageKey`。想知道某条消息卡在哪里，按它的 key 搜索日志即可。没叫到奶蛙的群消息只在 `debug` 级别记一条 `message.ignored`。

**日志里不写**：聊天正文、回复内容、昵称、token。只写标识、长度、耗时和结果。

配置方式（写在 `.env` 里）：

- `LOG_LEVEL`：`debug`、`info`（默认）、`warn` 或 `error`；
- `LOG_FORMAT`：`pretty` 或 `json`。不设置时，在终端里用 `pretty`，否则用 `json`。

### 8. token 不外泄

token 只拼进连接地址，日志里看不到：

- 记录地址时只写协议、主机和路径，去掉账号密码和查询参数。
- 错误信息里 `access_token=` 后面的值一律换成 `***`，不管它是怎么编码的；地址里的账号密码也会去掉。
- token 单独出现在错误信息里时，原文和编码后的写法都会换成 `***`。

所以即使把 token 直接写进了 `ONEBOT_WS`（`?access_token=…`），也不会进日志。

## 核实过的 SnowLuma 格式

路线图要求“顺带核实”的几项，结果来自 2026-11-16 到 11-17 录制的 377 条真实事件。只统计了结构，没有看内容：

| 项目 | 结果 |
| --- | --- |
| 心跳 | 每 30 秒一次，带 `interval: 30000` 和 `status: { online, good }`（2026-11-17 实测） |
| `time` | 数字，单位为秒。接收时间与它相差 -0.5～2.4 秒 |
| `message_id` | 数字，有符号 32 位整数，约一半是负数，不按顺序递增。同一会话内没有重复投递 |
| @ 段 | `{ type: 'at', data: { qq: '号码字符串' } }`，没有 `name` |
| 引用段 | `{ type: 'reply', data: { id: '消息号字符串' } }`，能对上之前收到的 `message_id` |
| 其他字段 | 有 `message_seq`、`raw_message`、`font`、`group_name`；`anonymous` 为 `null` |
| 出现过的通知 | `group_msg_emoji_like`、`group_recall`、`group_increase`、`group_decrease`、`bot_status`（`offline`），以及 `lifecycle` 的 `connect`、`enable`、`disable` |

**仍未核实**：`message_id` 在 SnowLuma 重启后是否稳定。录制期间没有出现跨重启的引用。

## 测试

```bash
npm test
```

- `test/onebot.test.js`：用一个真实的 WebSocket 服务端扮演 SnowLuma（开发依赖 `ws`，只在测试里使用）。覆盖以下情况：
  - 正常收发；
  - 返回失败、请求超时、迟到的响应；
  - 断线重连、指数退避、稳定后重置等待时间、“连上就被踢”；
  - token 错误；报错信息带着完整地址时，日志里也看不到 token 和地址里的账号密码；
  - 握手卡住、连接假活、探测返回失败、有心跳时不探测、按心跳间隔放宽阈值；
  - 各种坏数据、事件处理函数出错；
  - 节流、队列满、停止；
  - QQ 账号离线和恢复；
  - 地址无效。
- `test/send-throttle.test.js`：节流规则。
- `test/log.test.js`：日志格式、级别、错误序列化。
- `test/message.test.js`：处理器的日志按 `messageKey` 串联、日志里没有正文和昵称、发送结果未知时不记录。

涉及时间的测试只断言下限（计时器只会晚到，不会早到），并在测试负载很高时也验证过。

## 踩过的坑

Node 22 自带的 WebSocket 在连接被拒绝时，**只触发 `error`，不触发 `close`**，`readyState` 一直停在 `CONNECTING`。所以客户端收到 `error` 就直接放弃这个连接并安排重连，不等 `close`。

## 本模块没做的

- 发送失败后的重试、重复事件去重、消息排队处理（Module 5）。
- 把连接状态接入 `bridge.getStatus()` 或 CLI（Module 9 / 10）。目前可以通过 `client.status()` 和日志查看。
- 反向 WebSocket、HTTP 上报等其他 OneBot 连接方式。
- `message_id` 跨重启稳定性：需要在 SnowLuma 重启前后各引用一次消息来核实。
- 模型调用失败时，`reply.failed` 日志会带上 DeepSeek 返回的错误原文（`src/brain.js` 截取前 160 个字），不完全符合“日志只写标识、长度、耗时和结果”的约定。留给 Module 4（模型调用适配器）处理。
