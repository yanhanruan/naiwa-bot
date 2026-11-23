# Module 2 导读：PostgreSQL 存储

## 为什么要改

旧存储是三个 JSON 文件（`memory.json`、`events.json`、`character.json`）。每个进程启动时把整份文件读进内存，之后每次改动都把内存里的整份数据写回文件。这带来三个问题：

| 问题 | 怎么发生的 |
| --- | --- |
| 文件损坏时数据被清空 | 读取失败会被当成“没有数据”，接着程序用空数据把文件覆盖掉 |
| 两个进程互相覆盖 | 机器人和 CLI 各有一份内存副本，谁最后写，谁的副本就覆盖整个文件 |
| CLI 删掉的数据被写回来 | CLI 删除了记忆，但运行中的机器人内存里还有，它下次保存就把删掉的数据写回去了 |

## 现在怎么做

**内存里不再保存数据副本。** 每次读写都直接访问 PostgreSQL，所有进程看到的是同一份数据。

### 1. 异步存储接口

数据库访问只能异步，所以涉及存储的方法都改成了 `async`，调用时要 `await`：

```js
const db = await openStorage();                      // 连接 + 执行迁移
const fish = await (await Fish.open({ db })).start();
await fish.remember({ ... });
const records = await fish.recall({ requester: conversationKey });
```

业务代码只依赖 `EventStore`、`MemoryService`、`CharacterCore` 这几个类，不直接写 SQL。

### 2. 并发安全靠数据库，不靠程序自己小心

| 操作 | 做法 | 为什么安全 |
| --- | --- | --- |
| 记忆去重 | 唯一索引 `(tenant_id, type, access, dedupe_key)` + `ON CONFLICT DO NOTHING` | 两个进程同时写同一条，数据库只接受一条 |
| 关系计数、好感度 | 一条 `INSERT … ON CONFLICT DO UPDATE SET interactions = interactions + 1` | 加 1 发生在数据库内部，不会出现“两边都读到 3、都写回 4” |
| 兴趣权重 | 同上，单条 upsert | 同上 |
| 情绪 | 事务内 `SELECT … FOR UPDATE` 锁住那一行，算完再写 | 第二个进程要等第一个提交后才能读 |

### 3. 迁移

表结构放在 `migrations/NNN_说明.sql`，按编号执行。已执行的记录在 `schema_migrations` 表里。

- 程序启动时自动执行尚未执行的迁移；也可以手动执行：`npm run db:migrate`。
- 所有待执行的迁移放在**一个事务**里执行：任何一个失败，都不会留下“改了一半”的表。
- 用 advisory lock 保证同一时刻只有一个进程在执行迁移。
- **已经执行过的迁移文件不能再改。** 要改表结构，就新增一个编号更大的文件。

### 4. 租户

每张表都有 `tenant_id`，目前只有一个默认租户 `default`。以后做多租户时，每个客户一个 `tenant_id`。测试也借用了这一点：每个测试用一个随机租户，测试之间互不影响。

### 5. 启动失败就退出

在下面两种情况下，`openStorage` 会直接抛错，程序退出：

- 没有设置 `DATABASE_URL`，或者连不上数据库；
- 迁移失败。

宁可启动失败，也不以空记忆运行。

## 测试

```bash
npm test
```

- 默认用 **PGlite**：把真正的 PostgreSQL 编译成 WASM，在 Node 进程里运行。不需要 Docker，也不需要任何服务。
- 设置 `TEST_DATABASE_URL` 后，`test/storage.test.js` 会在真实 PostgreSQL 上再跑一遍。PGlite 只有一个连接，没有真正的并发；真实 PostgreSQL 有连接池，这一遍才能验证“两个进程同时写不互相覆盖”。`TEST_DATABASE_URL` 必须指向**专用测试库**。

## 本地运行

1. `.env` 里设置 `POSTGRES_PASSWORD` 和 `DATABASE_URL`（见 `.env.example`）。
2. 启动数据库：`docker compose up -d db`。只监听 `127.0.0.1`，局域网访问不到。
3. 导入旧数据（只需一次，可以重复执行）。**2026-11-18 起导入脚本已删除**（导入早已做完，见[记忆 v2 设计](memory-v2-design.md)第 11 节），下面只作历史记录：

   ```bash
   node scripts/import-json.mjs --from data/naiwa --dry-run   # 先演练，只看报告
   npm run db:import -- --from data/naiwa                      # 正式导入
   ```

   导入的规则：

   - 原 JSON 文件不会被改动，可以作为回滚依据。
   - 文件损坏或有不合法的记录，整个导入不生效。
   - 已导入的记录会跳过。
   - 数据库里已有的角色状态、关系不会被覆盖。
   - 导入后逐条核对数量。

4. 启动机器人：和以前一样，`node --env-file=.env bin/fish-bot.mjs`。

## 备份与恢复

```bash
scripts/backup.sh                             # -> backups/naiwa-pg-<时间>.dump
scripts/restore.sh backups/xxx.dump --yes     # 先停止机器人（没停会拒绝；恢复前自动先备份当前数据库）
```

- 备份用 `pg_dump` 的自定义格式。写完后用 `pg_restore --list` 校验：能读出目录，才算备份成功。
- 备份文件权限只有本人可读，`backups/` 已被 git 忽略。
- 恢复在一个事务里进行，失败不会留下一半数据。

## 旧数据说明

- 49 条 access 为 `self` 的旧情节记忆会原样导入。和以前一样，它们不会被召回：处理器只召回 `self` 类型的自我记忆。是否清理留给 Module 6。
- 以纯数字为键的旧关系记录会原样导入，不会和新格式 `qq:user:<号>` 的记录合并。是否合并留给 Module 6（跨会话认人）。

## 本模块没做的

- 代号改成全局持久（路线图中“Module 2 之后”一项）。
- 审批、策略开关持久化（Module 9）。
- 记忆检索仍是“取出可见记录后在程序里打分”。数据量大了以后，可以改成全文检索或 `pgvector`。
