# Linux / Docker 迁移准备（Phase 5）

`fish-os` 零外部依赖、纯 ESM，可直接搬 Linux。下面是迁移要点。

## Docker 运行

```bash
cd naiwa-bot
docker compose up -d db                      # PostgreSQL（只监听 127.0.0.1）
docker compose --profile daemon up -d --build fish   # 可选：主动行为守护进程
docker compose logs -f fish
```

- 数据在命名卷 `naiwa-pg`（PostgreSQL 数据目录），容器重建不丢数据。
- 主动行为默认关闭（最小权限）。完整的容器化部署属于 Module 10。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `DATABASE_URL` | 无（必填） | PostgreSQL 连接串 |
| `POSTGRES_PASSWORD` | 无（必填） | compose 初始化数据库用的密码 |
| `FISH_TICK_MS` | `60000` | 主动调度 tick 间隔（毫秒） |

## 备份与恢复

```bash
scripts/backup.sh                       # -> backups/naiwa-pg-<时间>.dump（已被 git 忽略）
scripts/restore.sh backups/xxx.dump --yes   # 先停止机器人再恢复
```

## 日志与监控

- 进程：daemon 打印启动/心跳/主动任务/关闭日志，接入 `journald` 或 docker 日志即可。
- QQ 机器人（`bin/fish-bot.mjs`）输出结构化日志：在终端里是给人看的格式，在 Docker 等非终端环境里是每行一个 JSON，可用 `LOG_FORMAT` 强制指定。用 `LOG_LEVEL=debug` 能看到被忽略的消息和发送排队等待。按 `messageKey` 搜索，可以串起一条消息的完整处理过程。日志不含聊天正文。
- 健康：`fish status` 返回结构化状态（情绪、策略开关、记忆/事件计数、已连平台），可作为健康检查/监控探针。
- 失败降级：平台适配器（如 B站）网络异常会抛错，由调用方（daemon/平台调度）捕获记录，不拖垮主进程。

## 待办（如实标注）

- 小红书、抖音只读接入：两者需要账号/签名/设备指纹，暂未实现；需你本人登录授权后按其官方/合规方式接入。
- QQ 插件随 DSH profile 迁移：`~/.dsh/profiles/<name>` 与 `~/.dsh-qqbot` 一并备份即可；Linux 侧用 CLI 版 `npx @deepseek-ai/dsh --profile qqbot` 运行。
- 记忆已改为后台提炼带出处的事实、回复时按地方取用（见 [记忆 v2 设计](memory-v2-design.md)）。
