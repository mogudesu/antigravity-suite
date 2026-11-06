/**
 * 状态存储：机器人配置、会话绑定、游标、延迟补发队列。
 *
 * 与凭据分开存（state.json 不含任何密钥，可以随意给 UI 看）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths, ensureRuntimeDirs } from './paths.mjs';

const EMPTY = () => ({
  version: 2,
  bots: {}, // botId -> BotConfig
  bindings: {}, // `${botId}:${chatId}` -> { conversationId, title, workspace, model, updatedAt }
  cursors: {}, // botId -> 平台游标（get_updates_buf / lastUpdateId ...）
  deferred: [], // 超时转后台的待补发任务
  meta: { createdAt: Date.now() },
});

export class StateStore {
  constructor(file = paths().state) {
    this.file = file;
    this.data = EMPTY();
    this._dirty = false;
    this._lastWrite = 0;
    this.load();
  }

  load() {
    const read = (file) => {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { ...EMPTY(), ...parsed, bots: parsed.bots || {}, bindings: parsed.bindings || {}, cursors: parsed.cursors || {}, deferred: parsed.deferred || [] };
    };
    try {
      this.data = read(this.file);
      return this.data;
    } catch {
      // 主文件坏了/被截断：回退到上一次的备份，绝不把机器人配置清零
      try {
        this.data = read(`${this.file}.bak`);
        this.logger?.warn?.('state.json 读取失败，已从 .bak 恢复');
        return this.data;
      } catch {
        this.data = EMPTY();
        return this.data;
      }
    }
  }

  /** 节流落盘：高频状态更新不每次都写盘。 */
  save({ force = false } = {}) {
    this._dirty = true;
    const now = Date.now();
    if (!force && now - this._lastWrite < 800) return;
    ensureRuntimeDirs();
    try {
      // 覆盖前留一份备份，避免写到一半崩掉把机器人配置弄丢
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    } catch {
      /* 备份失败不影响主流程 */
    }
    const tmp = path.join(path.dirname(this.file), `.state.${process.pid}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
    this._dirty = false;
    this._lastWrite = now;
  }

  // ---------------------------------------------------------------- bots

  listBots() {
    return Object.values(this.data.bots);
  }

  getBot(botId) {
    return this.data.bots[botId] || null;
  }

  upsertBot(bot) {
    if (!bot || !bot.id) throw new Error('bot.id 必填');
    const existing = this.data.bots[bot.id] || {};
    this.data.bots[bot.id] = {
      ...existing,
      ...bot,
      createdAt: existing.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    this.save({ force: true });
    return this.data.bots[bot.id];
  }

  removeBot(botId) {
    if (!this.data.bots[botId]) return false;
    delete this.data.bots[botId];
    for (const key of Object.keys(this.data.bindings)) {
      if (key.startsWith(`${botId}:`)) delete this.data.bindings[key];
    }
    this.save({ force: true });
    return true;
  }

  // ---------------------------------------------------------------- bindings

  static bindingKey(botId, chatId) {
    return `${botId}:${chatId}`;
  }

  getBinding(botId, chatId) {
    return this.data.bindings[StateStore.bindingKey(botId, chatId)] || null;
  }

  setBinding(botId, chatId, binding) {
    this.data.bindings[StateStore.bindingKey(botId, chatId)] = {
      ...binding,
      updatedAt: Date.now(),
    };
    this.save({ force: true });
    return this.getBinding(botId, chatId);
  }

  clearBinding(botId, chatId) {
    const key = StateStore.bindingKey(botId, chatId);
    if (!this.data.bindings[key]) return false;
    delete this.data.bindings[key];
    this.save({ force: true });
    return true;
  }

  listBindings(botId) {
    return Object.entries(this.data.bindings)
      .filter(([key]) => (botId ? key.startsWith(`${botId}:`) : true))
      .map(([key, value]) => ({ key, chatId: key.slice(key.indexOf(':') + 1), ...value }));
  }

  // ---------------------------------------------------------------- cursors

  getCursor(botId) {
    return this.data.cursors[botId] ?? null;
  }

  setCursor(botId, cursor) {
    this.data.cursors[botId] = cursor;
    this.save();
  }

  // ---------------------------------------------------------------- deferred

  addDeferred(task) {
    this.data.deferred.push({ ...task, queuedAt: Date.now() });
    this.save({ force: true });
  }

  takeDeferred() {
    const items = this.data.deferred.slice();
    this.data.deferred = [];
    this.save({ force: true });
    return items;
  }

  get deferredCount() {
    return this.data.deferred.length;
  }
}
