// DeepSeek 官方价格（人民币），用来估算每次调用的花费、执行每日花费上限。
// 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing （2026-11-17 查阅）。官方调价时改这里。
// - token 单价按“每百万 token”计。输入分缓存命中、未命中两档；输出含思考消耗的 token。
// - 高峰时段：北京时间周一至周五 9:00–12:00、14:00–18:00，其余时间（含周末）为空闲时段，价格减半。
//   官方高峰不含法定节假日，这里不识别节假日，一律按工作日估算：节假日会算得偏高，不会偏低。
// - 联网搜索、读网页按次计费，不分时段。
// 这只是估算：实际扣费以 DeepSeek 账单为准。

export const PRICES_CNY = {
  'deepseek-v4-pro': {
    peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
  },
  'deepseek-flash': {
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  },
};
export const SEARCH_PRICE_CNY = 0.005; // 每次搜索（文字或图片），5 元 / 千次
export const FETCH_PRICE_CNY = 0.005; // 每次读网页，5 元 / 千次
const FALLBACK_MODEL = 'deepseek-v4-pro'; // 价目表里没有的模型按最贵的估算，宁可偏高

const BEIJING_OFFSET_MS = 8 * 3_600_000; // 北京时间是 UTC+8，没有夏令时

function beijing(at) {
  const t = new Date(at.getTime() + BEIJING_OFFSET_MS);
  return { weekday: t.getUTCDay(), minutes: t.getUTCHours() * 60 + t.getUTCMinutes(), date: t.toISOString().slice(0, 10) };
}

// 北京时间的日期，例如 '2026-11-17'。每日花费上限按这个日期划分。
export function beijingDate(at = new Date()) {
  return beijing(at).date;
}

export function isPeak(at = new Date()) {
  const { weekday, minutes } = beijing(at);
  if (weekday === 0 || weekday === 6) return false;
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
}

/**
 * 估算一次调用的花费（元）。
 * @param {object} args
 * @param {string} args.model
 * @param {{inputTokens: number, cachedTokens: number, outputTokens: number, searches: number, fetches: number}} args.usage
 *   inputTokens 含缓存命中的部分（cachedTokens），outputTokens 含思考部分。
 * @param {Date} [args.at] 调用时间，决定按高峰还是空闲价格
 */
export function estimateCostCny({ model, usage, at = new Date() }) {
  const table = PRICES_CNY[model] ?? PRICES_CNY[FALLBACK_MODEL];
  const price = isPeak(at) ? table.peak : table.offPeak;
  const cached = Math.min(usage.cachedTokens, usage.inputTokens);
  const tokenCost = (usage.inputTokens - cached) * price.cacheMiss + cached * price.cacheHit + usage.outputTokens * price.output;
  return tokenCost / 1e6 + usage.searches * SEARCH_PRICE_CNY + usage.fetches * FETCH_PRICE_CNY;
}
