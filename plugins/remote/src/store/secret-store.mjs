/**
 * 凭据存储：只落在用户目录，API 输出一律脱敏。
 *
 * 设计要点：
 *  - 一个 JSON 文件，写盘用「临时文件 + rename」保证原子；
 *  - 读取时补齐结构，坏文件不阻塞启动；
 *  - redact() 是唯一的对外出口，任何 /api/* 返回都必须过它。
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths, ensureRuntimeDirs } from './paths.mjs';

const SENSITIVE_KEYS = [
  'appSecret',
  'app_secret',
  'secret',
  'token',
  'botToken',
  'bot_token',
  'accessToken',
  'access_token',
  'refreshToken',
  'encodingAesKey',
  'aesKey',
  'verifyToken',
  'verificationToken',
  'encryptKey',
  'ticket',
  'typingTicket',
  'getUpdatesBuf',
  'cookie',
  'authorization',
];

export function isSensitiveKey(key) {
  const lower = String(key || '').toLowerCase();
  return SENSITIVE_KEYS.some((item) => lower === item.toLowerCase() || lower.endsWith(item.toLowerCase()));
}

/** 只保留前后各 3 位，中间打码。 */
export function maskSecret(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (text.length <= 8) return '***';
  return `${text.slice(0, 3)}***${text.slice(-3)}`;
}

/** 深拷贝并脱敏（不修改入参）。 */
export function redact(input, { keepLength = false } = {}) {
  if (Array.isArray(input)) return input.map((item) => redact(item, { keepLength }));
  if (input && typeof input === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      if (isSensitiveKey(key) && typeof value === 'string' && value) {
        out[key] = keepLength ? `${maskSecret(value)}(${value.length})` : maskSecret(value);
      } else {
        out[key] = redact(value, { keepLength });
      }
    }
    return out;
  }
  return input;
}

export class SecretStore {
  constructor(file = paths().secrets) {
    this.file = file;
    this.data = {};
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      this.data = {};
    }
    return this.data;
  }

  /** 按 botId 存一份凭据（整体替换）。 */
  set(botId, values) {
    ensureRuntimeDirs();
    this.data[botId] = { ...(this.data[botId] || {}), ...values };
    this.flush();
    return this.data[botId];
  }

  merge(botId, values) {
    return this.set(botId, values);
  }

  get(botId) {
    return this.data[botId] || null;
  }

  remove(botId) {
    if (this.data[botId]) {
      delete this.data[botId];
      this.flush();
      return true;
    }
    return false;
  }

  flush() {
    ensureRuntimeDirs();
    const tmp = path.join(path.dirname(this.file), `.secrets.${process.pid}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
