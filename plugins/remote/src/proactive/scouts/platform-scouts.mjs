/**
 * 平台探针：把"搜哪个平台"变成具体的站内检索。
 *
 * 全部走「搜索引擎 + site: 限定」，不依赖各平台私有的登录接口 —— 好处是立刻能用、
 * 不会因为平台改版/风控就整块挂掉；代价是拿不到平台内部的排序与热榜。
 * 需要正文时再交给 link-reader 深读（读不到就如实报缺口）。
 */
import { webSearch } from './web-search.mjs';

export const PLATFORMS = {
  bili: { label: 'B 站', site: '', kind: 'api' },
  wechatMp: { label: '公众号', site: 'mp.weixin.qq.com', kind: 'search' },
  xhs: { label: '小红书', site: 'xiaohongshu.com', kind: 'search' },
  douyin: { label: '抖音', site: 'douyin.com', kind: 'search' },
  twitter: { label: 'X / Twitter', site: 'x.com', kind: 'search' },
  web: { label: '综合搜索', site: '', kind: 'search' },
};

export const DEFAULT_PLATFORMS = {
  bili: true,
  wechatMp: false,
  xhs: false,
  douyin: false,
  twitter: false,
  web: true,
};

/** 归一化平台开关（缺省按 DEFAULT_PLATFORMS）。 */
export function normalizePlatforms(input = {}) {
  const out = { ...DEFAULT_PLATFORMS };
  for (const key of Object.keys(PLATFORMS)) {
    if (typeof input[key] === 'boolean') out[key] = input[key];
  }
  return out;
}

export function enabledPlatforms(input) {
  const flags = normalizePlatforms(input);
  return Object.keys(PLATFORMS).filter((key) => flags[key]);
}

/**
 * 用站内检索跑一个平台。
 * @returns {{ok: boolean, items: object[], reason?: string}}
 */
export async function scoutPlatform(platform, keywords = [], { limit = 5 } = {}) {
  const meta = PLATFORMS[platform];
  if (!meta || meta.kind !== 'search') return { ok: false, items: [], reason: '该平台不支持检索' };
  if (!keywords.length) return { ok: false, items: [], reason: '没有关键词' };

  const collected = [];
  const reasons = [];
  for (const keyword of keywords.slice(0, 2)) {
    const res = await webSearch(keyword, { site: meta.site, limit });
    if (!res.ok) {
      reasons.push(`${keyword}: ${res.reason}`);
      continue;
    }
    for (const item of res.items) {
      collected.push({
        platform,
        source: `${platform}:${res.engine}`,
        title: item.title,
        url: item.url,
        desc: item.snippet || '',
        stats: {},
        pubdate: 0,
      });
    }
  }
  const seen = new Set();
  const items = collected.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
  return items.length
    ? { ok: true, items: items.slice(0, limit * 2) }
    : { ok: false, items: [], reason: reasons.join('；') || '没有结果' };
}

/** 各平台当前的可用性说明（面板上直接显示，别让人猜）。 */
export function platformStatus(flags = {}, { biliLoggedIn = false } = {}) {
  return Object.entries(PLATFORMS).map(([key, meta]) => ({
    key,
    label: meta.label,
    enabled: normalizePlatforms(flags)[key],
    ready: key === 'bili' ? biliLoggedIn : true,
    note: key === 'bili'
      ? (biliLoggedIn ? '已登录，可用关注/排行/字幕/弹幕' : '未登录：只能用热门/搜索，字幕弹幕受限')
      : (meta.site ? `站内检索 site:${meta.site}` : '通用网页检索'),
  }));
}
