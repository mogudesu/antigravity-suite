/**
 * 飞书接入辅助：凭据校验 + 扫码一键建应用。
 *
 * - 校验：先用 appId/appSecret 换 tenant_access_token，再读 /open-apis/bot/v3/info
 *   拿到机器人真实名称与头像，填错密钥会立刻报错，而不是等到收消息才发现。
 * - 扫码：用官方 SDK 的 registerApp，回调里拿到二维码 URL，交给面板渲染。
 */
import * as Lark from '@larksuiteoapi/node-sdk';

const DOMAINS = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

/**
 * registerApp 的 domain 要的是「主机名」，不是 URL 也不是 Domain 枚举：
 * SDK 内部会拼 `https://${domain}`，传枚举 0 会变成 https://0 → Invalid URL。
 */
const REGISTER_HOSTS = {
  feishu: 'accounts.feishu.cn',
  lark: 'accounts.larksuite.com',
};

export function domainBase(domain = 'feishu') {
  return DOMAINS[domain] || DOMAINS.feishu;
}

export function registerHost(domain = 'feishu') {
  return REGISTER_HOSTS[domain] || REGISTER_HOSTS.feishu;
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** 校验凭据并返回机器人身份。 */
export async function verifyCredentials({ appId, appSecret, domain = 'feishu' } = {}) {
  if (!appId || !appSecret) throw new Error('App ID 与 App Secret 必填');
  const base = domainBase(domain);
  const token = await postJson(`${base}/open-apis/auth/v3/tenant_access_token/internal`, { app_id: appId, app_secret: appSecret });
  if (token.code !== 0 || !token.tenant_access_token) {
    throw new Error(`凭据校验失败：${token.msg || token.code || '未知错误'}`);
  }
  const res = await fetch(`${base}/open-apis/bot/v3/info`, {
    headers: { authorization: `Bearer ${token.tenant_access_token}` },
  });
  const info = await res.json();
  if (info.code !== 0) throw new Error(`读取机器人信息失败：${info.msg || info.code}`);
  const bot = info.bot || {};
  return {
    ok: true,
    name: bot.app_name || '',
    avatar: bot.avatar_url || '',
    openId: bot.open_id || '',
    ipWhiteList: bot.ip_white_list || [],
  };
}

/**
 * 扫码一键创建/绑定应用。
 * @param {{domain?: string, source?: string, onQr: (url: string) => void, onStatus?: (status: string) => void, signal?: AbortSignal}} options
 */
export async function startRegister({ domain = 'feishu', source = 'antigravity-remote-mogu', onQr, onStatus, signal } = {}) {
  if (typeof Lark.registerApp !== 'function') throw new Error('当前 SDK 版本不支持扫码注册，请手动填写凭据');
  return Lark.registerApp({
    domain: registerHost(domain),
    source,
    signal,
    onQRCodeReady: (info) => {
      const url = typeof info === 'string' ? info : info?.url || info?.qrCodeUrl || info?.qr_code_url || '';
      if (url) onQr?.(url);
    },
    onStatusChange: (status) => onStatus?.(typeof status === 'string' ? status : status?.status || 'unknown'),
  });
}

/**
 * 把 registerApp 的返回值归一化。
 *
 * 实测 SDK 扫码成功后 resolve 的是 `{ client_id, client_secret, user_info }`，
 * 不是 `{appId, appSecret}` —— 按后者取会拿不到，白扫一次。
 */
export function normalizeRegisterResult(result) {
  const raw = result || {};
  const appId = raw.appId || raw.app_id || raw.client_id || raw.clientId || '';
  const appSecret = raw.appSecret || raw.app_secret || raw.client_secret || raw.clientSecret || '';
  const user = raw.user_info || raw.userInfo || {};
  return {
    appId: String(appId),
    appSecret: String(appSecret),
    ownerOpenId: String(user.open_id || user.openId || ''),
    ownerName: String(user.name || user.user_name || ''),
  };
}

/** /repair 的说明文案（真正的增量补权限走飞书卡片，这里只解释）。 */
export function repairHint() {
  return [
    '飞书补权限：',
    '1. 在飞书里给机器人发 /repair，会拉起增量扫码；',
    '2. 扫码确认后自动补上群消息、媒体、卡片等权限；',
    '3. 不需要重建应用，也不需要重新填 AppSecret。',
  ].join('\n');
}
