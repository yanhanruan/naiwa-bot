# Fish OS — 跨平台数字生命核心

一条可运行、可验证、可继续扩展的数字生命原型。本包是**平台无关的核心**：人格引擎、长期记忆、事件存储、审批策略、主动调度、Character OS Bridge。平台传输层（QQ 等）通过适配器复用成熟组件接入。

> **当前状态（2026-11）**：本仓库的 QQ bot 是「奶蛙」——SnowLuma(OneBot v11) + DeepSeek Responses API（服务端 web_search）。架构与消息流见 [docs/architecture.md](docs/architecture.md)。

> 纯 ESM，Node ≥ 20.3。数据存 PostgreSQL（驱动 `pg`）；测试用进程内 PostgreSQL（PGlite），`npm test` 不需要启动任何服务。

> **模块改造进度**：见 [路线图](docs/roadmap.md)。Module 1（身份与消息模型）已完成，见 [Module 1 导读](docs/module-01-identity.md)；Module 2（PostgreSQL 存储）见 [Module 2 导读](docs/module-02-storage.md)。下文部分能力描述来自旧原型，不代表实际 QQ 链路已经完成整合。

## 架构

```
                 ┌──────────────────────────────────────────┐
                 │                Fish（顶层编排）            │
                 ├──────────────────────────────────────────┤
 平台适配器 ────▶ │ reactTo / remember / recall / touch / act │
  (QQ / B站/…)   ├───────────────┬───────────────────────────┤
                 │               │                           │
     ┌───────────▼──────┐  ┌─────▼──────┐  ┌───────────────┐
     │ Character Core    │  │ Memory Svc  │  │ Event Store   │
     │ 人格·情绪·兴趣·关系 │  │ 长期记忆    │  │ 统一事件格式   │
     └───────────┬──────┘  └────────────┘  └───────────────┘
                 │
     ┌───────────▼──────────┐  ┌──────────────┐  ┌────────────────┐
     │ Policy & Approval    │  │ Scheduler    │  │ Character OS   │
     │ 审批/发布/私信门控     │  │ 主动行为调度  │  │ Bridge（结构化）│
     └──────────────────────┘  └──────────────┘  └────────────────┘
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
│   ├── schema.js           # 统一事件/记忆/状态格式 + 隐私可见性
│   ├── storage/            # PostgreSQL 连接、迁移执行器、旧 JSON 导入
│   ├── eventstore.js       # 事件存储
│   ├── memory.js           # 长期记忆服务
│   ├── character.js        # 人格引擎
│   ├── policy.js           # 审批策略
│   ├── scheduler.js        # 主动调度
│   ├── bridge.js           # Character OS Bridge
│   ├── fish.js             # 顶层编排
│   ├── adapters/
│   │   └── bilibili.js     # B站只读适配器（热门/搜索）
│   └── index.js
├── bin/
│   ├── fish.mjs            # CLI
│   └── fish-daemon.mjs     # 长驻进程（主动调度心跳）
├── migrations/             # 编号的 SQL 迁移（001_init.sql …）
├── scripts/
│   ├── backup.sh           # pg_dump 备份
│   ├── restore.sh          # pg_restore 恢复
│   └── import-json.mjs     # 旧版 JSON 数据导入
├── Dockerfile              # Linux/Docker 镜像
├── docker-compose.yml      # PostgreSQL（db）+ 可选守护进程
├── docs/
│   └── migration.md        # Linux/Docker 迁移
└── test/                   # 验收与回归测试
```

## 快速开始（CLI）

先准备数据库（详见 [Module 2 导读](docs/module-02-storage.md)）：在 `.env` 里设置 `POSTGRES_PASSWORD` 和 `DATABASE_URL`，然后 `docker compose up -d db`。

```bash
cd naiwa-bot
npm install

# 结构化状态（Character OS Bridge）
node bin/fish.mjs status

# 写入记忆
node bin/fish.mjs remember episodic "第一次见面，用户说想养一条会聊天的小鱼"
node bin/fish.mjs remember interest "喜欢聊海洋生物，尤其是鲸鱼"

# 检索记忆
node bin/fish.mjs recall "鲸鱼"

# B站只读内容获取（真实拉取，无写操作）
node bin/fish.mjs browse bilibili popular 5
node bin/fish.mjs browse bilibili search 鲸鱼 5

# 导出 / 删除记忆
node bin/fish.mjs export
node bin/fish.mjs delete

# 发起一次发布意图（默认需审批）
node bin/fish.mjs act publish "想去 B 站发一条动态"
# -> 返回 pendingApprovalId，再 approve
node bin/fish.mjs approve <id>

# 主动行为总开关
node bin/fish.mjs proactive-on   # / proactive-off
```

命令通过 `DATABASE_URL` 连接 PostgreSQL（`npm run fish -- status` 会自动读取 `.env`）。连不上数据库时直接报错退出。

## API

```js
import { Fish, scope } from './src/index.js';

import { openStorage } from './src/storage/index.js';

const db = await openStorage({ databaseUrl: process.env.DATABASE_URL }); // 连接并执行迁移
const fish = await (await Fish.open({ db, name: '奶蛙', persona: { core: '...' } })).start();

// 涉及存储的方法都是异步的
await fish.reactTo({ platform: 'qq', kind: 'message.received', actor: 'peerA', payload: { text: 'hi', sentiment: 'positive' } });
await fish.remember({ type: 'episodic', content: '...', access: 'public', tags: ['x'] });
await fish.remember({ type: 'episodic', content: 'A 的私事', access: scope.private('A'), peers: ['A'] });
await fish.recall({ query: '...', requester: 'A' });   // 自动按隐私隔离
await fish.touch('peerA', { name: '小明', deltaSentiment: 0.2 });
await fish.bridge.act({ type: 'publish', platform: 'bilibili', target: '评论', text: '...' });
await fish.bridge.getStatus();   // 结构化状态
await db.close();
```

## 统一事件格式

每条事件：`{ id, ts, platform, kind, actor, target, payload, privacy, meta }`。所有平台入站消息先转成该格式再进入核心，保证跨平台一致。

## 记忆类型与隐私

- 类型：`episodic`（情节）/ `semantic`（语义）/ `relational`（关系）/ `interest`（兴趣）/ `self`（自我）
- 可见性：`self` / `public` / `private:<peerId>` / `group:<groupId>` / `conversation:<会话key>`（只在该会话可见，QQ 情节记忆使用）
- 支持：检索（重要性+新鲜度+关键词打分）、摘要、去重、遗忘、导出、删除
- **隐私隔离**：`retrieve(requester)` 只返回对该请求者可见的记忆，用户之间互不泄露

## 审批策略

- `read` / `reply`：允许
- `publish` / `dm`：默认**需逐次审批**（最小权限）
- `proactive`：受「主动行为总开关」控制（默认关闭）

## 测试

```bash
npm test        # 执行 test/*.test.js（核心测试 + 模块回归测试）
```

覆盖验收项：① 连续人格稳定 + 情绪变化 ② 重启恢复记忆 ⑤ 统一事件结构 ⑥ 未经批准不发布/私信 ⑦ 记忆导出删除 ⑧ Bridge 结构化状态，外加隐私隔离、去重、关系记忆、主动开关，以及存储层的并发写入、租户隔离、迁移回滚和旧数据导入。

设置 `TEST_DATABASE_URL`（指向一个**专用的测试数据库**）时，存储测试还会在真实 PostgreSQL 上再跑一遍，验证多连接并发。

## 诚实的状态标注

- ✅ 已实现并测试：人格引擎、长期记忆（含隐私隔离/导出/删除）、统一事件格式、审批门控、主动调度总开关、Character OS Bridge。
- ✅ QQ 传输层复用已安装的 `@tencent-connect/dsh-qqbot`（官方 QQ 机器人通道），已实测建过会话。
- ✅ B站只读内容获取（Phase 2 之一）：热门 + 搜索真实拉取，转成统一 `content.read` 事件。
- ✅ 存储：PostgreSQL + 编号迁移 + pg_dump 备份/恢复 + 旧 JSON 导入（Module 2）。
- ⬜ 尚未接通：小红书/抖音只读（需账号/签名授权）、把 fish-os 记忆作为 DSH 工具注入 QQ 会话、LLM 摘要器/向量检索（当前规则检索 + 截断摘要，接口已预留）。
