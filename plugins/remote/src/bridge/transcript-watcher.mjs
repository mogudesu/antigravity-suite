/**
 * Transcript 监听：读 <brain>/<id>/.system_generated/logs/transcript.jsonl。
 *
 * 这是整条链路里最关键的替换：不再用 DOM 抓 innerText（会混进"思考了 20 秒"这类 UI 噪音），
 * 而是读 Antigravity 自己落盘的步骤流，拿到干净的 Markdown、thinking、tool_calls 和产出媒体。
 *
 * 行格式（实测）：
 *   {"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE",
 *    "created_at":"...","content":"...","thinking":"...","tool_calls":[...],
 *    "media":[...],"truncated_fields":["content"]}
 * 当 truncated_fields 含 content 时，正文被截断，需要去 transcript_full.jsonl 取同 step 的完整内容。
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export const STEP_TYPES = {
  USER: 'USER_INPUT',
  PLANNER: 'PLANNER_RESPONSE',
  GENERIC: 'GENERIC',
  SYSTEM: 'SYSTEM_MESSAGE',
  CHECKPOINT: 'CHECKPOINT',
};

/** 从 <USER_REQUEST> 包裹里取出真正的用户输入。 */
export function extractUserRequest(content) {
  const text = String(content || '');
  const match = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  const body = (match ? match[1] : text).trim();
  return body;
}

/** 只保留正文，去掉附加元数据块（时间、上传文件列表等）。 */
export function stripUserMetadata(content) {
  return extractUserRequest(content)
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .trim();
}

function safeJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export class TranscriptWatcher extends EventEmitter {
  constructor({ file, fullFile, pollMs = 600, fromStart = true }) {
    super();
    this.file = file;
    this.fullFile = fullFile || file.replace(/transcript\.jsonl$/i, 'transcript_full.jsonl');
    this.pollMs = pollMs;
    this.fromStart = fromStart;
    this.steps = [];
    this.offset = 0;
    this.buffer = '';
    this.timer = null;
    this._fullCache = new Map();
    this._inode = null;
  }

  start() {
    if (this.timer) return this;
    if (!this.fromStart) {
      try {
        this.offset = fs.statSync(this.file).size;
      } catch {
        this.offset = 0;
      }
    }
    this._tick();
    this.timer = setInterval(() => this._tick(), this.pollMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  _tick() {
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch {
      return; // 文件还没生成
    }
    if (this._inode && stat.ino && stat.ino !== this._inode) {
      // 文件被重建（新会话同名？），从头再读
      this.offset = 0;
      this.buffer = '';
      this.steps = [];
    }
    this._inode = stat.ino || this._inode;
    if (stat.size < this.offset) {
      // 被截断（压缩上下文会重写），重新读
      this.offset = 0;
      this.buffer = '';
      this.steps = [];
    }
    if (stat.size === this.offset) return;

    let chunk = '';
    try {
      const fd = fs.openSync(this.file, 'r');
      try {
        const length = stat.size - this.offset;
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, this.offset);
        chunk = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      this.offset = stat.size;
    } catch {
      return;
    }

    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const step = safeJson(trimmed);
      if (!step) continue; // 半截行/坏行，跳过
      const enriched = this._fillTruncated(step);
      this.steps.push(enriched);
      this.emit('step', enriched);
    }
  }

  /** content 被截断时，从 transcript_full.jsonl 找回完整正文。 */
  _fillTruncated(step) {
    const truncated = Array.isArray(step.truncated_fields) ? step.truncated_fields : [];
    if (!truncated.includes('content')) return step;
    if (this._fullCache.size === 0) this._loadFull();
    const key = `${step.step_index}:${step.type}`;
    const full = this._fullCache.get(key);
    if (full && full.length > String(step.content || '').length) {
      return { ...step, content: full, _recovered: true };
    }
    return step;
  }

  _loadFull() {
    try {
      const raw = fs.readFileSync(this.fullFile, 'utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const step = safeJson(trimmed);
        if (!step) continue;
        this._fullCache.set(`${step.step_index}:${step.type}`, String(step.content || ''));
      }
    } catch {
      /* 没有 full 文件就用截断版 */
    }
  }

  // ---------------------------------------------------------------- 汇总

  get userSteps() {
    return this.steps.filter((step) => step.type === STEP_TYPES.USER);
  }

  get plannerSteps() {
    return this.steps.filter((step) => step.type === STEP_TYPES.PLANNER);
  }

  get runningSteps() {
    return this.steps.filter((step) => step.status === 'RUNNING');
  }

  /** 最后一条用户输入之后的所有步骤（= 当前这一轮）。 */
  currentTurnSteps() {
    let index = -1;
    for (let i = this.steps.length - 1; i >= 0; i -= 1) {
      if (this.steps[i].type === STEP_TYPES.USER) {
        index = i;
        break;
      }
    }
    return this.steps.slice(index + 1);
  }

  /** 最终答复：这一轮最后一条有正文的 PLANNER_RESPONSE。 */
  finalAnswer() {
    const turn = this.currentTurnSteps();
    for (let i = turn.length - 1; i >= 0; i -= 1) {
      const step = turn[i];
      if (step.type === STEP_TYPES.PLANNER && String(step.content || '').trim()) {
        return String(step.content).trim();
      }
    }
    return '';
  }

  /** 过程快照：思考、工具调用、媒体，供流式卡片渲染。 */
  progress() {
    const turn = this.currentTurnSteps();
    const thinking = [];
    const tools = [];
    const media = [];
    let answer = '';
    for (const step of turn) {
      if (step.thinking) thinking.push(String(step.thinking).trim());
      if (Array.isArray(step.tool_calls)) {
        for (const call of step.tool_calls) tools.push({ name: call.name || call.tool || 'tool', args: call.args || call.arguments || {} });
      }
      if (Array.isArray(step.media)) media.push(...step.media);
      if (step.type === STEP_TYPES.PLANNER && String(step.content || '').trim()) answer = String(step.content).trim();
    }
    return {
      thinking: thinking.join('\n').trim(),
      tools,
      media,
      answer,
      running: this.runningSteps.length > 0,
      steps: turn.length,
    };
  }

  /** 有没有跑完（本轮没有 RUNNING 步骤，且已有答复）。 */
  isSettled() {
    const turn = this.currentTurnSteps();
    if (!turn.length) return false;
    const running = turn.some((step) => step.status === 'RUNNING');
    return !running && Boolean(this.finalAnswer());
  }
}

export function createWatcher(conversationId, { brainDir, pollMs = 600, fromStart = true }) {
  const file = path.join(brainDir, conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  return new TranscriptWatcher({ file, pollMs, fromStart });
}
