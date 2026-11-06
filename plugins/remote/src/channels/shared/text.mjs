/**
 * 渠道共用的小工具：分段、Markdown 降级、去重、@ 判定。
 */

/** 按段落/代码块边界切分长文本（微信单条不宜过长）。 */
export function splitText(text, limit = 1800) {
  const body = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!body) return [];
  if (body.length <= limit) return [body];

  const chunks = [];
  let buffer = [];
  let size = 0;
  let fence = null;

  const flush = () => {
    if (!buffer.length) return;
    const closing = fence ? `\n${fence}` : '';
    chunks.push(buffer.join('\n') + closing);
    buffer = fence ? [fence] : [];
    size = fence ? fence.length + 1 : 0;
  };

  for (const line of body.split('\n')) {
    let current = line;
    while (current.length > limit) {
      if (buffer.length) flush();
      chunks.push(current.slice(0, limit));
      current = current.slice(limit);
    }
    const add = current.length + (buffer.length ? 1 : 0);
    if (buffer.length && size + add > limit) flush();
    buffer.push(current);
    size += add;

    const match = current.match(/^\s*(```+|~~~+)/);
    if (match) {
      const marker = match[1].slice(0, 3);
      if (!fence) fence = marker;
      else if (current.trim() === fence) fence = null;
    }
  }
  if (buffer.length) chunks.push(buffer.join('\n'));
  return chunks.filter((chunk) => chunk.trim());
}

/** 微信/QQ 不支持 Markdown 时，降级成可读纯文本。 */
export function toPlainText(markdown) {
  return String(markdown || '')
    .replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, (_, code) => code.trim())
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1（$2）')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 去掉飞书/QQ 群消息里的 @占位符。 */
export function stripMentions(text, keys = []) {
  let out = String(text || '');
  for (const key of keys) {
    if (key) out = out.split(key).join(' ');
  }
  return out.replace(/@_user_\d+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 简单去重：同一 messageId 只处理一次。 */
export class Dedupe {
  constructor(limit = 500) {
    this.limit = limit;
    this.seen = new Map();
  }

  check(id) {
    if (!id) return true;
    if (this.seen.has(id)) return false;
    this.seen.set(id, Date.now());
    if (this.seen.size > this.limit) {
      const sorted = [...this.seen.entries()].sort((a, b) => a[1] - b[1]);
      for (const [key] of sorted.slice(0, this.seen.size - this.limit)) this.seen.delete(key);
    }
    return true;
  }
}

/** 群聊是否 @了机器人。 */
export function mentionsBot(segments, selfId, rawText = '') {
  if (!selfId) return true;
  for (const segment of segments || []) {
    if (segment?.type === 'at' && String(segment?.data?.qq) === String(selfId)) return true;
  }
  return String(rawText || '').includes(`[CQ:at,qq=${selfId}]`);
}

export function humanBytes(size) {
  const value = Number(size || 0);
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${(value / 1024 / 1024).toFixed(1)}MB`;
}
