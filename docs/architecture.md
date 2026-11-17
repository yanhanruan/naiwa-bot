# 架构与消息流

## 一句话

**QQ 只是线，线那头是 fish-os 里的「奶蛙」：人格 + 记忆 + 联网，靠 DeepSeek Responses API 说话。**

## 消息流（ASCII）

```
[你的 QQ 主号] --私聊/群聊--> [QQ 服务器]
                                  │  扫码登录（QQ 小号）
                                  ▼
┌────────────────────────────────────────────────────────────┐
│ SnowLuma（Docker 容器 · 本机 127.0.0.1）                      │
│   Linux QQ 客户端（Xvfb + noVNC 扫码）                       │
│   Hook 注入 QQ 进程 → 转成 OneBot v11                        │
│   端口：6081 noVNC · 5099 WebUI · 3000 HTTP · 3001 WS        │
└────────────────────────────────────────────────────────────┘
                                  │  OneBot v11 事件（消息）
                                  ▼
┌────────────────────────────────────────────────────────────┐
│ fish-bot.mjs（Node 常驻进程 · 本机）                          │
│   收到消息 → 检索记忆 → 拼 system prompt                     │
│     · 人设      persona/naiwa.md                            │
│     · 社交准则  persona/social-rules.md（最高优先级）         │
│     · 长期记忆  fish-os Memory（隐私隔离）                    │
│     · 当前时间  北京时间（问日期/时间直接答，不搜）            │
│     · 短期历史  每个 peer 最近 6 条（3 轮）                    │
│   → 调 DeepSeek Responses API                               │
│   → 经 OneBot 发回 QQ（排队节流，逐条发送）                  │
│   → 确认发出后写记忆（PostgreSQL）                           │
└────────────────────────────────────────────────────────────┘
                                  │  POST /v1/responses
                                  │  model: deepseek-v4-pro
                                  │  tools: [{type:"web_search"}]
                                  ▼
┌────────────────────────────────────────────────────────────┐
│ DeepSeek API（服务端）                                        │
│   · 推理模型（先想再答）                                       │
│   · web_search 由服务端执行（查梗/查事实，一次请求内完成）      │
└────────────────────────────────────────────────────────────┘
```

## Mermaid

```mermaid
flowchart TD
  A[QQ 用户 / 群友] -->|消息| B[QQ 服务器]
  B -->|扫码登录 QQ 小号| C[SnowLuma<br/>Docker 容器<br/>Linux QQ + Hook → OneBot v11]
  C -->|OneBot v11 WS :3001| D[fish-bot.mjs<br/>Node 常驻进程]
  D -->|拼 system prompt| D
  D -->|POST /v1/responses| E[DeepSeek API<br/>v4-pro + 服务端 web_search]
  E -->|回复| D
  D -->|OneBot 发消息| C
  C -->|回复| A
  D -->|读写| F[(PostgreSQL<br/>memories / events / relationships …)]
```

## 各层职责

| 层 | 角色 | 关键点 |
|---|---|---|
| QQ | 用户入口 | 你用小号登录、主号私聊/群聊 |
| SnowLuma | QQ → OneBot 桥 | Docker 跑 Linux QQ，Hook 注入，暴露 OneBot v11 |
| fish-bot | 数字生命本体 | 收消息、拼人设/记忆/时间/历史、调大脑、写记忆、发回 |
| DeepSeek | 大脑 | Responses API + 服务端 `web_search`（v4-pro 专属） |

## 一条消息的生命周期

1. 你在 QQ 发一句 → QQ 服务器 → SnowLuma 里的 QQ 客户端；
2. SnowLuma Hook 捕获 → 转成 OneBot v11 事件 → WS `:3001` 推给 fish-bot；
3. fish-bot 检索该 peer 可见的记忆 + 拼 system prompt（人设/准则/记忆/时间/历史）；
4. 调 `POST /v1/responses`（v4-pro + 服务端 web_search；模型自决是否搜，搜索在服务端完成）；
5. 拿到回复 → 进入发送节流队列 → 通过 OneBot `send_private_msg` / `send_group_msg` 发回 → 确认发出后写入 PostgreSQL（情节记忆 + 关系）；
6. 失败降级：搜索 500/超时 → 重试 → 退回不搜再答，不把错误抛给用户。

## 传输层（OneBot 客户端）

fish-bot 与 SnowLuma 之间只有一条正向 WebSocket 连接，由 `src/adapters/onebot.js` 维护：

- 断线自动重连：指数退避，1 秒到 30 秒；
- 每个请求都有超时；
- 收不到数据时发 `get_status` 探测，发现假活连接就重连；
- 坏数据只记日志，不会让进程崩溃；
- 所有发送经过节流队列，相邻两条至少间隔 1.5 秒，每分钟最多 20 条。

每条消息的处理过程用 `messageKey` 串在日志里。详见 [Module 3 导读](module-03-onebot.md)。

## 存储

PostgreSQL（`docker compose` 的 `db` 服务，只监听 127.0.0.1），表结构见 `migrations/`：

| 表 | 内容 |
| --- | --- |
| `memories` | 长期记忆（情节/语义/自我…；按 access 隔离，唯一索引去重） |
| `events` | 统一事件（审计/回溯，只追加） |
| `character_state` | 情绪、创建时间 |
| `interests` | 兴趣及权重 |
| `relationships` | 每个人的关系：互动次数、好感度、备注 |

所有表带 `tenant_id`（目前只有 `default`）。详见 [Module 2 导读](module-02-storage.md)。
