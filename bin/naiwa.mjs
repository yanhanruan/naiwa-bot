#!/usr/bin/env node
import { Fish, MOOD_LEVELS, moodName } from '../src/index.js';
import { openStorage } from '../src/storage/index.js';
import { acquireRunLock } from '../src/storage/run-lock.js';
import { FactStore, ITEMS } from '../src/memory/facts.js';
import { countPersonData, deletePersonData } from '../src/memory/forget.js';
import { parsePersonKey, placeOf } from '../src/memory/place.js';
import { Settings, SettingsError, GROUP_MODES, SETTING_DEFAULTS } from '../src/admin/settings.js';
import { readStatus, waitForApply, STATUS_DEFAULTS } from '../src/admin/status.js';
import { ModelUsageLedger } from '../src/model/usage-ledger.js';

// CLI 是运维工具。查看事实不按地方隔离，能看到全部；聊天流程只能经 FactStore.inView 读。

function factForOutput(f) {
  return {
    id: f.id,
    item: ITEMS[f.item].label,
    content: f.content,
    about: f.subject,
    place: f.placeKey,
    quote: f.sourceQuote,
    saidAt: f.saidAt.toISOString(),
    expiresAt: f.expiresAt.toISOString(),
  };
}

// 北京时间，例如 11-18 23:20。
function beijingTime(date, { year = false } = {}) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return year ? `${get('year')}-${get('month')}-${get('day')}` : `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

const placeLabel = (f) => (f.placeKind === 'private' ? '私聊' : `群 ${f.placeKey.split(':').pop()}`);
const whoLabel = (f) => (f.item === 'group_event' ? '这个群' : `QQ ${f.subject.split(':').pop()}`);

// 给人看的事实列表。
function printFacts(title, facts) {
  console.log(`${title}：${facts.length ? `共 ${facts.length} 条` : '还没有'}`);
  for (const f of facts) {
    console.log(`  [${f.id}] ${ITEMS[f.item].label}：${f.content}`);
    console.log(`       关于 ${whoLabel(f)} · 出自${placeLabel(f)} · ${beijingTime(f.saidAt)} 说的 · ${beijingTime(f.expiresAt, { year: true })} 删除`);
    console.log(`       原话：“${f.sourceQuote}”`);
  }
}

// 按人删除（docs/memory-v2-design.md 第 8 节）。不加 --yes 只预览条数；加了 --yes 先拿运行锁，拿不到说明机器人还在跑，拒绝。
async function forgetPerson(fish, personKey, yes) {
  if (!parsePersonKey(personKey)) {
    console.error('用法：naiwa forget-person <人的 key，例如 qq:user:101> --yes');
    process.exitCode = 1;
    return;
  }
  const args = { tenantId: fish.tenantId, personKey };
  if (!yes) {
    const counts = await countPersonData(fish.db, args); // 只读，不删
    console.log(JSON.stringify({ preview: counts }, null, 2));
    console.error('以上是将要删除的条数，没有删除任何数据。确认删除：先停掉机器人，再加 --yes 重新执行。');
    process.exitCode = 1;
    return;
  }
  let lock;
  try {
    lock = await acquireRunLock({ databaseUrl: process.env.DATABASE_URL, heartbeatMs: 0 });
  } catch (error) {
    if (error?.code !== 'RUN_LOCK_BUSY') throw error;
    console.error('机器人正在运行（运行锁被占用），拒绝删除：请先停掉机器人，删完再启动。');
    process.exitCode = 1;
    return;
  }
  try {
    const deleted = await lock.transaction((tx) => deletePersonData(tx, args));
    console.log(JSON.stringify({ deleted }, null, 2));
  } finally {
    await lock.close();
  }
}

// —— 管理命令（Module 9，docs/module-09-admin-design.md）——

// 多久以前：10 秒前、3 分钟前、2 小时前；更早的写日期时间。
function agoText(ms) {
  if (ms === null || ms === undefined) return null;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return beijingTime(new Date(Date.now() - ms));
}

// 跑了多久：3 小时 12 分。
function durationText(ms) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} 小时 ${m % 60} 分` : `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

const yuan = (x) => `¥${Number(x.toFixed(2))}`;
const budgetText = (cny) => (cny > 0 ? yuan(cny) : '不限');
const groupIdOf = (placeKey) => placeKey.split(':').pop();

// 会话 key → 群 200 / 私聊 101。
function conversationLabel(key) {
  try {
    const place = placeOf(key);
    return `${place.kind === 'group' ? '群' : '私聊'} ${place.key.split(':').pop()}`;
  } catch {
    return '其他';
  }
}

function settingsSummary(v) {
  const groups = [...v.groups.entries()];
  const of = (mode) => groups.filter(([, g]) => g.mode === mode).map(([key]) => groupIdOf(key));
  const parts = [`群默认 ${GROUP_MODES[v.groupDefault]}`];
  for (const mode of ['on', 'at', 'off']) {
    const ids = of(mode);
    if (ids.length) parts.push(`${GROUP_MODES[mode]}${GROUP_MODES[mode].endsWith('@') ? ' ' : ''}的群 ${ids.length} 个（${ids.join('、')}）`);
  }
  parts.push(`不理的 QQ ${v.ignoreQQ.length} 个`);
  return parts.join('；');
}

// 这个群现在是哪一档（给人看）。
function groupModeText(v, groupId) {
  const own = v.groups.get(`qq:group:${groupId}`);
  return own ? GROUP_MODES[own.mode] : `${GROUP_MODES[v.groupDefault]}，跟着默认`;
}

// 改完设置：等奶蛙读到（最多 10 秒），告诉运维什么时候生效。
async function reportApply(fish, settings) {
  const since = await settings.dbNow();
  const r = await waitForApply(fish.db, since, { tenantId: fish.tenantId });
  if (r.result === 'applied') console.log(`已保存，奶蛙 ${Math.max(1, Math.ceil(r.afterMs / 1000))} 秒后生效。`);
  else if (r.result === 'not_running') console.log('已保存，奶蛙没在跑，下次启动时生效。');
  else console.log(`已保存，但奶蛙 ${STATUS_DEFAULTS.applyWaitMs / 1000} 秒内还没读到，稍后用 naiwa status 看。`);
}

async function showStatus(fish) {
  const settings = new Settings({ db: fish.db, tenantId: fish.tenantId });
  const ledger = new ModelUsageLedger({ db: fish.db, tenantId: fish.tenantId });
  const [st, v, today, m] = await Promise.all([
    readStatus(fish.db, { tenantId: fish.tenantId }), settings.refresh(), ledger.day(), fish.mood.current(),
  ]);
  if (st.state === 'running') {
    console.log(`奶蛙：在跑（${beijingTime(st.startedAt)} 启动，已经跑了 ${durationText(st.dbNow - st.startedAt)}）`);
    const { dir, branch, commit } = st.code;
    console.log(`  代码：${[dir, branch, commit].map((x) => x ?? '未知').join('，')}`);
    const qq = st.onebot.connected
      ? `已连上（${beijingTime(st.onebot.since)} 起）`
      : (st.onebot.since ? `没连上（${beijingTime(st.onebot.since)} 断开）` : '还没连上');
    const received = st.lastMessageAgo === null ? '还没收到消息' : `最后收到消息 ${agoText(st.lastMessageAgo)}`;
    const replied = st.lastReplyAgo === null ? '还没回过' : `最后回复 ${agoText(st.lastReplyAgo)}`;
    console.log(`  QQ：${qq}，${received}，${replied}`);
  } else if (st.state === 'stopped') {
    console.log(`奶蛙：没在跑（${beijingTime(st.stoppedAt)} 正常退出）`);
  } else if (st.state === 'unresponsive') {
    console.log(`奶蛙：没响应（最后一次心跳 ${agoText(st.heartbeatAgo)}，没有正常退出，可能卡住了或者被强行关掉了）`);
  } else {
    console.log('奶蛙：没有记录（Module 9 以后的代码启动时才会写；如果在跑的是旧代码，这里看不到它）');
  }
  console.log(`  心情：今天基调 ${moodName(m.base)}（${m.manual ? '手动改的' : '早上抽的'}），现在 ${moodName(m.level)}`);
  console.log(`  今天花费：${yuan(today.costCny)} / 上限 ${budgetText(v.dailyBudgetCny)}`);
  console.log(`  设置：${settingsSummary(v)}`);
  if (v.problems.length) console.log(`  注意：数据库里这几项设置的值不对，按默认值算：${v.problems.join('、')}`);
}

async function budget(fish, [sub, value]) {
  const settings = new Settings({ db: fish.db, tenantId: fish.tenantId });
  const ledger = new ModelUsageLedger({ db: fish.db, tenantId: fish.tenantId });
  const before = await settings.refresh();
  const spent = (await ledger.day()).costCny;
  if (!sub) {
    const b = await ledger.breakdown();
    const source = before.budgetSetAt ? `${beijingTime(before.budgetSetAt)} 用命令改的` : '默认值';
    console.log(`今天（${b.day.slice(5)}）花了 ${yuan(spent)}，上限 ${budgetText(before.dailyBudgetCny)}（${source}）`);
    if (b.byModel.length) console.log(`  按模型：${b.byModel.map((x) => `${x.model} ${yuan(x.costCny)}（${x.calls} 次）`).join('，')}`);
    if (b.byConversation.length) console.log(`  花得最多的：${b.byConversation.map((x) => `${conversationLabel(x.conversationKey)} ${yuan(x.costCny)}`).join('，')}`);
    return;
  }
  if (sub === 'set') {
    if (value === undefined || value.trim() === '') throw new SettingsError('上限要写数字（元），0 表示不限');
    await settings.setBudget(Number(value));
  } else if (sub === 'reset') {
    await settings.resetBudget();
  } else {
    throw new SettingsError('用法：naiwa budget 看今天的花费；naiwa budget set <元> 改上限（0 表示不限）；naiwa budget reset 回到默认');
  }
  const after = await settings.refresh();
  const now = sub === 'reset' ? `回到默认 ${budgetText(SETTING_DEFAULTS.dailyBudgetCny)}` : budgetText(after.dailyBudgetCny);
  console.log(`每日花费上限：${now}（以前 ${budgetText(before.dailyBudgetCny)}）。今天已经花了 ${yuan(spent)}。`);
  if (after.dailyBudgetCny > 0 && spent >= after.dailyBudgetCny) console.log('已经超过新上限：被叫到时会回“今天的蛙力用完了”，明天恢复。');
  await reportApply(fish, settings);
}

function printGroups(v) {
  const source = v.groupDefaultSetAt ? `${beijingTime(v.groupDefaultSetAt)} 改的` : '默认值';
  console.log(`没单独设置的群：${GROUP_MODES[v.groupDefault]}（${source}）`);
  const groups = [...v.groups.entries()];
  if (!groups.length) {
    console.log('单独设置过的群：没有');
    return;
  }
  console.log('单独设置过的群：');
  for (const [key, g] of groups) console.log(`  群 ${groupIdOf(key)}：${GROUP_MODES[g.mode]}（${beijingTime(g.updatedAt)} 改）`);
}

async function group(fish, [groupId, mode]) {
  const usage = '用法：naiwa group <群号> on|at|off|reset（说话 / 只回 @ / 不说话 / 回到跟着默认）；naiwa group default on|at|off';
  if (!groupId) throw new SettingsError(usage);
  const settings = new Settings({ db: fish.db, tenantId: fish.tenantId });
  const before = await settings.refresh();
  if (groupId === 'default') {
    if (!mode) {
      printGroups(before);
      return;
    }
    await settings.setGroupMode('default', mode);
    const after = await settings.refresh();
    console.log(`没单独设置的群：${GROUP_MODES[after.groupDefault]}（以前：${GROUP_MODES[before.groupDefault]}）`);
    await reportApply(fish, settings);
    return;
  }
  if (!mode) {
    if (!/^\d+$/.test(groupId)) throw new SettingsError('群号只能是数字');
    console.log(`群 ${groupId}：${groupModeText(before, groupId)}`);
    return;
  }
  if (mode === 'reset') await settings.resetGroup(groupId);
  else if (Object.hasOwn(GROUP_MODES, mode)) await settings.setGroupMode(groupId, mode);
  else throw new SettingsError(usage);
  const after = await settings.refresh();
  console.log(`群 ${groupId}：${groupModeText(after, groupId)}（以前：${groupModeText(before, groupId)}）`);
  await reportApply(fish, settings);
}

async function ignore(fish, [sub, qq]) {
  const settings = new Settings({ db: fish.db, tenantId: fish.tenantId });
  if (!sub) {
    const v = await settings.refresh();
    console.log(v.ignoreQQ.length ? `不理的 QQ 号：${v.ignoreQQ.length} 个：${v.ignoreQQ.join('、')}` : '不理的 QQ 号：没有');
    return;
  }
  if (sub !== 'add' && sub !== 'remove') throw new SettingsError('用法：naiwa ignore 看名单；naiwa ignore add <QQ 号> / naiwa ignore remove <QQ 号>');
  if (!qq) throw new SettingsError('要写 QQ 号');
  const changed = sub === 'add' ? await settings.addIgnore(qq) : await settings.removeIgnore(qq);
  const v = await settings.refresh();
  if (!changed) {
    console.log(sub === 'add' ? `QQ ${qq} 本来就在不理的名单里。` : `QQ ${qq} 本来就不在不理的名单里。`);
    return;
  }
  console.log(`${sub === 'add' ? '已加上：不理' : '已去掉：又理'} QQ ${qq}（名单里现在一共 ${v.ignoreQQ.length} 个）`);
  await reportApply(fish, settings);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || !COMMANDS.has(cmd)) return run(null, cmd ?? 'help', args); // 看帮助不需要连数据库
  const db = await openStorage();
  try {
    await run(await Fish.open({ db }), cmd, args);
  } finally {
    await db.close();
  }
}

async function run(fish, cmd, args) {
  const out = (o) => console.log(JSON.stringify(o, null, 2));

  switch (cmd) {
    case 'status':
      await showStatus(fish);
      break;
    case 'budget':
      await budget(fish, args);
      break;
    case 'groups':
      printGroups(await new Settings({ db: fish.db, tenantId: fish.tenantId }).refresh());
      break;
    case 'group':
      await group(fish, args);
      break;
    case 'ignore':
      await ignore(fish, args);
      break;
    case 'state':
      out(await fish.bridge.getCharacterState());
      break;
    case 'mood': {
      // 奶蛙今天的心情（Module 8）。mood set <档> 改今天的基调，机器人在跑也立刻生效。
      const [sub, name] = args;
      if (sub && sub !== 'set') {
        console.error(`用法：naiwa mood 看今天的心情；naiwa mood set <档> 改今天的基调（${MOOD_LEVELS.map((l) => l.name).join('、')}）`);
        process.exitCode = 1;
        return;
      }
      const m = sub === 'set' ? await fish.mood.set(name ?? '') : await fish.mood.current();
      console.log(`今天（${m.day}）的基调：${moodName(m.base)}（${m.manual ? '手动改的' : '早上抽的'}）；现在：${moodName(m.level)}；起伏 ${m.ripple.toFixed(2)}`);
      break;
    }
    case 'facts': {
      const [target, ...rest] = args;
      if (!target) {
        console.error('用法：naiwa facts <QQ 号或群号>（也可以写完整的 key，例如 qq:user:101、qq:group:200）；加 --json 输出原始数据');
        process.exitCode = 1;
        return;
      }
      const store = new FactStore({ db: fish.db, tenantId: fish.tenantId });
      // 只写号码时，QQ 号和群号都查一遍（分不清是人还是群）。
      const keys = /^\d+$/.test(target) ? [`qq:user:${target}`, `qq:group:${target}`] : [target];
      const lists = await Promise.all(keys.map((key) => store.list(key)));
      if (rest.includes('--json')) {
        out(lists.flat().map(factForOutput));
        break;
      }
      keys.forEach((key, i) => {
        if (keys.length > 1 && !lists[i].length && i > 0) return; // 号码查群没结果时不多打一行
        const [, kind, id] = key.split(':');
        printFacts(kind === 'group' ? `群 ${id} 里记下的事` : `关于 QQ ${id} 记下的事`, lists[i]);
      });
      break;
    }
    case 'fact-forget': {
      const removed = await new FactStore({ db: fish.db, tenantId: fish.tenantId }).forget(args[0]);
      if (!removed) {
        console.error(`没有编号为 ${args[0] ?? '（空）'} 的事实`);
        process.exitCode = 1;
        return;
      }
      out({ removed: factForOutput(removed) });
      break;
    }
    case 'forget-person':
      await forgetPerson(fish, args.find((a) => a !== '--yes'), args.includes('--yes'));
      break;
    // 预留给以后“奶蛙主动发东西”用（发布、私信、主动做事）。现在还没有真正去发的代码，
    // 待批准的记录和主动做事的开关也只在这条命令的内存里，命令结束就没了（docs/module-09-admin-design.md 第 7 节）。
    case 'act':
      out(await fish.bridge.act({ type: args[0] ?? 'publish', platform: 'fish-os', text: args.slice(1).join(' ') }));
      break;
    case 'approve':
      out(await fish.bridge.approve(args[0]));
      break;
    case 'deny':
      out(await fish.bridge.deny(args[0]));
      break;
    case 'proactive-on':
      out({ proactiveEnabled: fish.policy.setProactiveEnabled(true) });
      break;
    case 'proactive-off':
      out({ proactiveEnabled: fish.policy.setProactiveEnabled(false) });
      break;
    case 'browse': {
      const [platform, sub, ...rest] = args;
      if (platform !== 'bilibili') {
        console.error('目前只支持：naiwa browse bilibili popular [条数] / naiwa browse bilibili search <关键词> [条数]');
        process.exitCode = 1;
        return;
      }
      const { BilibiliAdapter } = await import('../src/adapters/bilibili.js');
      const adapter = new BilibiliAdapter();
      let items;
      if (sub === 'popular') {
        items = await adapter.popular({ ps: Number(rest[0]) || 5 });
      } else if (sub === 'search') {
        const kw = rest.slice(0, -1).join(' ') || rest[0];
        const ps = Number(rest[rest.length - 1]) || 5;
        items = await adapter.search(kw, { pageSize: ps });
      } else {
        console.error('用法：naiwa browse bilibili popular [条数] 或 naiwa browse bilibili search <关键词> [条数]');
        process.exitCode = 1;
        return;
      }
      const evs = await fish.ingestContent(items);
      console.log(`已摄取 ${items.length} 条 B站内容（event ${evs.length} 条）：`);
      for (const it of items) console.log(`- ${it.title} ｜ UP: ${it.author} ｜ 播放 ${it.stats.view}`);
      break;
    }
    default:
      if (cmd !== 'help') {
        console.error(`没有这个命令：${cmd}`);
        process.exitCode = 1;
      }
      console.log(`奶蛙管理命令
用法: naiwa <command> [args]

  status                      奶蛙现在怎么样：在不在跑、连没连上 QQ、心情、今天花费、设置
  budget                      今天花了多少、上限多少（按模型、花得最多的 3 个会话）
  budget set <元>             改每日花费上限（0 表示不限）；budget reset 回到默认 20 元
  groups                      群默认，和单独设置过的群
  group <群号> on|at|off|reset  这个群：说话 / 只回 @ / 不说话 / 回到跟着默认
  group default on|at|off     没单独设置的群默认用哪一档
  ignore                      不理的 QQ 号；ignore add <QQ 号> / ignore remove <QQ 号>
  state                       角色当前心情与状态（JSON）
  mood [set <档>]             看今天的心情；set 改今天的基调（很低落、有点低落、平常、开心、很开心）
  facts <QQ 号或群号>          列出奶蛙记下的事：内容、出自哪里、原话、什么时候删除（--json 输出原始数据）
  fact-forget <编号>           删除一条事实
  forget-person <key> --yes   删除这个人的数据（事实、原话、关系、代号、事件记录）；必须先停机器人。不加 --yes 只预览条数
  browse bilibili popular [n]  B站热门（只读）
  browse bilibili search <kw> [n]  B站搜索（只读）

预留（以后奶蛙主动发东西时用，现在还没接上：不会真的发出去，批准记录和开关命令结束就没了）：
  act publish <文本>           发起一次发布，返回待批准的编号
  approve <编号> / deny <编号>   批准 / 拒绝
  proactive-on / proactive-off  打开 / 关闭主动做事

改设置的命令会等正在跑的奶蛙读到（最多 10 秒），告诉你什么时候生效。`);
    }
}

const COMMANDS = new Set(['status', 'budget', 'groups', 'group', 'ignore', 'state', 'mood', 'facts', 'fact-forget', 'forget-person', 'browse',
  'act', 'approve', 'deny', 'proactive-on', 'proactive-off']);

main().catch((e) => {
  if (e instanceof SettingsError) {
    console.error(e.message);
    process.exit(1);
  }
  console.error(`错误：${e?.message ?? e}`);
  if (process.env.DEBUG) console.error(e?.stack);
  process.exit(1);
});
