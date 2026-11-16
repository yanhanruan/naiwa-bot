// OneBot v11 客户端（正向 WebSocket，零依赖，用 Node 全局 WebSocket）。
// 连接 SnowLuma / NapCat 等 OneBot 实现，收发群聊/私聊消息与 CQ 消息段。

export const seg = {
  text: (text) => ({ type: 'text', data: { text: String(text) } }),
  at: (qq) => ({ type: 'at', data: { qq: String(qq) } }),
  face: (id) => ({ type: 'face', data: { id: String(id) } }),
  image: (file) => ({ type: 'image', data: { file } }),
  reply: (id) => ({ type: 'reply', data: { id: String(id) } }),
};

export class OneBotClient {
  constructor({ url, token = '', onEvent = null, onStatus = null }) {
    this.url = url; // 例如 ws://127.0.0.1:3001
    this.token = token;
    this.onEvent = onEvent; // (event) => void，收到 post_type 事件
    this.onStatus = onStatus; // (status) => void，连接状态变化
    this.ws = null;
    this.echoSeq = 0;
    this.pending = new Map(); // echo -> {resolve, reject}
    this.connected = false;
    this.selfId = null;
  }

  connect() {
    const url = this.token
      ? `${this.url}?access_token=${encodeURIComponent(this.token)}`
      : this.url;
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        reject(err);
        return;
      }
      this.ws = ws;
      ws.onopen = () => {
        this.connected = true;
        this.onStatus?.({ connected: true });
        resolve(this);
      };
      ws.onerror = () => {
        reject(new Error('OneBot WebSocket 连接失败'));
      };
      ws.onclose = () => {
        this.connected = false;
        this.onStatus?.({ connected: false });
        for (const [, p] of this.pending) p.reject(new Error('连接已关闭'));
        this.pending.clear();
      };
      ws.onmessage = (ev) => {
        let data;
        try {
          data = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        this._handle(data);
      };
    });
  }

  _handle(data) {
    // 事件
    if (data.post_type) {
      if (data.post_type === 'meta_event' && data.meta_event_type === 'lifecycle' && data.sub_type === 'connect') {
        this.selfId = data.self_id ?? this.selfId;
      }
      this.onEvent?.(data);
      return;
    }
    // 响应
    if (data.echo !== undefined && this.pending.has(data.echo)) {
      const { resolve, reject } = this.pending.get(data.echo);
      this.pending.delete(data.echo);
      if (data.status === 'ok' || data.retcode === 0) resolve(data.data);
      else reject(new Error(data.message || `OneBot retcode ${data.retcode}`));
    }
  }

  call(action, params = {}) {
    if (!this.connected || !this.ws) return Promise.reject(new Error('未连接'));
    const echo = String(++this.echoSeq);
    return new Promise((resolve, reject) => {
      this.pending.set(echo, { resolve, reject });
      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  getLoginInfo() {
    return this.call('get_login_info');
  }

  getGroupList() {
    return this.call('get_group_list');
  }

  getGroupInfo(groupId) {
    return this.call('get_group_info', { group_id: groupId });
  }

  sendGroupMsg(groupId, message) {
    return this.call('send_group_msg', { group_id: groupId, message });
  }

  sendPrivateMsg(userId, message) {
    return this.call('send_private_msg', { user_id: userId, message });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
