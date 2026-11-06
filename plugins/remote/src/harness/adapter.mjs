/**
 * 会话调度器：把「一条手机消息」变成「一次 Antigravity 运行 + 一段可回推的过程」。
 *
 * 关键点：
 *  - 每个会话一把队列（同一会话串行），跨会话并行；
 *  - 忙碌策略：queue（排队）或 steer（插话打断）；
 *  - 等待完全靠 transcript + 索引状态，不占用界面锁；
 *  - 超时转 deferred，跑完自动补发。
 */
import { EventEmitter } from 'node:events';
import { createWatcher } from '../bridge/transcript-watcher.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RemoteHarness extends EventEmitter {
  constructor({ workbench, index, state, logger = console, pollMs = 800, runTimeoutMs = 15 * 60 * 1000 }) {
    super();
    this.workbench = workbench;
    this.index = index;
    this.state = state;
    this.logger = logger;
    this.pollMs = pollMs;
    this.runTimeoutMs = runTimeoutMs;
    this.runs = new Map(); // conversationId -> { startedAt, chatKey, botId }
    this.queues = new Map(); // botId -> Promise chain
  }

  /** 同一机器人内串行；不同机器人可以并行（各自绑不同工作区/会话）。 */
  _enqueue(botId, task) {
    const prev = this.queues.get(botId) || Promise.resolve();
    const next = prev.then(task, task);
    this.queues.set(
      botId,
      next.catch(() => {}),
    );
    return next;
  }

  /**
   * 提交一条指令。
   * @returns {Promise<{ok: boolean, conversationId?: string, answer?: string, error?: string}>}
   */
  async submit({ bot, chatId, text, mode = 'queue', onProgress = null, timeoutMs = this.runTimeoutMs }) {
    const binding = this.state.getBinding(bot.id, chatId) || {};
    const conversationId = binding.conversationId || '';
    const model = binding.model || bot.defaultModel || '';

    const running = conversationId ? this.runs.get(conversationId) : null;
    if (running && mode !== 'steer') {
      // 排队：等当前这轮结束
      this.emit('queued', { botId: bot.id, chatId, conversationId });
      await this._waitIdle(conversationId, timeoutMs);
    }

    return this._enqueue(bot.id, async () => {
      if (running && mode === 'steer') {
        const steered = await this.workbench.sendPrompt({ conversationId, text, model });
        if (steered.ok) this.emit('steer', { conversationId, text });
        return { ok: steered.ok, conversationId, error: steered.ok ? undefined : steered.reason };
      }

      const targetId = conversationId || (await this._resolveConversation(bot));
      const sent = await this.workbench.sendPrompt({ conversationId: targetId, text, model });
      if (!sent.ok) {
        return { ok: false, error: `${sent.stage || 'send'}：${sent.reason || '失败'}`, detail: sent };
      }
      const actualId = sent.conversationId || targetId;
      if (actualId && actualId !== conversationId) {
        if (conversationId) {
          // 已有绑定却发到了别的对话 = 切换没生效。绝不悄悄改写绑定，
          // 否则以后每条消息都会跟着跑到用户当时打开的那个对话里。
          this.logger.warn?.(`消息落在 ${actualId}，与绑定的 ${conversationId} 不一致，保留原绑定`);
          return {
            ok: false,
            error: 'switch：wrong-conversation',
            detail: { expected: conversationId, actual: actualId },
            conversationId: actualId,
          };
        }
        // 只有"不指定"（没有绑定）时才跟随实际对话
        this.state.setBinding(bot.id, chatId, {
          conversationId: actualId,
          model: model || '',
          workspace: bot.defaultWorkspace || '',
        });
      }
      this.emit('started', { botId: bot.id, chatId, conversationId: actualId, text });
      const result = await this._watch(actualId, { bot, chatId, onProgress, timeoutMs });
      // 把"模型没切成功"这类非致命警告带回给 hub，让它告诉用户
      return { ...result, conversationId: actualId, modelWarning: sent.modelWarning || '' };
    });
  }

  /** 没有绑定时：不继承旧对话，自动新开一个。 */
  async _resolveConversation(bot) {
    let snapshot = await this.workbench.snapshot().catch(() => null);
    // 界面停在"新对话"（还没有 id）：直接在这个空对话里发，别重复新建
    if (snapshot?.hasInput && !snapshot?.conversationId) return '';

    // 生成中切新对话可能打断回答：等它闲下来；等不到就发在当前对话，至少不丢消息
    if (snapshot?.busy) {
      const deadline = Date.now() + 15000;
      while (snapshot?.busy && Date.now() < deadline) {
        await sleep(800);
        snapshot = await this.workbench.snapshot().catch(() => null);
      }
      if (snapshot?.busy) return snapshot.conversationId || '';
    }

    // 「不指定」= 不沿用任何旧会话，新建一个；成功后 hub 会把绑定落到新会话
    try {
      const created = await this.workbench.newConversation({ model: bot.defaultModel || '' });
      if (created?.ok) return created.conversationId || '';
      this.logger.warn?.('新开对话失败，回退到当前对话：' + (created?.reason || 'unknown'));
    } catch (error) {
      this.logger.warn?.('新开对话失败，回退到当前对话：' + (error?.message || error));
    }

    // 新建失败才退回当前打开的对话，保证消息能发出去
    if (snapshot?.conversationId) return snapshot.conversationId;
    if (bot.defaultConversation) {
      const pinned = this.index.get(bot.defaultConversation);
      if (pinned) return pinned.id;
    }
    const workspace = bot.defaultWorkspace || '';
    const list = this.index.list({ limit: 20, workspace });
    if (list.length) return list[0].id;
    const any = this.index.list({ limit: 1 });
    return any.length ? any[0].id : '';
  }

  async _waitIdle(conversationId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = this.index.statusOf(conversationId);
      if (status === 'idle' || status === 'unknown') return true;
      await sleep(this.pollMs);
    }
    return false;
  }

  /** 盯一轮运行：transcript 出过程，索引状态判结束。 */
  async _watch(conversationId, { bot, chatId, onProgress, timeoutMs }) {
    const watcher = createWatcher(conversationId, { brainDir: this.index.brainDir, pollMs: 500, fromStart: false });
    this.runs.set(conversationId, { startedAt: Date.now(), botId: bot.id, chatId });
    watcher.start();

    const deadline = Date.now() + timeoutMs;
    let lastProgressAt = 0;
    let answer = '';
    try {
      while (Date.now() < deadline) {
        await sleep(this.pollMs);
        const status = this.index.statusOf(conversationId);
        const snapshot = watcher.progress();
        const now = Date.now();
        if (onProgress && now - lastProgressAt > 900) {
          lastProgressAt = now;
          try {
            await onProgress({ ...snapshot, status, conversationId });
          } catch (error) {
            this.logger.warn?.('进度回调失败：', error?.message || error);
          }
        }
        const settled = status === 'idle' && (snapshot.answer || watcher.isSettled());
        if (settled) {
          answer = watcher.finalAnswer() || snapshot.answer;
          if (answer) {
            this.emit('finished', { conversationId, botId: bot.id, chatId, answer });
            return { ok: true, answer, progress: snapshot, timedOut: false };
          }
        }
      }
      // 超时：转后台补发
      const progress = watcher.progress();
      this.state.addDeferred({ botId: bot.id, chatId, conversationId, startedAt: Date.now() - timeoutMs });
      this.emit('deferred', { conversationId, botId: bot.id, chatId });
      return { ok: false, error: 'timeout', answer: progress.answer, progress, timedOut: true };
    } finally {
      watcher.stop();
      this.runs.delete(conversationId);
    }
  }

  /** 补发：后台跑完的任务在下次检查时把结果发出去。 */
  async flushDeferred(send) {
    const items = this.state.takeDeferred();
    for (const item of items) {
      const status = this.index.statusOf(item.conversationId);
      if (status !== 'idle') {
        this.state.addDeferred(item);
        continue;
      }
      // 补发时任务往往早就跑完了：必须从头读整份 transcript。
      // 用 fromStart:false 只盯「从现在起」的新事件，就永远取不到那条已经写好的答案，
      // 而 takeDeferred 已经把条目取出，answer 为空时它就被静默丢弃 —— 用户再也等不到回音。
      const watcher = createWatcher(item.conversationId, { brainDir: this.index.brainDir, pollMs: 400, fromStart: true });
      watcher.start();
      await sleep(300);
      const answer = watcher.finalAnswer();
      watcher.stop();
      await send(item, answer || '（这一轮没有取到结果，可能被中断了；需要的话再发一次）');
    }
  }

  async stop(conversationId) {
    return this.workbench.stopGeneration(conversationId);
  }

  isRunning(conversationId) {
    return this.runs.has(conversationId);
  }
}
