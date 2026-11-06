/**
 * 私聊双向同步：桌面端在 Antigravity 里敲的问题 / 得到的回答，镜像到绑定的 IM 私聊。
 *
 * 关键点：
 *  - 只读 transcript，不碰界面，所以不会和提交阶段抢锁；
 *  - 手机自己发起的消息要排除（harness 发完会 remember 一下原文）；
 *  - 用 step_index 去重，避免同一条被镜像两次。
 */
import fs from 'node:fs';
import { createWatcher, extractUserRequest } from '../bridge/transcript-watcher.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SessionSync {
  constructor({ state, index, logger = console, intervalMs = 2500 }) {
    this.state = state;
    this.index = index;
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.offsets = new Map(); // conversationId -> byte offset
    this.mirrored = new Map(); // conversationId -> Set<step_index>
    this.outbound = new Map(); // conversationId -> Set<原文片段>
  }

  /** harness 发完提示词后登记一下，镜像时跳过这条。 */
  remember(conversationId, text) {
    if (!conversationId || !text) return;
    const set = this.outbound.get(conversationId) || new Set();
    set.add(normalize(text).slice(0, 120));
    if (set.size > 50) set.delete(set.values().next().value);
    this.outbound.set(conversationId, set);
  }

  start(sendTo) {
    if (this.timer) return;
    this.sendTo = sendTo;
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.logger.debug?.(`[sync] ${error?.message || error}`));
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 需要同步的绑定：bot.syncEnabled && 有 conversationId。 */
  targets() {
    const bots = new Map(this.state.listBots().map((bot) => [bot.id, bot]));
    return this.state
      .listBindings()
      .filter((item) => {
        const bot = bots.get(item.key.split(':')[0]);
        return bot && bot.syncEnabled && item.conversationId;
      })
      .map((item) => ({ ...item, botId: item.key.split(':')[0], bot: bots.get(item.key.split(':')[0]) }));
  }

  async tick() {
    for (const target of this.targets()) {
      await this._scan(target);
    }
  }

  async _scan(target) {
    const { conversationId, chatId, botId } = target;
    const file = this.index.transcriptPath(conversationId);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return;
    }
    let offset = this.offsets.get(conversationId);
    if (offset === undefined || stat.size < offset) {
      // 第一次只看最后 8KB，避免把历史全镜像一遍
      offset = Math.max(0, stat.size - 8192);
      this.offsets.set(conversationId, offset);
      return;
    }
    if (stat.size === offset) return;

    const length = stat.size - offset;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offsets.set(conversationId, stat.size);

    const seen = this.mirrored.get(conversationId) || new Set();
    for (const line of buffer.toString('utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let step;
      try {
        step = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const key = `${step.type}:${step.step_index}`;
      if (seen.has(key)) continue;

      if (step.type === 'USER_INPUT') {
        const text = normalize(extractUserRequest(step.content || ''));
        if (!text) continue;
        const outs = this.outbound.get(conversationId);
        if (outs && [...outs].some((item) => text.startsWith(item) || item.startsWith(text.slice(0, 120)))) {
          seen.add(key);
          continue; // 手机自己发的，不回显
        }
        seen.add(key);
        await this.sendTo({ botId, chatId, text: `💻 桌面输入：${text.slice(0, 500)}` });
      } else if (step.type === 'PLANNER_RESPONSE' && step.status === 'DONE' && String(step.content || '').trim()) {
        seen.add(key);
        await this.sendTo({ botId, chatId, text: `🤖 桌面回复：${String(step.content).trim().slice(0, 1800)}` });
      }
    }
    this.mirrored.set(conversationId, seen);
  }
}

function normalize(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

export { sleep, createWatcher };
