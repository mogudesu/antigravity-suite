/**
 * 各 IM 通道共用的媒体工具：图片嗅探、文件名清洗、安全下载。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureRuntimeDirs } from '../../store/paths.mjs';

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|tiff?)$/i;
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

export function sniffImageExt(bytes) {
  const buf = Buffer.from(bytes || []);
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('ascii'))) return '.gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  if (buf.length >= 2 && buf.subarray(0, 2).toString('ascii') === 'BM') return '.bmp';
  return '';
}

export function sanitizeFileName(name, fallback = 'file') {
  const base = path.basename(String(name || '').replace(/\\/g, '/'))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .trim();
  if (!base || base === '.' || base === '..') return fallback;
  return base.slice(0, 120);
}

/** 只允许公网 http(s)，防止聊天里的恶意 URL 打到本机或内网。 */
export function safeMediaUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ''));
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '::1') return null;
  if (host === '0.0.0.0' || host === 'metadata.google.internal') return null;
  if (/^(10|127)\./.test(host)) return null;
  if (/^192\.168\./.test(host)) return null;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return null;
  if (/^169\.254\./.test(host)) return null;
  return url;
}

export async function downloadToTemp(url, { fetchImpl = fetch, prefix = 'im', name = 'file', kind = 'file' } = {}) {
  const parsed = safeMediaUrl(url);
  if (!parsed) throw new Error('不安全的媒体地址');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetchImpl(parsed.href, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    if (!safeMediaUrl(res.url || parsed.href)) throw new Error('媒体地址重定向到内网');
    const length = Number(res.headers?.get?.('content-length') || 0);
    if (length > MAX_MEDIA_BYTES) throw new Error('媒体文件超过 100MB');
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length) throw new Error('媒体文件为空');
    if (bytes.length > MAX_MEDIA_BYTES) throw new Error('媒体文件超过 100MB');
    const safeName = sanitizeFileName(name, kind === 'image' ? 'image' : 'file');
    const ext = kind === 'image' ? sniffImageExt(bytes) || path.extname(safeName) || '.jpg' : path.extname(safeName) || '.bin';
    const dir = ensureRuntimeDirs().tmp;
    const file = path.join(dir, `${prefix}-${Date.now()}-${randomUUID().slice(0, 6)}${ext}`);
    fs.writeFileSync(file, bytes);
    return { file, bytes: bytes.length };
  } finally {
    clearTimeout(timer);
  }
}
