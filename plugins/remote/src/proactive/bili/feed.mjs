/**
 * B 站四源选题：关注 UP 动态 + 偏好词搜索 + 热门 + 排行榜。
 *
 * 全部只读公开接口（带 WBI 签名的走签名），不做任何写操作，不投币不评论。
 * 拿不到（风控/未登录）就返回空 + 原因，绝不编造内容。
 */
import { mixinFromNav, signedUrl } from './wbi.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';
const BASE = 'https://api.bilibili.com';

async function getJson(url, { cookie = '', timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        referer: 'https://www.bilibili.com/',
        ...(cookie ? { cookie } : {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const data = await res.json();
    if (data?.code && data.code !== 0) return { ok: false, reason: `code ${data.code} ${data.message || ''}`.trim(), data };
    return { ok: true, data };
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** 把接口返回的视频条目归一。 */
export function normalizeVideo(item = {}, source = '') {
  const bvid = item.bvid || item.bv_id || '';
  const stat = item.stat || {};
  return {
    platform: 'bili',
    source,
    bvid,
    title: String(item.title || '').replace(/<[^>]+>/g, '').trim(),
    author: item.owner?.name || item.author || item.name || '',
    desc: String(item.desc || '').slice(0, 300),
    duration: Number(item.duration || 0),
    url: bvid ? `https://www.bilibili.com/video/${bvid}` : item.short_link_v2 || '',
    cover: item.pic || item.cover || '',
    stats: { view: Number(stat.view || item.play || 0), like: Number(stat.like || item.like || 0), danmaku: Number(stat.danmaku || 0) },
    pubdate: Number(item.pubdate || item.pub_time || 0),
  };
}

/** 取 WBI mixinKey（nav 接口，未登录也能拿到）。 */
export async function fetchMixin({ cookie = '' } = {}) {
  // 未登录时 nav 会返回 -101，但 wbi_img 往往仍然给 —— 别当失败丢掉
  const res = await getJson(`${BASE}/x/web-interface/nav`, { cookie });
  const mixin = mixinFromNav(res.data);
  if (mixin) return mixin;
  return res.ok ? '' : '';
}

/** 偏好词搜索（走 WBI 签名）。 */
export async function searchVideos(keyword, { cookie = '', limit = 8, mixin = '' } = {}) {
  const key = mixin || (await fetchMixin({ cookie }));
  if (!key) return { ok: false, reason: '拿不到 WBI 签名（nav 接口失败）', items: [] };
  const url = signedUrl(`${BASE}/x/web-interface/wbi/search/type`, { search_type: 'video', keyword, page: 1, page_size: limit }, key);
  const res = await getJson(url, { cookie });
  if (!res.ok) return { ok: false, reason: res.reason, items: [] };
  const list = res.data?.data?.result || [];
  return { ok: true, items: list.map((item) => normalizeVideo(item, 'search')) };
}

/** 热门。 */
export async function popularVideos({ cookie = '', limit = 10 } = {}) {
  const res = await getJson(`${BASE}/x/web-interface/popular?ps=${limit}&pn=1`, { cookie });
  if (!res.ok) return { ok: false, reason: res.reason, items: [] };
  return { ok: true, items: (res.data?.data?.list || []).map((item) => normalizeVideo(item, 'popular')) };
}

/** 排行榜（分区 rid：0 全站 / 188 科技 / 36 知识）。 */
export async function rankingVideos({ rid = 188, cookie = '', limit = 10 } = {}) {
  const res = await getJson(`${BASE}/x/web-interface/ranking/v2?rid=${rid}&type=all`, { cookie });
  if (!res.ok) return { ok: false, reason: res.reason, items: [] };
  return { ok: true, items: (res.data?.data?.list || []).slice(0, limit).map((item) => normalizeVideo(item, 'ranking')) };
}

/** 关注 UP 的最新投稿（需要登录 cookie；没有就跳过）。 */
export async function followedVideos({ cookie = '', mid = '', limit = 10 } = {}) {
  if (!cookie) return { ok: false, reason: '需要登录 cookie', items: [] };
  if (!mid) return { ok: false, reason: '未配置关注 UP 的 mid', items: [] };
  const res = await getJson(`${BASE}/x/space/wbi/arc/search?mid=${mid}&ps=${limit}&pn=1`, { cookie });
  if (!res.ok) return { ok: false, reason: res.reason, items: [] };
  const list = res.data?.data?.list?.vlist || [];
  return { ok: true, items: list.map((item) => normalizeVideo({ ...item, bvid: item.bvid }, 'following')) };
}

/**
 * 四源合一：并发拉取，按 bvid 去重，按互动量粗排。
 * @returns {{items: object[], sources: Record<string, {ok: boolean, reason?: string, count: number}>}}
 */
export async function collectCandidates({ keywords = [], cookie = '', upMids = [], limit = 20 } = {}) {
  const sources = {};
  const tasks = [];
  const mixin = await fetchMixin({ cookie });

  tasks.push(
    popularVideos({ cookie, limit: 10 }).then((r) => ['popular', r]),
    rankingVideos({ rid: 188, cookie, limit: 10 }).then((r) => ['ranking', r]),
  );
  for (const keyword of keywords.slice(0, 3)) {
    tasks.push(searchVideos(keyword, { cookie, limit: 6, mixin }).then((r) => [`search:${keyword}`, r]));
  }
  for (const mid of upMids.slice(0, 3)) {
    tasks.push(followedVideos({ cookie, mid, limit: 5 }).then((r) => [`following:${mid}`, r]));
  }

  const results = await Promise.all(tasks);
  const seen = new Set();
  const items = [];
  for (const [name, result] of results) {
    sources[name] = { ok: Boolean(result.ok), reason: result.reason || '', count: (result.items || []).length };
    for (const item of result.items || []) {
      if (!item.bvid || seen.has(item.bvid)) continue;
      seen.add(item.bvid);
      items.push(item);
    }
  }
  items.sort((a, b) => b.stats.view + b.stats.like * 10 - (a.stats.view + a.stats.like * 10));
  return { items: items.slice(0, limit), sources };
}
