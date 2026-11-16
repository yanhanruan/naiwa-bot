// DeepSeek 大脑：Responses API（服务端 web_search），带超时、重试与降级。
// web_search 仅 deepseek-v4-pro 支持；搜索失败/超时会自动退回「不搜」再试一次。

export class DeepSeekBrain {
  constructor({ apiKey, baseUrl = 'https://api.deepseek.com', model = 'deepseek-v4-pro' }) {
    if (!apiKey) throw new Error('DeepSeekBrain 需要 apiKey');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
  }

  async _call(messages, { maxOutputTokens, webSearch }) {
    const instructions = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const input = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const body = { model: this.model, input, max_output_tokens: maxOutputTokens };
    if (instructions) body.instructions = instructions;
    if (webSearch) body.tools = [{ type: 'web_search' }];

    const res = await fetch(`${this.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`deepseek responses http ${res.status}: ${text.slice(0, 160)}`);
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    const text = (json.output || [])
      .filter((o) => o.type === 'message')
      .flatMap((o) => o.content || [])
      .filter((c) => c.type === 'output_text')
      .map((c) => c.text)
      .join('');
    if (text && text.trim()) return text;
    const err = new Error(`deepseek 返回内容为空（status=${json.status}）`);
    err.status = 500; // 视为可重试
    throw err;
  }

  async chat(messages, { maxOutputTokens = 2500, webSearch = true } = {}) {
    // 先用搜索；失败/超时再试一次搜索；仍失败则退回不搜
    const plan = webSearch ? [true, true, false] : [false];
    let lastErr;
    for (let i = 0; i < plan.length; i++) {
      try {
        return await this._call(messages, { maxOutputTokens, webSearch: plan[i] });
      } catch (e) {
        lastErr = e;
        const s = e.status;
        const retryable = s === undefined || s >= 500 || s === 429 || s === 408;
        if (!retryable) throw e;
        if (i < plan.length - 1) await new Promise((r) => setTimeout(r, 1200));
      }
    }
    throw lastErr;
  }
}
