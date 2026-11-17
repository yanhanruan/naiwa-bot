// OneBot v11 客户端（正向 WebSocket，运行时零依赖，用 Node 22 的全局 WebSocket）。
// 连接 SnowLuma / NapCat 等 OneBot 实现，收发群聊/私聊消息。
//
// 这一层负责“连接本身”的可靠性，业务代码不用关心：
// - 断线自动重连：指数退避加随机抖动；连接稳定一段时间后才把等待时间重置为最小值，
//   避免“连上就被踢”时每秒重连一次。
// - 请求超时：每个请求都有时限，超时以 OneBotError 拒绝，不会永远挂起。
// - 无响应探测：一段时间收不到任何数据（心跳、事件、响应都算），就发一个 get_status 探测；
//   探测也超时，说明连接已经“假活”（TCP 没断但对方不回），主动断开重连。
// - 异常数据不崩进程：坏 JSON、二进制帧、事件处理函数抛错，都只记日志。
// - 发送节流：所有 send_* 动作经过 SendThrottle 排队（见 send-throttle.js）。
// - token 只放进连接地址。日志里的地址只有协议、主机和路径；错误信息里的 token（包括直接写进地址的
//   access_token）和地址里的账号密码都会被隐藏。
import { OneBotError } from './onebot-errors.js';
import { SendThrottle } from './send-throttle.js';
import { silentLogger } from '../log.js';

export { OneBotError } from './onebot-errors.js';

export const seg = {
  text: (text) => ({ type: 'text', data: { text: String(text) } }),
  at: (qq) => ({ type: 'at', data: { qq: String(qq) } }),
  face: (id) => ({ type: 'face', data: { id: String(id) } }),
  image: (file) => ({ type: 'image', data: { file } }),
  reply: (id) => ({ type: 'reply', data: { id: String(id) } }),
};

export const ONEBOT_DEFAULTS = {
  requestTimeoutMs: 15_000, // 请求发出后等待响应的上限
  connectTimeoutMs: 10_000, // 建立连接的上限
  idleTimeoutMs: 30_000, // 这么久收不到任何数据就探测一次；心跳间隔更长时按心跳间隔的 1.5 倍放宽
  probeTimeoutMs: 10_000, // 探测等待响应的上限；超时就断开重连
  reconnectMinMs: 1_000,
  reconnectMaxMs: 30_000,
  stableAfterMs: 10_000, // 连接保持这么久，下次断线才从最小等待时间重新开始
};

const OPEN = 1; // WebSocket.OPEN
const BAD_FRAME_LOG_INTERVAL_MS = 10_000;

function decodeSafely(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// 一个秘密值出现在错误信息里时，可能是原文，也可能是编码后的写法：encodeURIComponent 的结果，
// 或者再经过 URL 规范化（例如 ' 会变成 %27）。长的先替换，免得短的先替换掉长的一部分。
function secretForms(values) {
  const forms = new Set();
  for (const value of values) {
    if (!value) continue;
    const encoded = encodeURIComponent(value);
    forms.add(value).add(encoded).add(new URL(`ws://x/?t=${encoded}`).search.slice(3));
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

export class OneBotClient {
  /**
   * @param {object} options
   * @param {string} options.url 例如 ws://127.0.0.1:3001（不要把 token 写进来，用 token 参数）
   * @param {string} [options.token] OneBot access_token
   * @param {(event: object) => (void|Promise<void>)} [options.onEvent] 收到 OneBot 事件（post_type）时调用
   * @param {(status: {connected: boolean}) => void} [options.onStatus] 连接建立或断开时调用
   * @param {object} [options.logger] 见 src/log.js
   * @param {object|SendThrottle} [options.throttle] 发送节流参数，见 send-throttle.js
   */
  constructor({
    url, token = '', onEvent = null, onStatus = null, logger = silentLogger, throttle = {},
    WebSocketImpl = globalThis.WebSocket, random = Math.random, ...options
  } = {}) {
    if (!url) throw new Error('OneBotClient 需要 url');
    if (typeof WebSocketImpl !== 'function') throw new Error('当前 Node 没有全局 WebSocket，需要 Node 22 及以上');
    // 地址写错是配置问题，重试也不会好，启动时直接报错。
    // 报错不回显地址：写错的地址里可能有 token 或密码，地址解析不了时也没法可靠地把它们找出来。
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      // 下面统一报错
    }
    if (!parsed || !['ws:', 'wss:'].includes(parsed.protocol)) {
      const actual = parsed ? `当前是 ${parsed.protocol}` : '当前地址无法解析';
      throw new Error(`OneBot 地址无效：应以 ws:// 或 wss:// 开头（${actual}）`);
    }
    this.url = url;
    this.token = token;
    // 日志里只写协议、主机和路径：去掉账号密码、查询参数（可能含 token）和 # 之后的部分。
    this.endpoint = `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
    // 日志和错误信息里要隐藏的值：token 参数、直接写进地址的 access_token，以及地址里的密码（原样和解码后）。
    this.secrets = secretForms([
      token, ...parsed.searchParams.getAll('access_token'), parsed.password, decodeSafely(parsed.password),
    ]);
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.log = logger;
    this.options = { ...ONEBOT_DEFAULTS, ...options };
    this.throttle = throttle instanceof SendThrottle ? throttle : new SendThrottle({ random, ...throttle });
    this.WebSocketImpl = WebSocketImpl;
    this.random = random;

    this.state = 'idle'; // idle → connecting → open → reconnecting → connecting … ；stop() 后为 stopped
    this.ws = null;
    this.selfId = null;
    this.botOnline = null; // QQ 账号是否在线（来自 bot_status 通知 / get_status），未知为 null
    this.echoSeq = 0;
    this.pending = new Map(); // echo -> { action, resolve, reject, timer }
    this.failures = 0; // 连续失败次数，决定下次重连等多久
    this.reconnects = 0;
    this.openedAt = null;
    this.lastFrameAt = null;
    this.lastError = null;
    this.heartbeatIntervalMs = null; // 对方心跳事件里声明的间隔（SnowLuma 实测为 30000）
    this.probing = false;
    this.badFrames = 0;
    this.lastBadFrameLogAt = -Infinity;
    this.timers = { connect: null, reconnect: null, liveness: null };
    this.firstOpen = null;
  }

  get connected() {
    return this.state === 'open';
  }

  // 开始连接；之后断线会一直自动重连，直到 stop()。
  // 返回的 Promise 在第一次连上时完成（true）；如果还没连上就 stop()，完成为 false。不会 reject。
  start() {
    if (this.state === 'idle') {
      this.firstOpen = {};
      this.firstOpen.promise = new Promise((resolve) => { this.firstOpen.resolve = resolve; });
      this._open();
    }
    return this.firstOpen?.promise ?? Promise.resolve(false);
  }

  stop() {
    if (this.state === 'stopped') return;
    const ws = this.ws;
    this.state = 'stopped';
    this.ws = null;
    clearTimeout(this.timers.connect);
    clearTimeout(this.timers.reconnect);
    clearInterval(this.timers.liveness);
    try {
      ws?.close(1000, 'shutdown');
    } catch {
      // 关闭失败不影响退出
    }
    this.throttle.stop();
    this._failPending(new OneBotError('STOPPED', '客户端已停止，请求结果未知', { delivery: 'unknown' }));
    this.firstOpen?.resolve(false);
    this.log.info('onebot.stopped', { msg: '已停止 OneBot 客户端' });
  }

  status() {
    return {
      state: this.state,
      connected: this.connected,
      selfId: this.selfId,
      botOnline: this.botOnline,
      reconnects: this.reconnects,
      connectedSince: this.connected ? this.openedAt : null,
      lastFrameAt: this.lastFrameAt,
      pendingRequests: this.pending.size,
      queuedSends: this.throttle.size,
    };
  }

  // 调用 OneBot 动作。send_* 动作经过发送节流；其他动作直接发出。
  // opts.key：关联的消息 key，只用于日志。
  call(action, params = {}, { timeoutMs = this.options.requestTimeoutMs, key } = {}) {
    if (!action.startsWith('send_')) return this._request(action, params, { timeoutMs, key });
    if (this.state === 'stopped') {
      return Promise.reject(new OneBotError('STOPPED', '客户端已停止，未发送', { delivery: 'not_sent', action }));
    }
    // 断线期间不排队等待：直接失败，由上层决定是否重试。
    if (!this.connected) return this._notConnected(action);
    const queuedAt = Date.now();
    return this.throttle.schedule(() => {
      const waitedMs = Date.now() - queuedAt;
      if (waitedMs >= 100) this.log.debug('onebot.send_waited', { action, waitedMs, messageKey: key });
      return this._request(action, params, { timeoutMs, key });
    }).catch((error) => {
      if (error?.code === 'QUEUE_FULL' || error?.code === 'QUEUE_TIMEOUT') {
        this.log.warn('onebot.send_dropped', { msg: '发送被节流队列放弃', action, messageKey: key, error });
      }
      throw error;
    });
  }

  getLoginInfo() {
    return this.call('get_login_info');
  }

  getStatus() {
    return this.call('get_status');
  }

  getGroupList() {
    return this.call('get_group_list');
  }

  getGroupInfo(groupId) {
    return this.call('get_group_info', { group_id: groupId });
  }

  sendGroupMsg(groupId, message, opts) {
    return this.call('send_group_msg', { group_id: groupId, message }, opts);
  }

  sendPrivateMsg(userId, message, opts) {
    return this.call('send_private_msg', { user_id: userId, message }, opts);
  }

  // —— 连接管理 ——

  // 错误信息来自 WebSocket 实现，万一带着完整地址也不能泄露。顺序很重要：
  // 1. 先把 token、密码的原文和各种编码写法整段换成 ***（它们可能含 @、空格、&，后两步会把它们切断）；
  // 2. 再去掉地址里的账号密码：从 // 到主机前最后一个 @（账号密码里不会有未编码的 / ? #）；
  // 3. 最后把 access_token= 后面剩下的值也换成 ***，兜住没认出来的写法。
  _redact(text) {
    let out = String(text ?? '');
    for (const form of this.secrets) out = out.split(form).join('***');
    return out
      .replace(/\/\/[^/?#\s]*@/g, '//')
      .replace(/(access_token=)[^&#\s]+/gi, '$1***');
  }

  _open() {
    if (this.state === 'stopped') return;
    this.state = 'connecting';
    this.lastError = null;
    const sep = this.url.includes('?') ? '&' : '?';
    const target = this.token ? `${this.url}${sep}access_token=${encodeURIComponent(this.token)}` : this.url;
    let ws;
    try {
      ws = new this.WebSocketImpl(target);
    } catch (error) {
      this.lastError = this._redact(error?.message ?? error);
      this._afterClose({ code: null, reason: '' });
      return;
    }
    this.ws = ws;
    const current = () => this.ws === ws;

    this.timers.connect = setTimeout(() => {
      if (!current() || this.state !== 'connecting') return;
      this.lastError = `连接超过 ${this.options.connectTimeoutMs}ms 未建立`;
      this._drop(ws);
    }, this.options.connectTimeoutMs);

    ws.onopen = () => {
      if (!current()) return;
      clearTimeout(this.timers.connect);
      this.state = 'open';
      this.openedAt = Date.now();
      this.lastFrameAt = this.openedAt;
      this.timers.liveness = setInterval(() => void this._checkLiveness(), this._livenessTick());
      this.log.info('onebot.connected', { msg: '已连接 OneBot', endpoint: this.endpoint, reconnects: this.reconnects });
      this._notifyStatus(true);
      this.firstOpen?.resolve(true);
    };
    ws.onmessage = (ev) => {
      if (!current()) return;
      this.lastFrameAt = Date.now();
      this._onFrame(ev.data);
    };
    ws.onerror = (ev) => {
      if (!current()) return;
      // 按规范 error 之后会有 close，但 Node 22 的 WebSocket 在连接被拒绝时只触发 error、不触发 close，
      // readyState 一直停在 CONNECTING。所以这里直接放弃这个连接并安排重连，不等 close。
      this.lastError = this._redact(ev?.error?.message ?? ev?.message ?? 'WebSocket 错误');
      this._drop(ws);
    };
    ws.onclose = (ev) => {
      if (!current()) return;
      this.ws = null;
      this._afterClose({ code: ev?.code ?? null, reason: this._redact(ev?.reason ?? '') });
    };
  }

  // 主动放弃一个连接（连接超时、假活）。旧连接之后的任何事件都会被忽略。
  _drop(ws) {
    if (this.ws !== ws) return;
    this.ws = null;
    try {
      ws.close();
    } catch {
      // 已经坏掉的连接，关不掉也没关系
    }
    this._afterClose({ code: null, reason: '' });
  }

  _afterClose({ code, reason }) {
    clearTimeout(this.timers.connect);
    clearInterval(this.timers.liveness);
    if (this.state === 'stopped') return;
    const wasOpen = this.state === 'open';
    this.state = 'reconnecting';
    this._failPending(new OneBotError('CONNECTION_LOST', '等待响应时连接断开，请求结果未知', { delivery: 'unknown' }));
    if (wasOpen) {
      const lifetimeMs = Date.now() - this.openedAt;
      if (lifetimeMs >= this.options.stableAfterMs) this.failures = 0;
      this.log.warn('onebot.disconnected', {
        msg: 'OneBot 连接断开', code, reason: reason || undefined, error: this.lastError || undefined, lifetimeMs,
      });
      this._notifyStatus(false);
    } else {
      this.log.warn('onebot.connect_failed', {
        msg: '连不上 OneBot', endpoint: this.endpoint, code, error: this.lastError || reason || undefined, failures: this.failures,
      });
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    const { reconnectMinMs, reconnectMaxMs } = this.options;
    const base = Math.min(reconnectMaxMs, reconnectMinMs * 2 ** this.failures);
    const delayMs = Math.round(base * (0.5 + 0.5 * this.random()));
    this.failures += 1;
    this.log.info('onebot.reconnect_scheduled', { delayMs, failures: this.failures });
    this.timers.reconnect = setTimeout(() => {
      this.timers.reconnect = null;
      this.reconnects += 1;
      this._open();
    }, delayMs);
  }

  _notifyStatus(connected) {
    try {
      this.onStatus?.({ connected });
    } catch (error) {
      this.log.error('onebot.status_handler_failed', { error });
    }
  }

  _livenessTick() {
    return Math.max(10, Math.min(5_000, Math.floor(this.options.idleTimeoutMs / 2)));
  }

  // 多久没收到数据才探测：取配置值和心跳间隔 1.5 倍中的较大者，避免心跳稍晚一点就误探测。
  _idleLimitMs() {
    return Math.max(this.options.idleTimeoutMs, (this.heartbeatIntervalMs ?? 0) * 1.5);
  }

  async _checkLiveness() {
    const ws = this.ws;
    if (this.state !== 'open' || this.probing) return;
    const idleMs = Date.now() - this.lastFrameAt;
    if (idleMs < this._idleLimitMs()) return;
    this.probing = true;
    try {
      const status = await this._request('get_status', {}, { timeoutMs: this.options.probeTimeoutMs });
      this._setBotOnline(status?.online);
    } catch (error) {
      // 返回失败（例如不支持 get_status）也说明对方还在响应；只有超时才说明连接假活。
      if (error?.code === 'TIMEOUT' && this.ws === ws && this.state === 'open') {
        this.lastError = `${idleMs}ms 没有收到数据，探测 ${this.options.probeTimeoutMs}ms 无响应`;
        this.log.warn('onebot.unresponsive', { msg: 'OneBot 无响应，断开重连', idleMs, probeTimeoutMs: this.options.probeTimeoutMs });
        this._drop(ws);
      }
    } finally {
      this.probing = false;
    }
  }

  _failPending(error) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new OneBotError(error.code, error.message, { delivery: error.delivery }), { action: p.action }));
    }
    this.pending.clear();
  }

  _notConnected(action) {
    return Promise.reject(new OneBotError('NOT_CONNECTED', '未连接 OneBot，未发送', { delivery: 'not_sent', action }));
  }

  _request(action, params, { timeoutMs, key }) {
    const ws = this.ws;
    if (this.state !== 'open' || !ws || ws.readyState !== OPEN) return this._notConnected(action);
    const echo = String(++this.echoSeq);
    let frame;
    try {
      frame = JSON.stringify({ action, params, echo });
    } catch (error) {
      return Promise.reject(new OneBotError('ACTION_FAILED', `请求参数无法序列化：${error.message}`, { delivery: 'not_sent', action }));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(echo)) return;
        this.pending.delete(echo);
        this.log.warn('onebot.request_timeout', { msg: '请求超时', action, echo, timeoutMs, messageKey: key });
        reject(new OneBotError('TIMEOUT', `${action} 超过 ${timeoutMs}ms 没有响应，结果未知`, { delivery: 'unknown', action }));
      }, timeoutMs);
      this.pending.set(echo, { action, resolve, reject, timer });
      try {
        ws.send(frame);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(new OneBotError('NOT_CONNECTED', `请求没能发出：${this._redact(error?.message)}`, { delivery: 'not_sent', action }));
      }
    });
  }

  // —— 入站数据 ——

  _onFrame(data) {
    if (typeof data !== 'string') return this._badFrame('binary');
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return this._badFrame('bad_json', data.length);
    }
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return this._badFrame('not_object', data.length);
    if (typeof msg.post_type === 'string') return this._onEvent(msg);
    if (msg.echo !== undefined && msg.echo !== null) return this._onResponse(msg);
    return this._badFrame('unknown_shape', data.length);
  }

  // 坏数据可能成批出现，日志每 10 秒最多一条，带上累计数量。不记录内容。
  _badFrame(reason, bytes) {
    this.badFrames += 1;
    const now = Date.now();
    if (now - this.lastBadFrameLogAt < BAD_FRAME_LOG_INTERVAL_MS) return;
    this.lastBadFrameLogAt = now;
    this.log.warn('onebot.bad_frame', { msg: '收到无法识别的数据，已忽略', reason, bytes, total: this.badFrames });
  }

  _onEvent(ev) {
    if (ev.self_id !== undefined && ev.self_id !== null) this.selfId = ev.self_id;
    if (ev.post_type === 'meta_event' && ev.meta_event_type === 'heartbeat') {
      if (Number.isFinite(ev.interval) && ev.interval > 0) this.heartbeatIntervalMs = ev.interval;
      this._setBotOnline(ev.status?.online);
    } else if (ev.post_type === 'meta_event' && ev.meta_event_type === 'lifecycle') {
      const fields = { subType: ev.sub_type, selfId: this.selfId };
      if (ev.sub_type === 'disable') this.log.warn('onebot.lifecycle', { msg: 'OneBot 已停用', ...fields });
      else this.log.info('onebot.lifecycle', fields);
    } else if (ev.post_type === 'notice' && ev.notice_type === 'bot_status') {
      // SnowLuma 扩展：QQ 账号上线/离线。离线时连接还在，但消息发不出去。
      this._setBotOnline(ev.sub_type === 'online' ? true : ev.sub_type === 'offline' ? false : undefined);
    }
    if (!this.onEvent) return;
    const fields = { postType: ev.post_type, messageType: ev.message_type };
    try {
      const result = this.onEvent(ev);
      if (result && typeof result.then === 'function') {
        result.then(undefined, (error) => this.log.error('onebot.event_handler_failed', { msg: '事件处理出错', ...fields, error }));
      }
    } catch (error) {
      this.log.error('onebot.event_handler_failed', { msg: '事件处理出错', ...fields, error });
    }
  }

  _setBotOnline(online) {
    if (typeof online !== 'boolean' || online === this.botOnline) return;
    const previous = this.botOnline;
    this.botOnline = online;
    if (!online) this.log.warn('onebot.bot_offline', { msg: 'QQ 账号离线，消息会发不出去', selfId: this.selfId });
    else if (previous === false) this.log.info('onebot.bot_online', { msg: 'QQ 账号恢复在线', selfId: this.selfId });
  }

  _onResponse(msg) {
    const echo = String(msg.echo);
    const p = this.pending.get(echo);
    if (!p) {
      // 多半是已经超时的请求迟到的响应。
      this.log.debug('onebot.unmatched_response', { echo });
      return;
    }
    this.pending.delete(echo);
    clearTimeout(p.timer);
    const ok = msg.status === 'ok' || msg.status === 'async' || (msg.status === undefined && msg.retcode === 0);
    if (ok) {
      p.resolve(msg.data ?? null);
      return;
    }
    const detail = msg.wording || msg.message || `retcode ${msg.retcode}`;
    p.reject(new OneBotError('ACTION_FAILED', `${p.action} 失败：${detail}`, { delivery: 'not_sent', action: p.action, retcode: msg.retcode }));
  }
}
