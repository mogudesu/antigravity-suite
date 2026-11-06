/**
 * B 站扫码登录（官方 passport 二维码接口），只读用途：拿 cookie 换"关注动态/字幕/排行"。
 *
 * 流程：generate 拿 qrcode_key + url → 面板渲染二维码 → poll 轮询
 *  86101 未扫码 / 86090 已扫码待确认 / 0 成功（返回带 SESSDATA 的 url 与 Set-Cookie）/ 86038 过期
 * 成功后立即用 nav 校验并取昵称，cookie 只落本地 secrets，永不回显。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';
const QR_GENERATE = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const QR_POLL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';

const STATUS_MAP = {
  0: 'confirmed',
  86101: 'wait',
  86090: 'scanned',
  86038: 'expired',
};

async function getJson(url, { cookie = '', timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', ...(cookie ? { cookie } : {}) },
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* 保留 text 供排查 */
    }
    return { ok: res.ok, status: res.status, data, headers: res.headers, text };
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** 申请二维码。 */
export async function generateQr() {
  const res = await getJson(QR_GENERATE);
  const data = res.data?.data;
  if (!res.ok || !data?.qrcode_key || !data?.url) {
    return { ok: false, reason: res.reason || `生成失败（HTTP ${res.status}）` };
  }
  return { ok: true, qrcodeKey: data.qrcode_key, url: data.url };
}

/** 从 Set-Cookie 与回跳 url 里提取 cookie 串。 */
export function extractCookie(headers, redirectUrl = '') {
  const jar = new Map();
  const setCookie = typeof headers?.getSetCookie === 'function' ? headers.getSetCookie() : [];
  for (const line of setCookie || []) {
    const [pair] = String(line).split(';');
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  // 回跳 url 的 query 里也带了一份（DedeUserID / SESSDATA / bili_jct）
  try {
    const url = new URL(redirectUrl);
    for (const [key, value] of url.searchParams.entries()) {
      if (/^(SESSDATA|bili_jct|DedeUserID|DedeUserID__ckMd5|sid|buvid3)$/i.test(key)) {
        jar.set(key, value);
      }
    }
  } catch {
    /* 没有回跳 url 就算了 */
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** 轮询扫码结果。 */
export async function pollQr(qrcodeKey) {
  if (!qrcodeKey) return { ok: false, status: 'invalid', reason: '缺少 qrcode_key' };
  const res = await getJson(`${QR_POLL}?qrcode_key=${encodeURIComponent(qrcodeKey)}`);
  if (!res.ok || !res.data) return { ok: false, status: 'error', reason: res.reason || `HTTP ${res.status}` };
  const code = Number(res.data?.data?.code ?? res.data?.code ?? -1);
  const status = STATUS_MAP[code] || 'unknown';
  if (status !== 'confirmed') return { ok: true, status, code };
  const cookie = extractCookie(res.headers, res.data?.data?.url || '');
  return { ok: true, status, code, cookie };
}

/** 用 cookie 校验登录态，顺带拿昵称。 */
export async function verifyCookie(cookie) {
  if (!cookie) return { ok: false, reason: '没有 cookie' };
  const res = await getJson('https://api.bilibili.com/x/web-interface/nav', { cookie });
  const data = res.data?.data;
  if (!res.ok || !data?.isLogin) {
    return { ok: false, reason: res.data?.message || 'cookie 无效或已过期' };
  }
  return { ok: true, name: data.uname || '', mid: String(data.mid || ''), vip: Boolean(data.vipStatus) };
}
