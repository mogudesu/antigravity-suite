/**
 * 链接深读：优先用本机 Envoy（证据级），没装就退回 Jina Reader，再不行如实报错。
 *
 * 关键原则（照抄 Envoy 的工程约定）：读不到就说读不到，绝不凭标题编内容。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

async function fetchWithTimeout(url, { timeoutMs = 25000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, ...headers }, signal: controller.signal });
    return { ok: res.ok, status: res.status, text: await res.text().catch(() => '') };
  } catch (error) {
    return { ok: false, status: 0, text: '', reason: error?.name === 'AbortError' ? 'timeout' : error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读一个链接。
 * @returns {{ok: boolean, engine: 'envoy'|'jina'|'none', text: string, reason: string, partial: boolean}}
 */
/** 需要登录态才能读的平台（没有公开扫码接口，只能导入浏览器 cookie）。 */
const COOKIE_HOSTS = [
  ['xiaohongshu.com', 'xhs'], ['xhslink.com', 'xhs'],
  ['douyin.com', 'douyin'], ['iesdouyin.com', 'douyin'],
  ['x.com', 'twitter'], ['twitter.com', 'twitter'],
];

/** 按域名挑该用哪份 cookie。 */
export function cookieKeyFor(url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
  for (const [domain, key] of COOKIE_HOSTS) {
    if (host === domain || host.endsWith(`.${domain}`)) return key;
  }
  return '';
}

function looksLikeLoginPage(text) {
  const sample = String(text || '').slice(0, 2000);
  return /(登录|扫码登录|请先登录|Sign in|Log in)/.test(sample) && sample.length < 3000;
}

/**
 * 带 cookie 直连抓一次（小红书/抖音/X 这类必须登录态的站点）。
 * 拿到正文就直接用，避免白白走一遍 Jina。
 */
async function fetchWithCookie(url, cookie, { timeoutMs = 20000, maxChars = 8000 } = {}) {
  const res = await fetchWithTimeout(url, {
    timeoutMs,
    headers: { cookie, accept: 'text/html,application/xhtml+xml' },
  });
  if (!res.ok || !res.text) return { ok: false, reason: res.reason || `HTTP ${res.status}` };
  const text = res.text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (plain.length < 300 || looksLikeLoginPage(plain)) {
    return { ok: false, reason: 'cookie 可能失效（拿到的是登录页或空壳）' };
  }
  return { ok: true, text: plain.slice(0, maxChars) };
}

/**
 * 读一个链接。
 * @param {{allowJina?: boolean, maxChars?: number, cookie?: string}} options
 */
export async function readLink(url, { allowJina = true, maxChars = 8000, cookie = '' } = {}) {
  // 0) 需要登录态的平台：先拿 cookie 直连（Envoy/Jina 都带不上 cookie）
  if (cookie) {
    const direct = await fetchWithCookie(url, cookie, { maxChars });
    if (direct.ok) return { ok: true, engine: 'cookie', text: direct.text, reason: '', partial: false };
  }

  // 1) 本机 Envoy CLI（如果装了）
  const envoy = await new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => {
      const child = spawn('envoy', ['read', url, '--json'], { windowsHide: true });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolve({ ok: false, reason: 'envoy 超时' });
      }, 30000);
      child.stdout.on('data', (c) => {
        out += String(c);
      });
      child.stderr.on('data', (c) => {
        err += String(c);
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ ok: false, reason: 'envoy-not-installed' });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return resolve({ ok: false, reason: err.slice(0, 200) || `envoy exit ${code}` });
        try {
          const data = JSON.parse(out);
          const status = data.status || data.result?.status || '';
          const text = String(data.text || data.content || data.result?.text || '');
          if (!text) return resolve({ ok: false, reason: `envoy 返回 ${status || '空内容'}` });
          resolve({ ok: true, text, partial: status === 'partial' || status === 'blocked', status });
        } catch {
          resolve({ ok: false, reason: 'envoy 输出解析失败' });
        }
      });
    });
  });
  if (envoy.ok) return { ok: true, engine: 'envoy', text: envoy.text.slice(0, maxChars), reason: '', partial: Boolean(envoy.partial) };

  // 2) 退到 Jina Reader（免费、无需 key）
  if (allowJina) {
    const res = await fetchWithTimeout(`https://r.jina.ai/${url}`);
    if (res.ok && res.text && res.text.length > 200) {
      return { ok: true, engine: 'jina', text: res.text.slice(0, maxChars), reason: '', partial: false };
    }
    return {
      ok: false,
      engine: 'none',
      text: '',
      reason: `Envoy 不可用（${envoy.reason}），Jina 也失败（${res.reason || `HTTP ${res.status}`}）`,
      partial: false,
    };
  }
  return { ok: false, engine: 'none', text: '', reason: `Envoy 不可用：${envoy.reason}`, partial: false };
}

/** 把读到的正文压成可读摘要素材（保留小标题，去掉导航噪音）。 */
export function condense(text, { maxChars = 3000 } = {}) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^(登录|注册|下载 APP|打开 App|返回顶部|分享|点赞|收藏)/.test(line));
  const body = lines.join('\n');
  return body.length > maxChars ? `${body.slice(0, maxChars)}\n…（已截断）` : body;
}
