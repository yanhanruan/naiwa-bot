# 部署与运维

奶蛙在这台 Mac 上用 Docker 跑：数据库、奶蛙、每日备份、提醒四个服务都在仓库的 `docker-compose.yml` 里，SnowLuma（QQ）在它自己的目录里。设计见 [Module 10 设计稿](module-10-deploy-design.md)。

下面的命令都在部署目录（主工作区 `naiwa-bot/`）里跑。

## 1. 新环境从零启动

每一步后面写着“看到什么算成功”。

1. **装 Docker，拉好镜像**（自己拉，不用镜像加速站）：`postgres:18-alpine`、`node:22-alpine`，和 SnowLuma 固定的那个版本（见 `deploy/snowluma/docker-compose.yml` 里的 `image:`）。
   成功：`docker images` 里三个都有。
2. **起 SnowLuma，扫码登录 QQ 小号**：
   ```bash
   mkdir -p ~/snowluma && cp deploy/snowluma/docker-compose.yml ~/snowluma/ && cd ~/snowluma && docker compose up -d
   ```
   浏览器开 `http://127.0.0.1:6081` 扫码；在 `http://127.0.0.1:5099`（WebUI）里拿到 OneBot WebSocket 的 token。
   成功：`docker network ls` 里有 `snowluma_default`；WebUI 显示 QQ 已登录。
3. **写 `.env`**：`cp .env.example .env`，填 `DEEPSEEK_API_KEY`、`ONEBOT_TOKEN`、`POSTGRES_PASSWORD` 和 `DATABASE_URL`（同一个密码）、`LOG_DIR`（写成本目录下 `logs` 的绝对路径）、`ALERT_QQ`（你的主号）、`ALERT_BARK_URL`（第 5 节）。
   成功：`docker compose config --quiet` 不报错。
4. **先只起数据库、建表**：
   ```bash
   docker compose up -d --wait db
   ```
   ```bash
   npm ci && npm run db:migrate
   ```
   成功：打印出跑了哪些迁移。
5. **在奶蛙连 QQ 之前先设好运营设置**。新库默认所有群都“说话”、每日上限 20 元、没有不理的人；不先设好，奶蛙一连上就会在所有群里说话：
   ```bash
   npm run naiwa -- group default at
   ```
   （`on` 说话 / `at` 只回 @ / `off` 不说话）再按需要 `npm run naiwa -- group <群号> on`、`npm run naiwa -- ignore add <QQ 号>`、`npm run naiwa -- budget set <元>`。
   成功：`npm run naiwa -- groups` 和 `npm run naiwa -- status` 里看到的就是你要的。
6. **起全部服务**：
   ```bash
   npm run deploy
   ```
   （第一次会构建奶蛙的镜像，带上当前的提交号；之后更新代码也用这条，没变的服务不会重启。）
   成功：`docker compose ps` 里 db、bot、alert、backup 都是 running。
7. **看状态**：`npm run trace`。
   成功：第一行是“现在：奶蛙在跑（… 启动，版本 xxxxxxx） · 连着 SnowLuma · QQ 小号在线”；“最近一次备份”是几分钟前、可以恢复。
8. **真聊一句**：用主号私聊奶蛙一句，它回了；`npm run trace -- 私聊 <主号>` 能看到这一句“私聊 → 发出 ✓”。

## 2. 平时怎么切换

| 场景 | 怎么做 |
| --- | --- |
| 正式运行 | `docker compose up -d` |
| 更新代码 | main 上 `git pull`，然后 `npm run deploy`（重建镜像、带上提交号；只重启有变化的服务） |
| 冒烟检查某个分支 | `docker compose stop bot` → 在那个工作区里 `npm run bot`（`.env` 用主工作区的：`node --env-file=../naiwa-bot/.env bin/fish-bot.mjs`）→ 测完 Ctrl-C → `docker compose start bot` |
| 看奶蛙现在怎么样 | `npm run trace`，或者 `npm run naiwa -- status` |
| 奶蛙停着时查日志 | `npm run trace …` 照常能用；没装 Node 的机器：`docker compose run --rm --no-deps bot node scripts/trace.mjs …` |
| 误开了两个奶蛙 | 后开的那个拿不到运行锁，直接拒绝启动 |

`docker compose stop`、Ctrl-C 是正常退出：奶蛙会记下“正常退出”，不会被 Docker 拉起来，提醒服务也不打扰你。崩了、被杀、数据库断开退出才会被自动拉起（提醒服务在它 5 分钟还没回来时通知你）。

## 3. 查卡在哪

```bash
npm run trace -- 群 <群号> QQ <号码> 14:05
```

- 第一行“现在”：奶蛙此刻在不在跑、连没连着 SnowLuma、QQ 小号在不在线、跑的哪个版本。
- “当时”：那段时间开始时的状态，和期间的掉线、恢复、启动、退出。
- 下面是他说的每一句走到了哪一步：没叫奶蛙、群设成了不说话、模型不回、花费上限、余额不足、发送失败……
- 日期可以写“昨天”“前天”“11-25”，时间前后各看 10 分钟；只写日期看一整天；都不写看最近 30 分钟。不写 QQ 就是整个群。
- `npm run trace` 不带参数：现在的状态、最近 1 小时的量、出过什么问题、最近一次备份。
- `npm run trace -- <messageKey>`：一条消息的全部日志原样列出来（排查用）。

日志在 `logs/`，每天一个文件，留 14 天，只有本人能读；记的是标识、耗时和结果，**不记聊天内容、昵称、token**，但记了 QQ 号和群号。

## 4. 备份和恢复

- **每日备份**：`backup` 服务每天北京时间 4 点备份到 `backups/`，留 7 天；Mac 那时关着的话，下次开机马上补一份。每次备份完做一次恢复演练。
- **手动备份**：`scripts/backup.sh`。
- **恢复演练**（不停奶蛙，不碰线上库）：`scripts/restore-drill.sh [备份文件]`，不写文件就用最新的。打印“可以恢复：迁移到 008，原话 … 行，事实 … 条，代号 … 个”。
- **真恢复**（覆盖线上库）：
  ```bash
  docker compose stop bot alert
  ```
  ```bash
  scripts/restore.sh backups/<文件> --yes
  ```
  ```bash
  docker compose start bot alert
  ```
  奶蛙没停会拒绝；恢复前先自动备份当前库；这份备份之后按人删除过的人，恢复完要对他们重新 `npm run naiwa -- forget-person`。

按人删除不去翻日志和备份：日志里没有聊天内容、14 天到期，备份 7 天到期。

## 5. 提醒

`alert` 服务每 5 分钟查一次，有问题就 QQ 私聊 `ALERT_QQ`、用 Bark 推到手机；同一件事只说一次，好了再说一声。

| 什么事 | 什么时候说 |
| --- | --- |
| QQ 小号离线 / SnowLuma 没响应 | 持续 5 分钟 |
| 奶蛙在跑但连不上 SnowLuma | 持续 5 分钟 |
| 奶蛙意外停了（不是用命令停的） | 持续 5 分钟 |
| 连不上数据库 | 持续 5 分钟 |
| 超过一天半没有新备份 / 最近的恢复演练失败 | 马上 |
| 今天的花费到了上限 | 马上（零点自动恢复） |
| DeepSeek 余额低于 ¥50（`ALERT_BALANCE_CNY`）/ 用完了 | 马上 |

- **Bark**：iPhone 上装 Bark App，App 首页显示的推送地址整个贴进 `.env` 的 `ALERT_BARK_URL`，然后 `docker compose up -d alert`。
- **试一下两路通不通**：
  ```bash
  docker compose exec alert node scripts/alert-check.mjs --test
  ```
- QQ 小号掉线时 QQ 那一路发不出去，靠 Bark。
- Docker Desktop 没开、Mac 睡眠时没有提醒；醒来以后 trace 会显示“这段时间没有记录”。
- 提醒的话里没有群号、QQ 号和聊天内容。发没发出去记在 `logs/alert-*.jsonl`，提醒状态在 `logs/alert-state.json`。

## 6. 演练清单

上线前按这张表在这台 Mac 上走一遍，每一步用 `npm run trace` 看结果。

| 验什么 | 怎么做 | 看到什么算过 |
| --- | --- | --- |
| 新环境能起来 | 把仓库克隆到一个新目录，`.env` 里**第一行写 `COMPOSE_PROJECT_NAME=naiwa-fresh`**（不然 `npm run deploy` 会动到线上的 `naiwa-bot`），再换数据库密码、`POSTGRES_PORT`，`BOT_ONEBOT_WS`、`ALERT_ONEBOT_WS` 指向一个不存在的地址（不能连真 SnowLuma，否则会有两个奶蛙在群里说话），照第 1 节做到第 7 步 | 迁移跑完、设置生效、四个服务都起来，奶蛙一直在重连；trace 显示“连不上 SnowLuma”、已经有一份备份并演练过。演练完 `docker compose down -v`（在那个目录里），删掉目录 |
| 切到容器 | 停掉手动跑的那个，`docker compose up -d` | trace 显示在跑、连着；QQ 里私聊和群里 @ 各回一次 |
| 重启奶蛙 | `docker compose restart bot` | 十几秒内重新连上 |
| 奶蛙崩了 | `docker compose exec bot pkill -9 node` | 自己起来；trace 的“当时”里有“意外退出”“启动” |
| 数据库重启 | `docker compose restart db` | 奶蛙退出又自己起来；trace 里有“因数据库断开退出” |
| 两个奶蛙 | 容器在跑时在工作区里 `npm run bot` | 拒绝启动 |
| Docker 重启 | 重启 Docker Desktop | 四个服务都自己起来 |
| 停着也能查 | 群里 @ 奶蛙一次；`docker compose stop bot db`；`npm run trace -- 群 <测试群>` 和 `docker compose run --rm --no-deps bot node scripts/trace.mjs 群 <测试群>` | 都显示停机前那条消息和“正常退出”，“现在”说数据库连不上。然后 `docker compose start db bot` |
| 备份能恢复 | `scripts/restore-drill.sh` | 打印“可以恢复”和行数 |
| 真恢复 | 停奶蛙 → 备份 → `npm run naiwa -- fact-forget <编号>` 删一条测试事实 → 恢复 → 那条回来了 → 启动，QQ 里回一次 | 都对上 |
| 查卡在哪 | QQ 里：不叫它说一句、@ 它、只 @ 不说话；`naiwa group <测试群> off` 以后再 @ 一次，最后改回来 | trace 的说法和实际一致 |
| 主动停机不打扰 | `docker compose stop bot`，等 6 分钟，`docker compose start bot` | 没收到任何提醒 |
| 意外停机才通知 | `docker compose stop bot`，在工作区里 `npm run bot`，连上以后 `kill -9` 它，等 6 分钟，`docker compose start bot` | 收到“意外停了”和“又跑起来了”，QQ 和手机各两条 |
| 连不上 SnowLuma | `.env` 里临时加 `BOT_ONEBOT_WS=ws://snowluma:9`，`docker compose up -d bot`，等 6 分钟，删掉这行再 `up -d bot` | 收到“连不上 SnowLuma”和“又连上了” |
| 小号掉线时手机能收到 | `.env` 里临时加 `ALERT_ONEBOT_WS=ws://snowluma:9`，`docker compose up -d alert`，等 6 分钟，删掉再 `up -d alert` | 手机收到“SnowLuma 没响应”和恢复；日志里 QQ 那一路记了跳过 |
| 余额提醒 | 临时把 `ALERT_BALANCE_CNY` 调到比现在余额还高，`docker compose up -d alert`，过 5 分钟调回去 | 收到“余额只剩 ¥…”，调回去后收到“恢复到 ¥…” |

## 7. 上线那天：清空重来

现在数据库里只有开发测试数据。上线那天把开发期的数据全部删掉，奶蛙从第一天开始。**删掉的找不回。**

1. **先列出来**（什么都不删）：
   ```bash
   scripts/launch-cleanup.sh
   ```
   它会找出和本仓库同一个目录下所有 `naiwa-bot*` 工作区里的 `data/`、`backups/`、`logs/`，每个写着几个文件，再加上数据库卷 `naiwa-bot_naiwa-pg`。2026-11-26 核对时有：主工作区的录制文件、7 个备份文件、旧系统的 JSON 数据，`naiwa-bot-image`、`naiwa-bot-mood` 工作区里冒烟检查的日志。哪一项该有东西却是 0，先停下来查是不是走错了目录。列完给负责的人看过再往下。
2. **停服务**：
   ```bash
   docker compose stop bot alert backup
   ```
3. **删文件和数据库卷**：按第 1 步列出的路径逐个删（`rm -rf <路径>`），然后：
   ```bash
   docker compose down
   ```
   ```bash
   docker volume rm naiwa-bot_naiwa-pg
   ```
4. **起空库、建表**：
   ```bash
   docker compose up -d --wait db
   ```
   ```bash
   npm run db:migrate
   ```
5. **先设好运营设置再连 QQ**：清空数据库也清掉了群开关、不理名单和预算。按正式运营的要求用 `npm run naiwa -- group default …`、`group <群号> …`、`ignore add …`、`budget set …` 设好，`npm run naiwa -- groups`、`status` 看一遍。
6. **起全部服务**：`docker compose up -d`，然后 `npm run trace` 确认在跑、连着、QQ 在线，备份已做。

## 8. 各种数据留多久

| 数据 | 留多久 | 谁删 |
| --- | --- | --- |
| 原话 `conversation_turns` | 7 天 | 奶蛙每天清理 |
| 记得的事 `memory_facts` | 按项目 14 天～1 年 | 奶蛙每天清理 |
| 消息处理记录 `inbound_messages` | 30 天 | 奶蛙每天清理 |
| 花费表 `model_usage`、事件表 `events` | 90 天 | 奶蛙每天清理 |
| 日志文件 `logs/` | 14 天（`LOG_KEEP_DAYS`） | 奶蛙每天清理，提醒服务每 5 分钟顺带清 |
| 备份 `backups/` | 7 天（`BACKUP_KEEP_DAYS`） | 备份服务 |
| 录制文件（`ONEBOT_RECORD_FILE`） | 平时不开；开了不过期，用完手动删 | 人 |
