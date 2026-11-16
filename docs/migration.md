# Linux / Docker 迁移准备（Phase 5）

`fish-os` 零外部依赖、纯 ESM，可直接搬 Linux。下面是迁移要点。

## Docker 运行

```bash
cd fish-os
docker compose up -d --build       # 后台长驻
docker compose logs -f fish        # 看日志（心跳/主动任务）
docker compose exec fish node bin/fish.mjs status   # 查结构化状态
```

- 数据卷 `fish-data` 挂载到容器内 `/data`（即 `FISH_HOME`），容器重建不丢记忆。
- 主动行为默认关闭（最小权限）；需要时 `docker compose exec fish node bin/fish.mjs proactive-on`。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `FISH_HOME` | `~/.fish-os` | 数据目录（记忆/角色状态/事件） |
| `FISH_TICK_MS` | `60000` | 主动调度 tick 间隔（毫秒） |

## 备份与恢复

```bash
FISH_HOME=/path/to/data scripts/backup.sh ./backup.tar.gz
FISH_HOME=/path/to/data scripts/restore.sh ./backup.tar.gz
```

## 日志与监控

- 进程：daemon 打印启动/心跳/主动任务/关闭日志，接入 `journald` 或 docker 日志即可。
- 健康：`fish status` 返回结构化状态（情绪、策略开关、记忆/事件计数、已连平台），可作为健康检查/监控探针。
- 失败降级：平台适配器（如 B站）网络异常会抛错，由调用方（daemon/平台调度）捕获记录，不拖垮主进程。

## 待办（如实标注）

- 小红书、抖音只读接入：两者需要账号/签名/设备指纹，暂未实现；需你本人登录授权后按其官方/合规方式接入。
- QQ 插件随 DSH profile 迁移：`~/.dsh/profiles/<name>` 与 `~/.dsh-qqbot` 一并备份即可；Linux 侧用 CLI 版 `npx @deepseek-ai/dsh --profile qqbot` 运行。
- 建议后续把 fish-os 记忆以 DSH 工具形式（`fish_remember`/`fish_recall`/`fish_state`）注入 QQ 会话，形成「一套核心、多平台共用」的闭环。
