/**
 * 综合搜索（不依赖 API key）：Bing 主、DuckDuckGo 备。
 *
 * 只解析标题/链接/摘要，不做深度抓取；需要正文时交给 link-reader。
 * 抓不到就返回空 + 原因，不编造结果。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

async function fetchHtml(url, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return { ok: true, html: await res.text() };
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 解 Bing 的跳转链接（/ck/a?u=a1aHR0cHM6...）。 */
export function decodeBingUrl(href) {
  const text = String(href || '');
  const m = text.match(/[?&]u=a1([A-Za-z0-9_-]+)/);
  if (!m) return text;
  try {
    return Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return text;
  }
}

/** 解 DuckDuckGo 的跳转链接（//duckduckgo.com/l/?uddg=...）。 */
export function decodeDdgUrl(href) {
  const text = String(href || '');
  const m = text.match(/[?&]uddg=([^&]+)/);
  if (!m) return text;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return text;
  }
}

/**
 * 解析 Bing 结果页。
 * 注意：不能用一个正则把标题和摘要一起抓 —— 摘要那段是可选的，正则会直接跳过它，
 * 所以先按 <li class="b_algo"> 切块，再在块内分别取标题与摘要。
 */
export function parseBing(html, { limit = 8 } = {}) {
  const out = [];
  const blocks = String(html || '').split(/<li class="b_algo"/i).slice(1);
  for (const block of blocks) {
    if (out.length >= limit) break;
    const link = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = decodeBingUrl(link[1]);
    const title = stripTags(link[2]);
    if (!/^https?:\/\//i.test(url) || !title) continue;
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    out.push({ title, url, snippet: stripTags(snippet?.[1] || '').slice(0, 200), engine: 'bing' });
  }
  return out;
}

/** 解析 DuckDuckGo HTML 版。 */
export function parseDuckDuckGo(html, { limit = 8 } = {}) {
  const out = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null && out.length < limit) {
    const url = decodeDdgUrl(m[1]);
    const title = stripTags(m[2]);
    if (!/^https?:\/\//i.test(url) || !title) continue;
    out.push({ title, url, snippet: '', engine: 'ddg' });
  }
  return out;
}

/**
 * 搜索。
 * @param {string} query
 * @param {{site?: string, limit?: number, engine?: 'bing'|'ddg'}} options site 用于限定站内（如 mp.weixin.qq.com）
 */
export async function webSearch(query, { site = '', limit = 8, engine = 'bing' } = {}) {
  const q = `${query}${site ? ` site:${site}` : ''}`.trim();
  if (!q) return { ok: false, reason: '空查询', items: [] };

  const attempts = engine === 'ddg'
    ? [['ddg', `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`], ['bing', `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN`]]
    : [['bing', `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN`], ['ddg', `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`]];

  const reasons = [];
  for (const [name, url] of attempts) {
    const res = await fetchHtml(url);
    if (!res.ok) {
      reasons.push(`${name}: ${res.reason}`);
      continue;
    }
    const items = name === 'bing' ? parseBing(res.html, { limit }) : parseDuckDuckGo(res.html, { limit });
    if (items.length) return { ok: true, items, engine: name, query: q };
    reasons.push(`${name}: 没解析到结果`);
  }
  return { ok: false, reason: reasons.join('；'), items: [], query: q };
}
