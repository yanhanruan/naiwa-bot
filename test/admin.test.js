import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  Settings, SettingsError, BotStatus, readStatus, waitForApply, Participation, DeepSeekBrain, normalizeOneBotMessage,
} from '../src/index.js';
import { openStorage } from '../src/storage/index.js';
import { testDb, closeTestDb, captureLogger } from './helpers.js';

// Module 9：设置、运行状态、改了以后奶蛙怎么生效（docs/module-09-admin-design.md 第 9 节）。
// 默认在 PGlite 上测；设置 TEST_DATABASE_URL 时也在真实 PostgreSQL 上测（命令和奶蛙是两条连接，真正同时写）。
const backends = [{ name: 'PGlite', open: testDb }];
if (process.env.TEST_DATABASE_URL) {
  let pg = null;
  backends.push({ name: 'PostgreSQL', open: () => (pg ??= openStorage({ databaseUrl: process.env.TEST_DATABASE_URL })) });
  after(async () => { if (pg) await (await pg).close(); });
}
after(closeTestDb);

const tenant = () => `test-${randomUUID()}`;
const GROUP_200 = 'qq:account:900:conversation:group:200';
const GROUP_300 = 'qq:account:900:conversation:group:300';
const PRIVATE = 'qq:account:900:conversation:private:101';
const root = fileURLToPath(new URL('..', import.meta.url));

for (const { name, open } of backends) {
  test(`[${name}] 设置：没改过用默认值；改了存进数据库，另一个进程读得到；reset 回默认；写错的值拒绝、不改`, async () => {
    const db = await open();
    const tenantId = tenant();
    const cli = new Settings({ db, tenantId });
    const bot = new Settings({ db, tenantId });
    let v = await bot.refresh();
    assert.equal(v.dailyBudgetCny, 20);
    assert.equal(v.budgetSetAt, null);
    assert.equal(bot.groupMode(GROUP_200), 'on');
    assert.ok(bot.readAt instanceof Date);

    await cli.setBudget(5);
    await cli.setGroupMode('200', 'off');
    await cli.setGroupMode('300', 'at');
    assert.equal(bot.dailyBudgetCny, 20, '奶蛙那份没刷新前还是旧值');
    v = await bot.refresh();
    assert.equal(bot.dailyBudgetCny, 5);
    assert.ok(v.budgetSetAt instanceof Date);
    assert.equal(bot.groupMode(GROUP_200), 'off');
    assert.equal(bot.groupMode(GROUP_300), 'at');
    assert.equal(bot.groupMode('qq:account:900:conversation:group:400'), 'on', '没单独设置的跟着默认');
    assert.equal(bot.groupMode(PRIVATE), 'on', '私聊不受群开关影响');

    await cli.setGroupMode('default', 'off');
    await cli.resetGroup('200');
    await cli.setBudget(0);
    await bot.refresh();
    assert.equal(bot.groupMode(GROUP_200), 'off', 'reset 以后跟着默认（现在默认是不说话）');
    assert.equal(bot.groupMode(GROUP_300), 'at', '单独设置的不受默认影响');
    assert.equal(bot.dailyBudgetCny, 0, '0 表示不限');
    await cli.resetBudget();
    await bot.refresh();
    assert.equal(bot.dailyBudgetCny, 20);

    for (const bad of [() => cli.setBudget(Number('二十')), () => cli.setBudget(-1), () => cli.setGroupMode('200', 'maybe'),
      () => cli.setGroupMode('群200', 'off'), () => cli.addIgnore('abc'), () => cli.resetGroup('x')]) {
      await assert.rejects(bad(), SettingsError);
    }
    await bot.refresh();
    assert.equal(bot.dailyBudgetCny, 20, '写错的没改');

    // 租户之间互不影响
    const other = new Settings({ db, tenantId: tenant() });
    await other.refresh();
    assert.equal(other.groupMode(GROUP_300), 'on');
  });

  test(`[${name}] 不理的 QQ 号：加、去掉、重复加；几条命令同时加也不互相覆盖`, async () => {
    const db = await open();
    const tenantId = tenant();
    const s = new Settings({ db, tenantId });
    assert.equal(await s.addIgnore('666'), true);
    assert.equal(await s.addIgnore('666'), false, '本来就在名单里');
    await Promise.all(['1', '2', '3', '4', '5'].map((qq) => new Settings({ db, tenantId }).addIgnore(qq)));
    let v = await s.refresh();
    assert.deepEqual([...v.ignoreQQ].sort(), ['1', '2', '3', '4', '5', '666']);
    assert.equal(s.isIgnored('qq:user:666'), true);
    assert.equal(await s.removeIgnore('666'), true);
    assert.equal(await s.removeIgnore('666'), false, '本来就不在');
    v = await s.refresh();
    assert.equal(v.ignoreQQ.includes('666'), false);
    assert.equal(s.isIgnored('qq:user:666'), false);
  });

  test(`[${name}] 设置的值被手改坏了：那一项按默认值，记进 problems，其他项照常`, async () => {
    const db = await open();
    const tenantId = tenant();
    await db.query(`INSERT INTO bot_settings (tenant_id, key, value) VALUES ($1, 'daily_budget_cny', '"二十"'),
      ($1, 'group:qq:group:200', '"off"'), ($1, 'group:qq:group:300', '"maybe"')`, [tenantId]);
    const s = new Settings({ db, tenantId });
    const v = await s.refresh();
    assert.equal(v.dailyBudgetCny, 20);
    assert.deepEqual(v.problems.sort(), ['daily_budget_cny', 'group:qq:group:300']);
    assert.equal(s.groupMode(GROUP_200), 'off');
    assert.equal(s.groupMode(GROUP_300), 'on');
  });

  test(`[${name}] 运行状态：在跑、正常退出、没响应（心跳停了也没正常退出）、还没跑过`, async () => {
    const db = await open();
    const tenantId = tenant();
    assert.equal((await readStatus(db, { tenantId })).state, 'never');

    const settings = new Settings({ db, tenantId });
    const status = new BotStatus({ db, tenantId, settings, beatMs: 60_000 });
    await status.start({ dir: '/tmp/naiwa', branch: 'main', commit: 'abc1234' });
    let st = await readStatus(db, { tenantId });
    assert.equal(st.state, 'running');
    assert.deepEqual(st.code, { dir: '/tmp/naiwa', branch: 'main', commit: 'abc1234' });
    assert.equal(st.onebot.connected, false);
    assert.equal(st.lastMessageAgo, null);

    status.noteConnection(true);
    status.noteMessage();
    status.noteReply();
    await status.beat();
    st = await readStatus(db, { tenantId });
    assert.equal(st.onebot.connected, true);
    assert.ok(st.onebot.since instanceof Date);
    assert.ok(st.lastMessageAgo !== null && st.lastMessageAgo < 60_000);
    assert.ok(st.lastReplyAgo !== null);

    // 没响应：心跳停在 1 分钟前，也没写正常退出（卡住或者被强杀）
    await db.query("UPDATE bot_status SET heartbeat_at = now() - interval '1 minute' WHERE tenant_id = $1", [tenantId]);
    st = await readStatus(db, { tenantId });
    assert.equal(st.state, 'unresponsive');
    assert.ok(st.heartbeatAgo >= 60_000);

    await status.beat();
    assert.equal((await readStatus(db, { tenantId })).state, 'running', '又有心跳就是在跑');
    await status.stop();
    st = await readStatus(db, { tenantId });
    assert.equal(st.state, 'stopped');
    assert.ok(st.stoppedAt instanceof Date);
    assert.equal(st.onebot.connected, false);

    // 重新启动：清掉“正常退出”
    await new BotStatus({ db, tenantId, settings, beatMs: 60_000 }).start({});
    assert.equal((await readStatus(db, { tenantId })).state, 'running');
  });

  test(`[${name}] 改完设置等奶蛙读到：在跑就等下一次心跳；没在跑直接说没在跑；在跑但一直没读到说还没读到`, async () => {
    const db = await open();
    const tenantId = tenant();
    const cli = new Settings({ db, tenantId });
    await cli.setGroupMode('200', 'off');
    let since = await cli.dbNow();
    assert.equal((await waitForApply(db, since, { tenantId, timeoutMs: 50, pollMs: 10 })).result, 'not_running', '还没跑过');

    const botSettings = new Settings({ db, tenantId });
    const status = new BotStatus({ db, tenantId, settings: botSettings, beatMs: 60_000 });
    await status.start({});
    assert.equal(botSettings.groupMode(GROUP_200), 'off', '启动时读到的设置');

    await cli.setGroupMode('200', 'on');
    since = await cli.dbNow();
    assert.equal(botSettings.groupMode(GROUP_200), 'off', '下一次心跳前还是旧值');
    assert.equal((await waitForApply(db, since, { tenantId, timeoutMs: 50, pollMs: 10 })).result, 'pending');
    const waiting = waitForApply(db, since, { tenantId, timeoutMs: 5_000, pollMs: 10 });
    await status.beat();
    const r = await waiting;
    assert.equal(r.result, 'applied');
    assert.ok(r.afterMs >= 0);
    assert.equal(botSettings.groupMode(GROUP_200), 'on');

    await status.stop();
    await cli.setGroupMode('200', 'off');
    assert.equal((await waitForApply(db, await cli.dbNow(), { tenantId, timeoutMs: 50 })).result, 'not_running');
  });

  test(`[${name}] 读设置失败：继续用上一次的值，读设置的时间不往前走，心跳照写；恢复以后照常读`, async () => {
    const db = await open();
    const tenantId = tenant();
    const cli = new Settings({ db, tenantId });
    await cli.setGroupMode('200', 'off');
    const botSettings = new Settings({ db, tenantId });
    const logs = captureLogger();
    const status = new BotStatus({ db, tenantId, settings: botSettings, logger: logs.logger, beatMs: 60_000 });
    await status.start({});
    const readAt = botSettings.readAt;

    const realRefresh = botSettings.refresh.bind(botSettings);
    botSettings.refresh = async () => { throw new Error('数据库一时连不上'); };
    await cli.setGroupMode('200', 'on');
    await status.beat();
    await status.beat();
    assert.equal(botSettings.groupMode(GROUP_200), 'off', '没有悄悄回到默认值');
    const st = await readStatus(db, { tenantId });
    assert.equal(st.state, 'running');
    assert.equal(st.settingsReadAt.getTime(), readAt.getTime());
    assert.equal(logs.find('settings.refresh_failed').length, 1, '连着失败只提醒一次');

    botSettings.refresh = realRefresh;
    await status.beat();
    assert.equal(botSettings.groupMode(GROUP_200), 'on');
    assert.equal(logs.find('settings.refresh_recovered').length, 1);
    await status.stop();
  });

  test(`[${name}] 从数据库读的设置接到判断规则上：关掉的群不看，只回 @ 的群开头叫名字不看，不理的人不看`, async () => {
    const db = await open();
    const tenantId = tenant();
    const cli = new Settings({ db, tenantId });
    const settings = new Settings({ db, tenantId });
    const p = new Participation({ settings });
    const msg = (group, text, user = 101) => normalizeOneBotMessage({
      post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: 900, user_id: user, group_id: group,
      message_id: 1, time: 1700000000, sender: { nickname: '小甲' }, message: text,
    });
    await settings.refresh();
    assert.equal(p.classify(msg(200, '[CQ:at,qq=900]你好')).action, 'explicit');
    await cli.setGroupMode('200', 'off');
    await cli.setGroupMode('300', 'at');
    await cli.addIgnore('666');
    await settings.refresh();
    assert.deepEqual(p.classify(msg(200, '[CQ:at,qq=900]你好')), { action: 'ignore', reason: 'group_off' });
    assert.equal(p.classify(msg(300, '[CQ:at,qq=900]你好')).action, 'explicit');
    assert.deepEqual(p.classify(msg(300, '奶蛙，你在干嘛')), { action: 'ignore', reason: 'at_only' });
    assert.equal(p.classify(msg(300, '[CQ:at,qq=900]')).action, 'wait', '只回 @ 的群里只 @ 不说话照样等');
    assert.deepEqual(p.classify(msg(400, '[CQ:at,qq=900]你好', 666)), { action: 'ignore', reason: 'ignored_user' });
    assert.equal(p.classify(msg(400, '奶蛙，你在干嘛')).action, 'judge', '别的群照常');
  });
}

test('每日上限：传函数时每次调用前取，调低马上拦、调回马上放；0 表示不限', async () => {
  let budget = 20;
  const ledger = { day: async () => ({ costCny: 3.42 }) };
  const brain = new DeepSeekBrain({ apiKey: 'test', ledger, dailyBudgetCny: () => budget });
  const log = captureLogger().logger;
  await brain._checkBudget(log);
  budget = 1;
  await assert.rejects(brain._checkBudget(log), { code: 'BUDGET_EXCEEDED' });
  budget = 0;
  await brain._checkBudget(log);
  budget = 30;
  await brain._checkBudget(log);
});

test('奶蛙启动：.env 里还写着 MODEL_DAILY_BUDGET_CNY 或 IGNORE_QQ 就不启动，提示改用命令', () => {
  for (const [name, command] of [['MODEL_DAILY_BUDGET_CNY', 'naiwa budget set'], ['IGNORE_QQ', 'naiwa ignore add']]) {
    const r = spawnSync(process.execPath, ['bin/fish-bot.mjs'], {
      cwd: root, encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH, [name]: '20' },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`${name} 已经不用了：改用 ${command}`));
  }
});

test('命令：不认识的命令说没有这个命令；帮助里有新命令，预留的发布、审批、主动做事命令标明还没接上（都不用连数据库）', () => {
  const run = (...args) => spawnSync(process.execPath, ['bin/naiwa.mjs', ...args], {
    cwd: root, encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH },
  });
  const r = run('bogus');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /没有这个命令：bogus/);
  const help = run('help');
  assert.equal(help.status, 0);
  for (const cmd of ['status', 'budget set', 'group <群号> on|at|off|reset', 'group default', 'ignore add',
    'act publish', 'approve <编号>', 'proactive-on']) assert.ok(help.stdout.includes(cmd), cmd);
  assert.match(help.stdout, /预留.*现在还没接上/);
});
