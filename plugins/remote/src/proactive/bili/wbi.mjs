/**
 * B 站 WBI 签名（2023 起搜索/动态等接口必须带 w_rid + wts）。
 *
 * 流程：nav 接口取 img_url/sub_url → 文件名 → 按固定表重排成 mixinKey
 * → 参数按 key 排序、剔除 !'()* 、加 wts → md5(query + mixinKey) 得到 w_rid。
 */
import { createHash } from 'node:crypto';

export const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

/** 从 img_url / sub_url 里取文件名（去掉扩展名）。 */
export function keyFromUrl(url) {
  const name = String(url || '').split('/').pop() || '';
  return name.replace(/\.[a-zA-Z0-9]+$/, '');
}

/** 由 imgKey + subKey 生成 32 位 mixinKey。 */
export function mixinKey(imgKey, subKey) {
  const raw = `${imgKey || ''}${subKey || ''}`;
  return MIXIN_KEY_ENC_TAB.map((index) => raw[index] || '').join('').slice(0, 32);
}

/** 参数里需要剔除的字符（B 站约定）。 */
export function sanitizeValue(value) {
  return String(value ?? '').replace(/[!'()*]/g, '');
}

/**
 * 给参数签名。
 * @returns {{params: Record<string,string>, wts: string, wRid: string}}
 */
export function signWbi(params = {}, mixin, { now = Date.now() } = {}) {
  const wts = String(Math.floor(now / 1000));
  const merged = { ...params, wts };
  const query = Object.keys(merged)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(sanitizeValue(merged[key]))}`)
    .join('&');
  const wRid = createHash('md5').update(query + mixin).digest('hex');
  return {
    params: { ...Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, sanitizeValue(v)])), w_rid: wRid },
    wts,
    wRid,
  };
}

/** 带签名直接拼出完整 URL。 */
export function signedUrl(baseUrl, params = {}, mixin, options) {
  const { params: signed } = signWbi(params, mixin, options);
  const query = Object.entries(signed)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}${query}`;
}

/** 从 nav 响应里取出 mixinKey（拿不到返回空串）。 */
export function mixinFromNav(navData) {
  const wbi = navData?.data?.wbi_img || navData?.wbi_img || {};
  const imgKey = keyFromUrl(wbi.img_url);
  const subKey = keyFromUrl(wbi.sub_url);
  if (!imgKey || !subKey) return '';
  return mixinKey(imgKey, subKey);
}
