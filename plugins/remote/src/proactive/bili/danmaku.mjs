/**
 * 弹幕解析与"高能时刻"定位。
 *
 * 现实问题：大量视频的弹幕被"打卡/前排/来了"这类开场仪式刷屏，直接取 Top 会全挤在第 0-30 秒。
 * 做法：按 30 秒分桶 → 某个桶占全片 >30% 判定为刷屏仪式 → 剔除该桶 → 剩下的 Top 5 才是真高能。
 *
 * 弹幕 XML 常见两种编码：普通 deflate（带 zlib 头）和 raw deflate（无头），都要能解。
 */
import zlib from 'node:zlib';

const BUCKET_SECONDS = 30;

/** 解压弹幕响应体（自动识别 gzip / zlib deflate / raw deflate / 明文）。 */
export function decodeDanmakuBuffer(buffer, { encoding = '' } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (!buf.length) return '';
  const head = buf.subarray(0, 2).toString('hex');
  if (encoding.includes('gzip') || head === '1f8b') {
    try {
      return zlib.gunzipSync(buf).toString('utf8');
    } catch {
      /* 落到下面 */
    }
  }
  // 明文 XML 直接返回
  if (buf.subarray(0, 1).toString('utf8') === '<') return buf.toString('utf8');
  // zlib 头（78 01 / 78 9c / 78 da）
  if (/^78(01|9c|da)$/.test(head)) {
    try {
      return zlib.inflateSync(buf).toString('utf8');
    } catch {
      /* 落到 raw */
    }
  }
  try {
    return zlib.inflateRawSync(buf).toString('utf8');
  } catch {
    return buf.toString('utf8');
  }
}

/** 解析 `<d p="time,mode,...">文本</d>`。 */
export function parseDanmakuXml(xml) {
  const out = [];
  const re = /<d p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
  let match;
  while ((match = re.exec(String(xml || ''))) !== null) {
    const parts = match[1].split(',');
    const time = Number(parts[0]);
    if (!Number.isFinite(time)) continue;
    out.push({ time, text: decodeXmlEntities(match[2]).trim() });
  }
  return out;
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 按 30 秒分桶。 */
export function bucketize(danmaku, bucketSeconds = BUCKET_SECONDS) {
  const buckets = new Map();
  for (const item of danmaku) {
    const index = Math.floor(item.time / bucketSeconds);
    const bucket = buckets.get(index) || { index, start: index * bucketSeconds, items: [] };
    bucket.items.push(item);
    buckets.set(index, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.index - b.index);
}

/**
 * 找出"高能时刻"：剔除占全片 >spamRatio 的刷屏桶，再按弹幕密度取前 topN。
 * @returns {{moments: Array<{at: number, count: number, samples: string[]}>, spamBuckets: Array<{start: number, ratio: number}>}}
 */
export function findHighlights(danmaku, { bucketSeconds = BUCKET_SECONDS, topN = 5, spamRatio = 0.3, sampleSize = 3 } = {}) {
  const total = danmaku.length;
  if (!total) return { moments: [], spamBuckets: [] };
  const buckets = bucketize(danmaku, bucketSeconds);
  const spamBuckets = [];
  const kept = [];
  for (const bucket of buckets) {
    const ratio = bucket.items.length / total;
    if (ratio > spamRatio && bucket.items.length > 20) {
      spamBuckets.push({ start: bucket.start, ratio: Number(ratio.toFixed(2)), count: bucket.items.length });
      continue;
    }
    kept.push(bucket);
  }
  const moments = kept
    .sort((a, b) => b.items.length - a.items.length)
    .slice(0, topN)
    .sort((a, b) => a.start - b.start)
    .map((bucket) => ({
      at: bucket.start,
      count: bucket.items.length,
      samples: dedupe(bucket.items.map((i) => i.text)).slice(0, sampleSize),
    }));
  return { moments, spamBuckets };
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** mm:ss */
export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
