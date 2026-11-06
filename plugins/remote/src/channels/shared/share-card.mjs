/**
 * 分享卡片拆包：微信/QQ/飞书里转发的公众号文章、B 站视频、小红书笔记等，
 * 真实链接常藏在 XML/JSON 的字段里，而不是纯文本。
 *
 * 目标：拿到「能直接深读的公网 URL + 标题」，拿不到就如实说拿不到。
 */
// 注意：中文标点（。，、；：！？（）【】《》…）也要算 URL 的终止符，否则会把后文吞进链接
const URL_RE = /https?:\/\/[^\s"'<>（）()【】\[\]《》「」“”‘’…，。、；：！？]+/gi;

/** 微信 appmsg / QQ 结构化消息 里常见的 URL 字段名。 */
const CARD_URL_KEYS = ['url', 'jumpUrl', 'jump_url', 'shareUrl', 'share_url', 'link', 'target_url', 'source_url', 'appid_url'];

export function normalizeTitle(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/** 从任意文本里抽 URL（去重、去尾部标点）。 */
export function extractUrls(text) {
  const found = String(text || '').match(URL_RE) || [];
  const cleaned = found.map((url) => url.replace(/[.,;:!?、。，；：！？·]+$/, ''));
  return [...new Set(cleaned)];
}

/** 微信 XML 卡片：<url>…</url> / <title>…</title>。 */
export function parseWechatCard(xml) {
  const text = String(xml || '');
  if (!/<appmsg|<msg/i.test(text)) return null;
  const url = text.match(/<url>\s*(?:<!\[CDATA\[)?([^<\]]+)/i)?.[1];
  const title = text.match(/<title>\s*(?:<!\[CDATA\[)?([^<\]]+)/i)?.[1];
  if (!url) return null;
  return { kind: 'wechat-appmsg', url: url.trim(), title: normalizeTitle(title) };
}

/** QQ 结构化卡片（JSON 字符串或已解析对象）。 */
export function parseQqCard(content) {
  let data = content;
  if (typeof content === 'string') {
    try {
      data = JSON.parse(content);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object') return null;
  const meta = data.meta || {};
  for (const value of Object.values(meta)) {
    if (!value || typeof value !== 'object') continue;
    for (const key of CARD_URL_KEYS) {
      if (typeof value[key] === 'string' && /^https?:\/\//i.test(value[key])) {
        return { kind: 'qq-card', url: value[key], title: normalizeTitle(value.title || value.desc || '') };
      }
    }
  }
  // 兜底：整段 JSON 里扫 URL
  const urls = extractUrls(JSON.stringify(data));
  if (urls.length) return { kind: 'qq-card', url: urls[0], title: normalizeTitle(data?.meta?.detail_1?.title || '') };
  return null;
}

/**
 * 统一入口：给一段消息内容（可能是纯文本、XML、JSON）返回卡片信息 + 所有 URL。
 * @returns {{urls: string[], card: null | {kind: string, url: string, title: string}}}
 */
export function unpackShareCard(content, { messageType = '' } = {}) {
  const text = String(content ?? '');
  const urls = extractUrls(text);
  const card =
    parseWechatCard(text) ||
    (messageType === 'json' || text.trim().startsWith('{') ? parseQqCard(text) : null) ||
    null;
  const merged = card?.url ? [card.url, ...urls.filter((u) => u !== card.url)] : urls;
  return { urls: [...new Set(merged)], card };
}

/** 内网/本机地址不参与深读。 */
export function isPrivateHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/\.local$/.test(h) || /\.internal$/.test(h)) return true;
  return false;
}
