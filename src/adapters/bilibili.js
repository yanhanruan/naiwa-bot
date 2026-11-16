// B站只读适配器：通过公开接口拉取内容，转成统一内容项。
// 只读、无鉴权、不绕过平台限制、不批量抓取。写操作（评论/点赞）一律不在此实现。

import { randomUUID } from 'node:crypto';

function makeBuvid() {
  return `uuid-${randomUUID().replace(/-/g, '').slice(0, 16)}infoc`;
}

function stripHtml(s) {
  return String(s ?? '').replace(/<[^>]+>/g, '');
}

// 归一化：同时兼容「热门列表」与「搜索结果」两种返回结构。
export function normalizeVideo(v) {
  const title = stripHtml(v.title);
  const bvid = v.bvid ?? null;
  return {
    id: bvid ? `bilibili:video:${bvid}` : `bilibili:video:${v.aid}`,
    platform: 'bilibili',
    kind: 'content.video',
    title,
    author: v.author ?? v.owner?.name ?? null,
    url: bvid ? `https://www.bilibili.com/video/${bvid}` : null,
    stats: {
      view: v.play ?? v.stat?.view ?? 0,
      like: v.like ?? v.stat?.like ?? 0,
      danmaku: v.video_review ?? v.stat?.danmaku ?? 0,
      reply: v.review ?? v.stat?.reply ?? 0,
    },
    publishedAt: v.pubdate ? Number(v.pubdate) * 1000 : null,
  };
}

export class BilibiliAdapter {
  constructor({ baseUrl = 'https://api.bilibili.com', headers = {} } = {}) {
    this.baseUrl = baseUrl;
    this.headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Referer: 'https://www.bilibili.com/',
      Cookie: `buvid3=${makeBuvid()}; buvid4=0;`,
      ...headers,
    };
  }

  async _get(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
    let res;
    try {
      res = await fetch(url, { headers: this.headers });
    } catch (err) {
      throw new Error(`bilibili network error: ${err.message}`);
    }
    if (!res.ok) throw new Error(`bilibili http ${res.status}`);
    const body = await res.json();
    if (body.code !== 0) throw new Error(`bilibili api code ${body.code}: ${body.message ?? ''}`);
    return body.data;
  }

  async popular({ ps = 10, pn = 1 } = {}) {
    const data = await this._get('/x/web-interface/popular', { ps, pn });
    return (data.list ?? []).map(normalizeVideo);
  }

  async search(keyword, { pageSize = 10, page = 1 } = {}) {
    if (!keyword) throw new Error('search keyword required');
    const data = await this._get('/x/web-interface/search/type', {
      search_type: 'video',
      keyword,
      page,
      page_size: pageSize,
    });
    return (data.result ?? []).map(normalizeVideo);
  }
}
