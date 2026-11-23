// 下载 QQ 图片（docs/image-understanding-design.md 4.3 节）：
// - 只从 QQ 的图片服务器下载，跳转后也要是：图片地址来自消息，不能让它把机器人引去访问本机或内网的服务；
// - 最大 10 MB，超过就停下不要了（图片消息段里没有文件大小，下载时才知道）；
// - 只认 JPEG、PNG、GIF、WebP（按文件开头几个字节判断），DeepSeek 只支持这四种；
// - 不存盘，只在内存里；能被取消（看图共用的 20 秒到了）。
// 错误信息是固定的说明，不带地址（地址里有下载凭证）。

export const DOWNLOAD_DEFAULTS = {
  maxBytes: 10 * 1024 * 1024,
  hosts: ['qq.com.cn', 'qpic.cn', 'qq.com'], // 域名是它们本身，或者以“.它们”结尾
  maxRedirects: 3,
};

export class DownloadError extends Error {
  /** @param {'BAD_URL'|'BAD_HOST'|'HTTP'|'TOO_LARGE'|'BAD_FORMAT'|'NETWORK'|'ABORTED'} code */
  constructor(code, message) {
    super(message ?? code);
    this.name = 'DownloadError';
    this.code = code;
  }
}

/** 地址能不能下：http(s)，域名在白名单里。 */
export function allowedUrl(url, hosts = DOWNLOAD_DEFAULTS.hosts) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/** 按文件开头几个字节认格式：返回 MIME 类型，认不出返回 null。 */
export function imageType(bytes) {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  const ascii = (from, to) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * 下载一张图。成功返回 { mime, bytes }；失败抛 DownloadError。
 * @param {string} url
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {typeof fetch} [opts.fetchImpl]
 */
export async function downloadImage(url, {
  signal = null, fetchImpl = globalThis.fetch, maxBytes = DOWNLOAD_DEFAULTS.maxBytes,
  hosts = DOWNLOAD_DEFAULTS.hosts, maxRedirects = DOWNLOAD_DEFAULTS.maxRedirects,
} = {}) {
  if (typeof url !== 'string' || !url) throw new DownloadError('BAD_URL', '没有下载地址');
  let current = url;
  let res;
  for (let hop = 0; ; hop += 1) {
    if (!allowedUrl(current, hosts)) throw new DownloadError('BAD_HOST', '不是 QQ 图片服务器的地址');
    try {
      // 跳转自己跟，每一跳都检查域名。
      res = await fetchImpl(current, { redirect: 'manual', signal });
    } catch {
      if (signal?.aborted) throw new DownloadError('ABORTED', '下载被取消');
      throw new DownloadError('NETWORK', '下载失败');
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => {});
      if (hop >= maxRedirects) throw new DownloadError('HTTP', '跳转太多次');
      try {
        current = new URL(res.headers.get('location'), current).href;
      } catch {
        throw new DownloadError('BAD_URL', '跳转地址无效');
      }
      continue;
    }
    break;
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new DownloadError('HTTP', `图片服务器返回 ${res.status}`);
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new DownloadError('TOO_LARGE', '图片超过大小上限');
  }
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of res.body ?? []) {
      total += chunk.length;
      if (total > maxBytes) {
        await res.body.cancel().catch(() => {});
        throw new DownloadError('TOO_LARGE', '图片超过大小上限');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    if (signal?.aborted) throw new DownloadError('ABORTED', '下载被取消');
    throw new DownloadError('NETWORK', '下载失败');
  }
  const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const mime = imageType(bytes);
  if (!mime) throw new DownloadError('BAD_FORMAT', '不是 JPEG、PNG、GIF、WebP');
  return { mime, bytes };
}
