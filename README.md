# Fish OS — 跨平台数字生命核心

一条可运行、可验证、可继续扩展的数字生命原型。本包是**平台无关的核心**：人格引擎、记忆（带出处的事实）、事件存储、心情、管理命令（设置存数据库、运行中的奶蛙读得到）、Character OS Bridge。平台传输层（QQ 等）通过适配器复用成熟组件接入。

> **当前状态（2026-11）**：本仓库的 QQ bot 是「奶蛙」——SnowLuma(OneBot v11) + DeepSeek Responses API（服务端 web_search）。架构与消息流见 [docs/architecture.md](docs/architecture.md)。

> 纯 ESM，Node ≥ 22.4（用到内置的 WebSocket）。数据存 PostgreSQL（驱动 `pg`）；测试用进程内 PostgreSQL（PGlite）和本地假 OneBot 服务端，`npm test` 不需要启动任何服务。

> **模块改造进度**：见 [路线图](docs/roadmap.md)。Module 1（身份与消息模型）已完成，见 [Module 1 导读](docs/module-01-identity.md)；Module 2（PostgreSQL 存储）见 [Module 2 导读](docs/module-02-storage.md)；Module 3（OneBot 传输层：断线重连、超时、发送节流、结构化日志）见 [Module 3 导读](docs/module-03-onebot.md)；Module 4（模型调用：时限与重试、错误分类、花费估算与每日上限、按会话限速）见 [Module 4 导读](docs/module-04-model.md)；Module 5（消息处理运行时：同一会话逐条处理、去重、发送失败如实记录与补发）见 [Module 5 导读](docs/module-05-runtime.md)；Module 6（上下文与长期记忆：全局代号、重启不丢历史、跨会话认人、私聊不进群）见 [Module 6 导读](docs/module-06-context.md)；记忆重做（v2：后台提炼带出处的事实、按地方取用、按人删除）见 [记忆 v2 设计](docs/memory-v2-design.md)；Module 7（群里什么时候说话：被叫到一定回、像在跟它说话的交给模型判断、群里最近的聊天当上文）见 [Module 7 设计](docs/module-07-group-chat-design.md)。下文部分能力描述来自旧原型，不代表实际 QQ 链路已经完成整合。

## 架构

```
                 ┌──────────────────────────────────────────┐
                 │                Fish（顶层编排）            │
                 ├──────────────────────────────────────────┤
 平台适配器 ────▶ │         reactTo / touch / 事实读取         │
  (QQ / B站/…)   ├───────────────┬───────────────────────────┤
                 │               │                           │
     ┌───────────▼──────┐  ┌─────▼──────┐  ┌───────────────┐
     │ Character Core    │  │ Memory v2   │  │ Event Store   │
     │ 人格·情绪·兴趣·关系 │  │ 带出处的事实 │  │ 统一事件格式   │
     └───────────┬──────┘  └────────────┘  └───────────────┘
                 │
     ┌───────────▼──────────┐  ┌──────────────────┐  ┌────────────────┐
     │ Mood                 │  │ Admin            │  │ Character OS   │
     │ 每日基调 + 日内起伏    │  │ 设置·心跳·fish 命令 │  │ Bridge（结构化）│
     └──────────────────────┘  └──────────────────┘  └────────────────┘
```

核心原则：**人格与记忆只有一套**，各平台只是适配器；平台业务逻辑不写进角色核心。

## 目录

```
naiwa-bot/
├── package.json
├── README.md
├── persona/naiwa.md        # 奶蛙人设（当前）
├── persona/social-rules.md # 聊天行为准则（最高优先级）
├── src/
│   ├── schema.js           # 统一事件/状态格式
│   ├── storage/            # PostgreSQL 连接、迁移执行器、运行锁（持锁写入连接）
│   ├── eventstore.js       # 事件存储
│   ├── character.js        # 人格引擎
│   ├── bridge.js           # Character OS Bridge
│   ├── fish.js             # 顶层编排
│   ├── qq-handler.js       # QQ 消息处理（取事实、调模型、发送、记录）
│   ├── policy.js           # 审批策略（预留，还没接上）
│   ├── scheduler.js        # 主动调度（预留，还没接上）
│   ├── log.js              # 结构化日志
│   ├── admin/
│   │   ├── settings.js       # 设置：每日花费上限、不理的 QQ 号、群开关（存数据库，奶蛙每 5 秒读一次）
│   │   └── status.js         # 运行状态：奶蛙写心跳，naiwa status 读
│   ├── model/
│   │   ├── brain.js          # DeepSeek 调用（时限、重试、检查结果、入账、执行上限）
│   │   ├── errors.js         # 模型调用的错误分类
│   │   ├── pricing.js        # 官方价格表与花费估算
│   │   ├── usage-ledger.js   # 每日用量账本（PostgreSQL）
│   │   └── rate-limiter.js   # 按会话限速
│   ├── runtime/
│   │   ├── conversation-queue.js # 会话队列：同一会话按先后来，不同会话并行
│   │   ├── round-queue.js        # 每个会话的“一轮”：连着发的几句攒在一起看
│   │   ├── participation.js      # 群里什么时候请模型看：明确叫它、开头叫名字、留意 30 秒
│   │   ├── group-context.js      # 群里最近的聊天（只在内存里）
│   │   └── inbox.js              # 入站消息记录：去重、记录每条消息的处理结果
│   ├── context/
│   │   ├── aliases.js        # 全局、持久的代号（u1、u2…）
│   │   ├── history.js        # 短期对话历史（存数据库，重启不丢）
│   │   └── impressions.js    # 对人的印象（规则印象，跟着人走）
│   ├── memory/               # 记忆 v2（见 docs/memory-v2-design.md）
│   │   ├── facts.js          # 事实表：唯一读取入口 inView、写入规则、回复时挑选
│   │   ├── extraction.js     # 提炼的提示词、解析、审核（纯函数）
│   │   ├── extractor.js      # 后台提炼：安静后提炼、进度、失败处理
│   │   ├── forget.js         # 按人删除
│   │   └── place.js          # 会话 key → 地方 key
│   ├── adapters/
│   │   ├── onebot.js         # OneBot v11 客户端（重连、超时、假活探测）
│   │   ├── send-throttle.js  # 发送节流
│   │   ├── onebot-errors.js  # 请求失败的错误分类
│   │   ├── onebot-message.js # OneBot 事件 → 入站消息
│   │   └── bilibili.js       # B站只读适配器（热门/搜索）
│   └── index.js
├── bin/
│   ├── fish-bot.mjs        # QQ 机器人入口（奶蛙）
│   ├── naiwa.mjs           # 管理命令（CLI）
│   └── fish-daemon.mjs     # 长驻进程（主动调度心跳；预留，还没接上）
├── migrations/             # 编号的 SQL 迁移（001_init.sql …）
├── scripts/
│   ├── backup.sh           # pg_dump 备份
│   ├── restore.sh          # pg_restore 恢复（机器人没停会拒绝；恢复前先备份当前数据库）
│   ├── backup-daily.sh     # 每日备份（在 backup 容器里跑）
│   ├── restore-drill.sh    # 恢复演练：恢复进临时库检查，不碰线上库
│   ├── trace.mjs           # 查卡在哪（npm run trace）
│   ├── alert-check.mjs     # 提醒：QQ 私聊 + Bark 推到手机（在 alert 容器里跑）
│   ├── launch-cleanup.sh   # 上线前清理：列出开发期的数据
│   └── eval-memory.mjs     # 提炼效果评测（调用真模型）
├── Dockerfile              # 奶蛙的镜像（bot、alert 服务用）
├── docker-compose.yml      # 数据库 + 奶蛙 + 每日备份 + 提醒
├── deploy/snowluma/        # SnowLuma 的 compose 写法（镜像按摘要固定）
├── docs/
│   ├── deploy.md           # 部署与运维：新环境启动、切换、查卡在哪、备份恢复、提醒、上线清理
│   └── migration.md        # Linux/Docker 迁移（旧，见 deploy.md）
└── test/                   # 验收与回归测试
```

## 部署

奶蛙用 Docker 跑：`npm run deploy` 起数据库、奶蛙、每日备份、提醒四个服务。新环境从零启动、平时怎么切换、出了事怎么查（`npm run trace`）、备份恢复和上线前清理，都见 [部署与运维](docs/deploy.md)。

## 快速开始（CLI）

先准备数据库（详见 [Module 2 导读](docs/module-02-storage.md)）：在 `.env` 里设置 `POSTGRES_PASSWORD` 和 `DATABASE_URL`，然后 `docker compose up -d db`。

```bash
cd naiwa-bot
npm install

# 奶蛙现在怎么样：在不在跑、连没连上 QQ、心情、今天花费、设置
node bin/naiwa.mjs status

# 花费：看今天花了多少；改每日上限（0 表示不限）；回到默认 20 元
node bin/naiwa.mjs budget
node bin/naiwa.mjs budget set 30
node bin/naiwa.mjs budget reset

# 群开关：说话 / 只回 @ / 不说话 / 回到跟着默认；没单独设置的群默认用哪一档
node bin/naiwa.mjs groups
node bin/naiwa.mjs group 200 off
node bin/naiwa.mjs group default on

# 不理的 QQ 号（例如群里别的机器人）
node bin/naiwa.mjs ignore add 123456
node bin/naiwa.mjs ignore remove 123456

# 查看奶蛙记得的事（关于某人或出自某个群），含出处原话
node bin/naiwa.mjs facts qq:user:101
node bin/naiwa.mjs facts qq:group:200
node bin/naiwa.mjs fact-forget <编号>

# 删除某人的数据：先停机器人；不加 --yes 只预览条数
node bin/naiwa.mjs forget-person qq:user:101 --yes

# B站只读内容获取（真实拉取，无写操作）
node bin/naiwa.mjs browse bilibili popular 5
node bin/naiwa.mjs browse bilibili search 鲸鱼 5
```

改设置的命令写进数据库，正在跑的奶蛙每 5 秒读一次；命令会等它读到（最多 10 秒），告诉你几秒后生效，奶蛙没在跑就说下次启动时生效。见 [Module 9 设计稿](docs/module-09-admin-design.md)。

命令通过 `DATABASE_URL` 连接 PostgreSQL（`npm run naiwa -- status` 会自动读取 `.env`）。连不上数据库时直接报错退出。

## API

```js
import { Fish } from './src/index.js';

import { openStorage } from './src/storage/index.js';

const db = await openStorage({ databaseUrl: process.env.DATABASE_URL }); // 连接并执行迁移
const fish = await (await Fish.open({ db, name: '奶蛙', persona: { core: '...' } })).start();

// 涉及存储的方法都是异步的
await fish.reactTo({ platform: 'qq', kind: 'message.received', actor: 'peerA', payload: { text: 'hi', sentiment: 'positive' } });
await fish.touch('peerA', { name: '小明' });
await fish.bridge.getCharacterState();   // 结构化角色状态
await db.close();
```

## 统一事件格式

每条事件：`{ id, ts, platform, kind, actor, target, payload, privacy, meta }`。所有平台入站消息先转成该格式再进入核心，保证跨平台一致。

## 记忆与隐私

见 [记忆 v2 设计](docs/memory-v2-design.md)：

- 聊天原话（`conversation_turns`）谁也不改，7 天后删除；
- 后台用便宜模型从原话里提炼短事实，分 4 个项目（称呼、个人情况、近况、群事），每条带出处原话；程序审核：出处必须是本人的话，奶蛙的话不能当出处；
- 回复时只经 `FactStore.inView(地方, 涉及的人)` 读：这个群或私聊的事实，加上涉及的人在群里说的称呼。私聊来的事实永远不进群；
- 到期自动删除（称呼、个人情况 1 年，近况 14 天，群事 30 天，从说出时算起）；运维可以查看、删单条、按人删除。

## 审批（预留）

奶蛙现在只会回复，还没有发布、私信、主动说话这些动作。下面这些先预留着，以后有这些动作时接上（审批记录、开关到时存进数据库）：

- `read` / `reply`：允许
- `publish` / `dm`：默认**需逐次审批**（最小权限）
- `proactive`：受「主动行为总开关」控制（默认关闭）

现在的 `naiwa act`、`naiwa approve`、`naiwa proactive-on` 不会真的发出去，批准记录和开关只在那条命令里，命令结束就没了。

## 测试

```bash
npm test        # 执行 test/*.test.js（核心测试 + 模块回归测试）
```

覆盖验收项：① 连续人格稳定 ② 重启恢复角色状态 ⑤ 统一事件结构 ⑥ 未经批准不发布/私信（预留的审批）⑧ Bridge 结构化状态，外加关系记忆、主动开关（预留），以及存储层的并发写入、租户隔离和迁移回滚。

管理命令的测试（`test/admin.test.js` 和 `test/group-chat.test.js` 末尾）覆盖设置的读写和校验、几条命令同时改不覆盖、在跑 / 正常退出 / 没响应、改完等奶蛙读到、读设置失败继续用旧值、群开关三档、不理的号随时加减、模型在想时关掉群不发、调低花费上限马上拦，见 [Module 9 设计稿](docs/module-09-admin-design.md) 第 9 节。

设置 `TEST_DATABASE_URL`（指向一个**专用的测试数据库**）时，存储测试还会在真实 PostgreSQL 上再跑一遍，验证多连接并发；运行锁、断开持锁连接后不写回这些测试只在真实 PostgreSQL 上跑。

记忆的测试覆盖审核规则、私聊不进群、群里称呼各群通用、换称呼按说出时间、并发写称呼、安静后提炼与进度、失败跳过与花费上限、按说出时间到期、按人删除和运行锁，见 [记忆 v2 设计](docs/memory-v2-design.md) 第 14 节。提炼效果用 `npm run eval:memory` 调真模型评测（约 20 段虚构对话，一次不到 ¥0.01）。

群里什么时候说话的测试覆盖每种情况的判断、只 @ 不说话时等待的各种先后顺序（用假计时器）、`[不回复]` 什么都不发、防刷屏、引用原消息、群里最近的聊天的条数和字数上限，见 [Module 7 设计](docs/module-07-group-chat-design.md) 第 11 节。效果用 `npm run eval:participation` 调真模型评测（24 段虚构对话，其中 5 段查“听懂没有”、1 段查“记不记得 14 条以前自己说的话”，一次约 ¥0.2～0.3）。连着发的一起看、两个人同时问、留意 30 秒、只 @ 不说话这些要按时间先后来的，用 `npm run sim:group` 按真实时间间隔模拟两个群友自动跑一遍（真模型，约 1 分钟、¥0.1 以内），见 [Module 7 补充设计](docs/module-07b-burst-merge-design.md)。

看懂图片、小黄脸、引用带原文的测试覆盖挑哪些图（这一轮里的、引用的、叫奶蛙之前 1 分钟内自己发的）、一轮最多 3 张、下载只认 QQ 的图片服务器、引用先核对来源、查引用和看图共用 20 秒到点取消、图片审核拦下时退回“[图片]”，见 [看懂图片设计](docs/image-understanding-design.md) 第 11 节。效果用 `node scripts/make-eval-images.mjs` 画好测试图（不用群友的图）后，`npm run eval:images` 调真模型评测（一次约 ¥0.2）。

OneBot 传输层的测试用一个本地 WebSocket 服务端（开发依赖 `ws`）扮演 SnowLuma，覆盖断线重连、超时、假活、坏数据和发送节流，见 [Module 3 导读](docs/module-03-onebot.md)。

模型调用的测试用一个本地 HTTP 服务扮演 DeepSeek，覆盖空回复、截断、内容过滤、限流、超时、各类错误，以及每日花费上限和按会话限速，见 [Module 4 导读](docs/module-04-model.md)。

消息处理运行时的测试覆盖连续消息看得到前文、重复消息只回复一次（含重启后）、太旧的消息不回复、排队上限、发送失败的重试与不重试、退出时等待，见 [Module 5 导读](docs/module-05-runtime.md)。

部署与可观测性的测试（`test/ops.test.js`）覆盖日志文件按北京时间分天、权限和到期删除；trace 把各种结果翻对、按日期查、查不到时分清掉线 / 断开 / 停着 / 没记录 / 超过 14 天；提醒只说一次、好了再说、主动停机不提醒、意外停机才提醒；花费表、事件表 90 天清理，见 [Module 10 设计稿](docs/module-10-deploy-design.md) 第 7 节。每日备份和恢复演练脚本在临时的 PostgreSQL 容器里试过。

上下文与长期记忆的测试覆盖重启后记得对话、跨群认人且印象一致、群里的具体事不跨群、私聊内容永远不进群、相同内容属于不同的人、全局代号并发分配不重号，见 [Module 6 导读](docs/module-06-context.md)。

## 诚实的状态标注

- ✅ 已实现并测试：人格引擎、统一事件格式、Character OS Bridge。审批门控、主动调度总开关预留着，还没接到真正的动作上。
- ✅ 部署与可观测性（Module 10）：docker compose 一条命令起来、崩了自己回来；日志每天一个文件留 14 天，`npm run trace` 查一句话走到了哪一步和当时的状态；每天自动备份留 7 天、备份完做恢复演练；出问题 QQ 私聊加 Bark 推到手机。见 [部署与运维](docs/deploy.md)。
- ✅ 管理命令（Module 9）：每日花费上限、不理的 QQ 号、每个群说话 / 只回 @ / 不说话存在数据库里，用 `naiwa` 命令改，奶蛙每 5 秒读一次，不用重启；`naiwa status` 看的是正在跑的奶蛙（心跳）。
- ✅ 群里什么时候说话（Module 7 和补充 7b）：明确叫它的（@、引用它的话）要回；开头叫名字的、叫过或回过 30 秒内的人说的话交给模型判断，判断不回就一个字都不发；连着发的几句等他停 7 秒一起看，一次可以分别回几个人；只 @ 不说话先等 8 秒，没说话回“干嘛蛙”；群里最近的聊天只在内存里当上文；同一个人回得太多暂时不理，可配置不理的 QQ 号。
- ✅ 记忆 v2：后台提炼带出处的事实、按地方取用（私聊不进群）、按说出时间到期、按人删除、运行锁（同一时间只有一个机器人，删除时机器人必须停）。
- ✅ QQ 传输层：OneBot v11 正向 WebSocket 连接 SnowLuma，断线自动重连、请求超时、假活探测、发送节流、结构化日志（Module 3）。
- ✅ 模型调用：DeepSeek Responses API，一次回复 60 秒内必有结果、最多两次尝试、错误分类、按官方价格估算花费、每日花费上限、按会话限速（Module 4）。
- ✅ 消息处理运行时：同一会话把要看的几句攒成一轮一起看、同时只有一轮在看，不同会话并行，重复消息只处理一次，太旧的消息不回复，发送失败如实记录、没连上时重连后补发，退出时等手上的消息处理完（Module 5，7b 起改为按“一轮”看）。
- ✅ 上下文与长期记忆：全局持久代号、短期历史存数据库（24 小时内当上文）、规则印象跟着人走（群里只按群聊算）、具体事件只在原会话、私聊永远不进群、`self` 不再能看全部记录（Module 6）。
- ✅ B站只读内容获取（Phase 2 之一）：热门 + 搜索真实拉取，转成统一 `content.read` 事件。
- ✅ 存储：PostgreSQL + 编号迁移 + pg_dump 备份/恢复（Module 2）。
- ⬜ 尚未接通：小红书/抖音只读（需账号/签名授权）、按意思检索事实（事实多到放不下时再做，见记忆 v2 设计第 15 节）。
