/**
 * 链接路由：决定"这个链接要不要用 Envoy 深读"，并生成注入给 Agent 的提示。
 *
 * 依据 Envoy 官方 skill 的判断表：
 *  - 平台页（小红书/抖音/B 站/公众号/微博/知乎/YouTube）普通抓取必失败 → 必须 Envoy；
 *  - 代码托管的具体 Diff 页（/commit /blob /tree /pull /issues /compare）Envoy 也读不到 diff → 不要用；
 *  - 内网/本机地址一律不深读；
 *  - 用户说"不用 envoy"就不注入。
 */
import { isPrivateHost } from './share-card.mjs';

/** 需要 Envoy 才能读的平台（普通 fetch 会 403/空壳）。 */
const ENVOY_HOSTS = [
  'xiaohongshu.com',
  'xhslink.com',
  'douyin.com',
  'iesdouyin.com',
  'bilibili.com',
  'b23.tv',
  'mp.weixin.qq.com',
  'weixin.qq.com',
  'weibo.com',
  'weibo.cn',
  'zhihu.com',
  'youtube.com',
  'youtu.be',
  'twitter.com',
  'x.com',
];

/** 代码托管的"具体文件/Diff"路径：Envoy 只回标题，不如 gh/git。 */
const CODE_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org'];
const CODE_PATH_RE = /^\/([^/]+\/[^/]+\/)?(commit|blob|tree|pull|issues|compare|raw|releases\/tag)\b/i;

export function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function matchHost(host, list) {
  return list.some((item) => host === item || host.endsWith(`.${item}`));
}

/**
 * @returns {{needEnvoy: boolean, reason: string, kind: 'platform'|'code'|'private'|'plain'|'invalid'}}
 */
export function classifyLink(url) {
  const host = hostOf(url);
  if (!host) return { needEnvoy: false, reason: '不是合法 URL', kind: 'invalid' };
  if (isPrivateHost(host)) return { needEnvoy: false, reason: '内网/本机地址，不深读', kind: 'private' };
  if (matchHost(host, CODE_HOSTS)) {
    let pathname = '/';
    try {
      pathname = new URL(url).pathname;
    } catch {
      /* ignore */
    }
    if (CODE_PATH_RE.test(pathname)) {
      return { needEnvoy: false, reason: '代码 Diff/文件页：Envoy 读不到 diff，用 gh/git', kind: 'code' };
    }
    return { needEnvoy: true, reason: '仓库主页/README：可深读', kind: 'code' };
  }
  if (matchHost(host, ENVOY_HOSTS)) {
    return { needEnvoy: true, reason: '平台页需要渲染/登录态，普通抓取会失败', kind: 'platform' };
  }
  return { needEnvoy: false, reason: '普通网页：先直接抓，失败再升级', kind: 'plain' };
}

/**
 * 给一批 URL 生成注入提示（没有需要深读的就返回空串）。
 * @param {{skip?: boolean, userSaidNoEnvoy?: boolean}} options
 */
export function buildRoutingHint(urls = [], { userSaidNoEnvoy = false, max = 3 } = {}) {
  if (userSaidNoEnvoy) return '';
  const picked = urls
    .map((url) => ({ url, ...classifyLink(url) }))
    .filter((item) => item.needEnvoy)
    .slice(0, max);
  if (!picked.length) return '';
  const lines = picked.map((item, i) => `${i + 1}. ${item.url}（${item.reason}）`);
  return [
    '[envoy-link-routing] 用户发来的链接里有需要证据级深读的内容：',
    ...lines,
    '请用 Envoy 的 envoy_read 读取上述链接，输出带 [mm:ss] 时间戳或段落坐标的结构化笔记；',
    '读不到（blocked / partial / needs_host）时如实说明缺口，不要凭标题猜测内容。',
  ].join('\n');
}

/** 用户是否明确说"不用 envoy"。 */
export function userOptedOut(text) {
  return /(不用|别用|不要用)\s*envoy|no envoy/i.test(String(text || ''));
}
