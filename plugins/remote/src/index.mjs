#!/usr/bin/env node
/**
 * antigravity远程-mogu · 守护进程
 *
 * 职责：机器人生命周期、扫码会话、消息调度、审批、HTTP API + SSE、静态面板。
 * 启动方式：插件 sidecar（自动）或 `node src/index.mjs`（手动）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { paths, ensureRuntimeDirs, PLUGIN_ROOT } from './store/paths.mjs';
import { SecretStore, redact } from './store/secret-store.mjs';
import { StateStore } from './store/state-store.mjs';
import { ConversationIndex } from './bridge/conversation-index.mjs';
import { Workbench } from './bridge/cdp-executor.mjs';
import { discoverWorkbench } from './bridge/port-discovery.mjs';
import { RemoteHarness } from './harness/adapter.mjs';
import { runCommand, parseCommand, helpText } from './harness/commands.mjs';
import { WeixinBot } from './channels/weixin/weixin-bot.mjs';
import { FeishuBot } from './channels/feishu/feishu-bot.mjs';
import { QQOfficialBot } from './channels/qq/qq-official-bot.mjs';
import { OneBotChannel } from './channels/qq/qq-onebot-bot.mjs';
import { IlinkClient } from './channels/weixin/ilink-api.mjs';
import { startQrScan } from './channels/qq/qq-auth.mjs';
import { verifyCredentials as verifyQqCredentials } from './channels/qq/qq-auth.mjs';
import { startRegister, verifyCredentials as verifyFeishuCredentials, normalizeRegisterResult } from './channels/feishu/feishu-auth.mjs';
import { SessionSync } from './harness/session-sync.mjs';
import { SettingsInjector } from './ui/settings-injector.mjs';
import { ProactiveGate } from './proactive/gate.mjs';
import { BioClock } from './proactive/bio-clock.mjs';
import { InterestProfiler } from './proactive/profile.mjs';
import { DualDiary } from './proactive/diary.mjs';
import { RoamEngine } from './proactive/roam.mjs';
import * as biliFeed from './proactive/bili/feed.mjs';
import * as biliDebrief from './proactive/bili/debrief.mjs';
import { unpackShareCard } from './channels/shared/share-card.mjs';
import { buildRoutingHint, userOptedOut } from './channels/shared/link-router.mjs';
import { readLink, condense, cookieKeyFor } from './proactive/scouts/link-reader.mjs';
import { generateQr, pollQr, verifyCookie } from './proactive/bili/auth.mjs';
import { platformStatus, normalizePlatforms } from './proactive/scouts/platform-scouts.mjs';
import QRCode from 'qrcode';

const PORT = Number(process.env.AG_REMOTE_PORT || 8791);
const HOST = process.env.AG_REMOTE_HOST || '127.0.0.1';
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 版本与更新检查
const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const UPDATE_REPO = 'mogudesu/antigravity-suite';
let updateInfo = { current: APP_VERSION, latest: '', url: '', hasUpdate: false, checkedAt: 0, error: '' };

function compareVersion(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function checkForUpdate() {
  try {
    // 不用 GitHub API：未认证每小时只有 60 次，共享 IP 很容易被限流。
    // /releases/latest 的 302 跳转里直接带 tag，且没有配额限制。
    const res = await fetch(`https://github.com/${UPDATE_REPO}/releases/latest`, {
      redirect: 'manual',
      headers: { 'user-agent': 'antigravity-remote-mogu' },
      signal: AbortSignal.timeout(8000),
    });
    const location = res.headers.get('location') || '';
    const tag = (location.match(/\/releases\/tag\/([^/?#]+)/) || [])[1] || '';
    const latest = decodeURIComponent(tag).replace(/^v/i, '');
    if (!latest) throw new Error(`HTTP ${res.status}`);
    updateInfo = {
      current: APP_VERSION,
      latest,
      url: `https://github.com/${UPDATE_REPO}/releases/latest`,
      hasUpdate: Boolean(latest) && compareVersion(latest, APP_VERSION) > 0,
      checkedAt: Date.now(),
      error: '',
    };
    if (updateInfo.hasUpdate) logger.info(`发现新版本 v${latest}（当前 v${APP_VERSION}）`);
  } catch (error) {
    updateInfo = { ...updateInfo, checkedAt: Date.now(), error: error?.message || String(error) };
    logger.debug?.('检查更新失败：', updateInfo.error);
  }
  return updateInfo;
}

const logger = {
  info: (...args) => console.log('[hub]', ...args),
  warn: (...args) => console.warn('[hub]', ...args),
  error: (...args) => console.error('[hub]', ...args),
  debug: (...args) => {
    if (process.env.AG_REMOTE_DEBUG) console.debug('[hub]', ...args);
  },
};

// ---------------------------------------------------------------- 组装

const dirs = ensureRuntimeDirs();
const state = new StateStore();
const secrets = new SecretStore();
const index = new ConversationIndex();
const workbench = new Workbench({ logger });
const harness = new RemoteHarness({ workbench, index, state, logger });
const sessionSync = new SessionSync({ state, index, logger });
// 注入器常驻：Antigravity 重启（端口会变）、设置页重渲染后，几秒内自动把导航项补回来
// 主动漫游：生物钟 + 画像 + 闸门 + 双日记（配置存 bot.proactive，默认关闭，避免一上来就打扰）
const proactiveGate = new ProactiveGate({ ledgerFile: path.join(dirs.home, 'proactive-ledger.json'), logger });
const proactiveClock = new BioClock({ windows: ['12:30-13:45', '20:30-23:30'], skipChance: 0.25 });
const profiler = new InterestProfiler({ state, index, mnemonFile: path.join(dirs.home, 'mnemon-hints.md'), logger });
const diary = new DualDiary({
  diaryFile: path.join(dirs.home, 'companion-diary.md'),
  tasteFile: path.join(dirs.home, 'taste-calibration.md'),
});
const roamEngine = new RoamEngine({
  clock: proactiveClock,
  gate: proactiveGate,
  profiler,
  diary,
  feed: biliFeed,
  debrief: biliDebrief,
  logger,
  config: { workDir: path.join(dirs.tmp, 'bili') },
});

const injector = new SettingsInjector({
  workbench,
  panelUrl: `http://${HOST}:${PORT}/ui/panel.html`,
  intervalMs: 6000,
  logger,
});

const channels = new Map(); // botId -> channel instance
const approvals = new Map(); // approvalId -> { botId, chatId, kind, text, index, createdAt }
const scanSessions = new Map(); // sessionId -> { platform, qrcode, status, createdAt, botId }
const biliScans = new Map(); // qrcodeKey -> { at }（B 站扫码登录，5 分钟过期）
const sseClients = new Set();

function broadcast(event, data = {}) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function channelFor(platform, bot) {
  if (platform === 'weixin') return new WeixinBot({ bot, secrets: secrets.get(bot.id), hub, logger });
  if (platform === 'feishu') return new FeishuBot({ bot, secrets: secrets.get(bot.id), hub, logger });
  if (platform === 'qq') {
    const cfg = secrets.get(bot.id) || {};
    if (cfg.mode === 'onebot') return new OneBotChannel({ bot, secrets: cfg, hub, logger });
    return new QQOfficialBot({ bot, secrets: cfg, hub, logger });
  }
  throw new Error(`不支持的平台：${platform}`);
}

// ---------------------------------------------------------------- hub

const hub = {
  async dispatch({ bot, chatId, text, channel, messageId = '', contextToken = '', attachments = [], senderName = '' }) {
    const botId = bot.id;
    state.upsertBot({ ...bot, lastSeenAt: Date.now() });
    broadcast('message', { botId, chatId, text: text.slice(0, 120), senderName });

    const commandCtx = {
      workbench,
      index,
      state,
      bot,
      chatId,
      harness,
      menuArmed: Boolean(state.getBot(botId)?.menuArmed),
      roam: bot.proactive?.enabled ? roamEngine : null,
      diary,
      gate: proactiveGate,
      readLink: (target) => readLink(target, { cookie: secrets.get(botId)?.cookies?.[cookieKeyFor(target)] || '' }),
      condense,
      send: async (message) => channel.sendText(chatId, message),
    };
    const command = await runCommand({ text, ctx: commandCtx });
    if (command.handled) {
      await channel.sendText(chatId, command.reply || '已处理');
      return { handled: true };
    }

    await channel.beginTyping?.(chatId, contextToken);
    const startedAt = Date.now();

    // 立刻回执，避免用户对着"没反应"猜
    if (bot.ackEnabled !== false) {
      const ackText = bot.ackText || '收到，正在思考…';
      try {
        if (channel.sendAck) await channel.sendAck(chatId, ackText);
        else await channel.sendText(chatId, ackText);
      } catch (error) {
        logger.debug?.('回执发送失败：', error?.message || error);
      }
    }
    const boundId = state.getBinding(bot.id, chatId)?.conversationId;
    if (boundId) sessionSync.remember(boundId, text);
    // 注意：Input.insertText 对换行不友好，所以拼成单行（附件用「、」分隔）
    const attachmentBlock = attachments?.length ? `（本机附件，可直接读取：${attachments.join('、')}）` : '';
    const { urls: inboundUrls } = unpackShareCard(text);
    const routing = buildRoutingHint(inboundUrls, { userSaidNoEnvoy: userOptedOut(text) });
    const linkHint = routing ? `\n\n${routing}` : '';
    // GET 表情 = "还在思考"的指示：只有真正拿到结果（或硬失败）时才撤，
    // 超时代表任务还在后台跑，必须留着，等补发送达时再撤。
    const clearAck = async () => {
      try {
        await channel.clearAck?.(chatId);
      } catch (error) {
        logger.debug?.('撤销回执失败：', error?.message || error);
      }
    };
    try {
      const result = await harness.submit({
        bot,
        chatId,
        // 不再往提示词里塞 [IM-Source: ...]：来源由 hub 自己记着，MCP 回传用 target=last 就够
        text: `${text}${attachmentBlock ? ' ' + attachmentBlock : ''}${linkHint}`,
        mode: bot.busyMode || 'queue',
        onProgress: async (progress) => {
          if (channel.streamProgress) await channel.streamProgress(chatId, progress);
          broadcast('progress', { botId, chatId, tools: progress.tools?.length || 0, steps: progress.steps });
        },
      });

      if (!result.ok) {
        await channel.sendText(chatId, describeFailure(result));
        if (!result.timedOut) await clearAck();
        return { handled: true, result };
      }

      if (result.modelWarning) {
        // 模型没切成功：先把警告发出去，别让用户以为用的是指定模型
        await channel.sendText(chatId, result.modelWarning).catch(() => {});
      }
      const finalText = result.answer || '（没有拿到文本结果）';
      if (channel.sendFinal) {
        await channel.sendFinal(chatId, finalText, {
          model: result.progress?.model || '',
          elapsed: Date.now() - startedAt,
        });
      } else {
        await channel.sendText(chatId, finalText);
      }
      broadcast('reply', { botId, chatId, chars: finalText.length });
      await clearAck();
      return { handled: true, result };
    } catch (error) {
      logger.error('处理消息失败：', error?.message || error);
      await channel.sendText(chatId, `❌ 处理失败：${error?.message || error}`);
      await clearAck();
      return { handled: true, error: String(error?.message || error) };
    } finally {
      await channel.endTyping?.(chatId);
    }
  },

  async handleApproval({ botId, chatId, approvalId, action }) {
    const approval = approvals.get(approvalId);
    if (!approval) return '审批已失效';
    approvals.delete(approvalId);
    if (approval.kind === 'dom') {
      const result = await workbench.clickApproval(approval.text, approval.index);
      return result?.ok ? '已允许' : `点击失败：${result?.reason || '未知'}`;
    }
    return action === 'approve' ? '已允许' : '已拒绝';
  },
};

// ---------------------------------------------------------------- 机器人生命周期

async function startBot(bot) {
  if (channels.has(bot.id)) return channels.get(bot.id);
  const channel = channelFor(bot.platform, bot);
  channels.set(bot.id, channel);
  try {
    // 第三方 SDK 的长连接 start() 可能永不落定；死等它就是 bootstrap 卡死的源头
    let settled = false;
    await Promise.race([
      Promise.resolve(channel.start()).then(() => { settled = true; }),
      new Promise((resolve) => setTimeout(resolve, 20000)),
    ]);
    logger.info(settled
      ? `机器人已启动：${bot.alias || bot.id}（${bot.platform}）`
      : `机器人连接中（不再等待落定）：${bot.alias || bot.id}（${bot.platform}）`);
  } catch (error) {
    logger.error(`机器人启动失败：${bot.id}`, error?.message || error);
  }
  return channel;
}

async function stopBot(botId) {
  const channel = channels.get(botId);
  if (!channel) return false;
  channel.stop?.();
  channels.delete(botId);
  return true;
}

async function bootstrap() {
  // 并发启动：某个渠道慢或挂住，不该把其它渠道和后面的定时器一起拖死
  await Promise.all(state.listBots().filter((bot) => bot.enabled !== false).map((bot) => startBot(bot)));
  sessionSync.start(async ({ botId, chatId, text }) => {
    const channel = channels.get(botId);
    if (channel) await channel.sendText(chatId, text);
    broadcast('mirror', { botId, chatId, chars: text.length });
  });

  // 生物钟：每 30 秒看一眼该不该醒
  setInterval(() => {
    proactiveTick().catch((error) => logger.debug?.('生物钟 tick 失败：', error?.message || error));
  }, 30000).unref();

  // 定时补发超时任务
  setInterval(() => {
    harness.flushDeferred(async (item, answer) => {
      const channel = channels.get(item.botId);
      if (!channel) return;
      await channel.sendText(item.chatId, `⌛ 后台任务完成：\n\n${answer}`);
      // 补发送达，思考才算真正结束：这时才撤掉「GET」
      try {
        await channel.clearAck?.(item.chatId);
      } catch (error) {
        logger.debug?.('撤销回执失败：', error?.message || error);
      }
    }).catch(() => {});
  }, 60_000).unref();
}

const FAILURE_HINTS = {
  timeout: '⌛ 还在跑，跑完我会自动补发给你。',
  'submit：fill-failed': '⚠️ 文字没能确认进到输入框（界面在重渲染或被弹窗挡住），已停止发送，不会把你的草稿混进去。再发一次通常就好；持续失败请把 Antigravity 窗口切到对话页。',
  'submit：composer-busy': '⚠️ Antigravity 输入框里有清不掉的内容（多半是你自己未发送的草稿），为免把它一起提交，这次没有发送。请清空输入框后再发一次。',
  'submit：no-input': '⚠️ 当前界面没有输入框——请先切到一个对话（不是首页/设置页），再发一次。',
  'submit：send-not-applied': '⚠️ 文字填进去了但没发出去，检查一下是否有未完成的弹窗。',
  'switch：desktop-busy': '⏳ 桌面上还有任务在跑，这条消息没有发出去（不会插进你正在看的那个对话）。等它跑完再发一次，或先在 Antigravity 里停掉当前任务。',
  'switch：wrong-conversation': '⚠️ 桌面没切到绑定的对话，为免打扰你正在看的会话，这次没有继续处理。再发一次即可。',
  'switch：not-in-sidebar': '⚠️ 找不到绑定的对话，可能被删了。发 /sessions 重新接管一个。',
  'model：not-found': '⚠️ 绑定的模型不在当前列表里，发 /models 看看可选名称。',
};

function describeFailure(result) {
  const key = String(result?.error || '');
  if (FAILURE_HINTS[key]) return withLeftover(key, FAILURE_HINTS[key], result);
  const matched = Object.keys(FAILURE_HINTS).find((item) => key.startsWith(item.split('：')[0]));
  return matched ? withLeftover(key, FAILURE_HINTS[matched], result) : `⚠️ ${key || '处理失败'}`;
}

// 带上框内当时的实际内容，否则用户只看到一句无法据此行动的「再试一次」
function withLeftover(key, hint, result) {
  const leftover = String(result?.detail?.got || '').trim();
  return leftover && key.includes('fill-failed') ? `${hint}\n（输入框当时内容：${leftover}）` : hint;
}

// ---------------------------------------------------------------- 主动漫游

function proactiveBot() {
  return state.listBots().find((bot) => bot.proactive?.enabled) || null;
}

function applyProactiveConfig(bot) {
  const cfg = bot?.proactive || {};
  roamEngine.config.keywords = Array.isArray(cfg.keywords) ? cfg.keywords : [];
  roamEngine.config.cookie = secrets.get(bot?.id)?.biliCookie || '';
  roamEngine.config.platforms = normalizePlatforms(cfg.platforms || {});
  roamEngine.config.withVisual = cfg.withVisual !== false;
  roamEngine.config.deepRead = Number(cfg.deepRead || 2);
  proactiveGate.config.shareDaily = Number(cfg.shareDaily || 3);
  proactiveGate.config.minScore = Number(cfg.minScore || 13);
  return cfg;
}

async function proactiveTick() {
  const bot = proactiveBot();
  if (!bot) return;
  const due = proactiveClock.due();
  if (!due.due) return;
  const chatId = state.listBindings(bot.id)[0]?.chatId;
  const channel = channels.get(bot.id);
  if (!channel || !chatId) return;
  applyProactiveConfig(bot);
  logger.info(`[roam] 生物钟醒来（${due.window}）`);
  const result = await roamEngine.runOnce({
    reason: `bio-clock ${due.window}`,
    bot,
    send: async (text) => channel.sendText(chatId, text),
  });
  broadcast('roam', { botId: bot.id, pushed: result.pushed.length, skipped: result.skipped.length });
}

// ---------------------------------------------------------------- 扫码

/**
 * 桥接状态：Workbench 是懒连接的，光看 connected 会一直显示"未连接"。
 * 这里做一次轻量探测（只读端口文件 + /json/list，不建 WS），让面板状态是真实的。
 */
async function workbenchStatus() {
  if (workbench.connected) {
    return { connected: true, port: workbench.port, title: workbench.target?.title || '' };
  }
  const found = await discoverWorkbench();
  if (!found.ok) {
    return {
      connected: false,
      port: found.port || 0,
      title: '',
      reason: found.reason === 'no-port-file' ? '没找到 DevToolsActivePort（Antigravity 未开远程调试）' : '端口在，但没找到工作台页面',
    };
  }
  return { connected: false, port: found.port, title: found.target.title || '', ready: true, reason: '可连接（首次发送时自动建立）' };
}

async function qrDataUrl(text) {
  try {
    return await QRCode.toDataURL(text, { margin: 1, width: 420 });
  } catch (error) {
    logger.warn('二维码渲染失败：', error?.message || error);
    return '';
  }
}

/** QQ 官方扫码：手机 QQ 扫一下直接拿 AppID/AppSecret。 */
async function startQqScan({ alias = '' } = {}) {
  const sessionId = randomUUID();
  const session = { id: sessionId, platform: 'qq', status: 'wait', createdAt: Date.now(), qrcodeImage: '' };
  scanSessions.set(sessionId, session);

  const scan = startQrScan({
    onQr: async (url) => {
      session.qrcodeImage = await qrDataUrl(url);
      session.status = 'wait';
      broadcast('scan', { sessionId, status: 'wait' });
    },
    onStatus: (status) => {
      session.status = status;
      broadcast('scan', { sessionId, status });
    },
  });

  session.stop = () => scan.stop();

  scan.done
    .then(async (credentials) => {
      const first = credentials?.[0] || {};
      const botId = `qq-${randomUUID().slice(0, 8)}`;
      secrets.set(botId, { mode: 'official', appId: first.appId, appSecret: first.appSecret, ownerUserOpenid: first.userOpenid || '' });
      state.upsertBot({ id: botId, platform: 'qq', alias: alias || 'QQ机器人', enabled: true });
      await startBot(state.getBot(botId));
      session.status = 'bound';
      session.botId = botId;
    })
    .catch((error) => {
      session.status = 'error';
      session.error = error?.message || String(error);
    });

  return session;
}

/** 飞书扫码一键建应用。 */
async function startFeishuScan({ alias = '', domain = 'feishu' } = {}) {
  const sessionId = randomUUID();
  const session = { id: sessionId, platform: 'feishu', status: 'wait', createdAt: Date.now(), qrcodeImage: '' };
  scanSessions.set(sessionId, session);

  const controller = new AbortController();
  session.abort = () => controller.abort();
  startRegister({
    domain,
    signal: controller.signal,
    onQr: async (url) => {
      session.qrcodeImage = await qrDataUrl(url);
      broadcast('scan', { sessionId, status: 'wait' });
    },
    onStatus: (status) => {
      session.status = status;
      broadcast('scan', { sessionId, status });
    },
  })
    .then(async (raw) => {
      const { appId, appSecret, ownerOpenId, ownerName } = normalizeRegisterResult(raw);
      if (!appId || !appSecret) {
        throw new Error(`扫码成功但没拿到凭据（返回字段：${Object.keys(raw || {}).join(',') || '空'}）`);
      }
      const botId = `feishu-${randomUUID().slice(0, 8)}`;
      secrets.set(botId, { appId, appSecret, domain, ownerOpenId });
      state.upsertBot({ id: botId, platform: 'feishu', alias: alias || ownerName || '飞书机器人', enabled: true });
      await startBot(state.getBot(botId));
      session.status = 'bound';
      session.botId = botId;
    })
    .catch((error) => {
      if (controller.signal.aborted) {
        session.status = 'cancelled';
        return;
      }
      session.status = 'error';
      session.error = error?.message || String(error);
    });

  return session;
}

async function startWeixinScan({ botId, alias = '' } = {}) {
  const client = new IlinkClient();
  const localTokens = state
    .listBots()
    .filter((item) => item.platform === 'weixin')
    .map((item) => secrets.get(item.id)?.botToken)
    .filter(Boolean);
  const { qrcode, qrcodeImage } = await client.beginLogin({ localTokens });
  const sessionId = randomUUID();
  let dataUrl = '';
  try {
    dataUrl = await QRCode.toDataURL(qrcodeImage || qrcode, { margin: 1, width: 420 });
  } catch (error) {
    logger.warn('二维码渲染失败：', error?.message || error);
  }
  scanSessions.set(sessionId, {
    id: sessionId,
    platform: 'weixin',
    botId,
    qrcode,
    qrcodeImage: dataUrl,
    status: 'wait',
    createdAt: Date.now(),
  });
  pollWeixinScan(sessionId, client, qrcode, botId, alias).catch(() => {});
  return scanSessions.get(sessionId);
}

async function pollWeixinScan(sessionId, client, qrcode, botId, alias = '') {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const session = scanSessions.get(sessionId);
    if (!session) return;
    try {
      const result = await client.pollLogin({ qrcode });
      session.status = result.status;
      broadcast('scan', { sessionId, status: result.status });
      if (result.status === 'confirmed') {
        secrets.set(botId, {
          botToken: result.botToken,
          ilinkBotId: result.botId,
          ownerUserId: result.userId,
          baseUrl: result.baseUrl,
          getUpdatesBuf: '',
        });
        const bot = state.getBot(botId) || { id: botId, platform: 'weixin', alias: alias || '微信机器人' };
        state.upsertBot({ ...bot, alias: bot.alias || alias || '微信机器人', ownerUserId: result.userId, enabled: true });
        await stopBot(botId);
        await startBot(state.getBot(botId));
        session.status = 'bound';
        return;
      }
      if (result.status === 'expired') {
        session.status = 'expired';
        return;
      }
    } catch (error) {
      session.status = 'error';
      session.error = error?.message || String(error);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  const session = scanSessions.get(sessionId);
  if (session) session.status = 'expired';
}

// ---------------------------------------------------------------- HTTP

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function serveStatic(res, file) {
  const full = path.join(HERE, 'ui', file);
  if (!full.startsWith(path.join(HERE, 'ui'))) return json(res, 403, { ok: false });
  try {
    const data = fs.readFileSync(full);
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
    res.writeHead(200, {
      'content-type': `${type}; charset=utf-8`,
      'cache-control': 'no-cache, no-store, must-revalidate',
    });
    res.end(data);
  } catch {
    json(res, 404, { ok: false, error: 'not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/ui/panel.html' || pathname === '/ui/panel.css' || pathname === '/ui/panel.js') {
      return serveStatic(res, pathname.split('/').pop());
    }
    if (pathname === '/' || pathname === '/ui') {
      res.writeHead(302, { location: '/ui/panel.html' });
      return res.end();
    }

    if (pathname === '/api/update') {
      return json(res, 200, { ok: true, ...updateInfo });
    }

    if (pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        version: APP_VERSION,
        workbench: await workbenchStatus(),
        bots: state.listBots().map((bot) => ({
          id: bot.id,
          platform: bot.platform,
          alias: bot.alias,
          enabled: bot.enabled !== false,
          ...(channels.get(bot.id)?.describe?.() || { status: 'stopped' }),
        })),
        running: harness.runs.size,
        deferred: state.deferredCount,
        scans: [...scanSessions.values()].map((item) => ({ id: item.id.slice(0, 8), platform: item.platform, status: item.status, error: item.error || '' })),
      });
    }

    if (pathname === '/api/bots' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        bots: state.listBots().map((bot) => ({
          ...bot,
          ...(channels.get(bot.id)?.describe?.() || { status: 'stopped' }),
          secrets: redact(secrets.get(bot.id) || {}),
        })),
      });
    }

    if (pathname === '/api/bots' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.platform) return json(res, 400, { ok: false, error: 'platform 必填' });
      const bot = state.upsertBot({
        id: body.id || `${body.platform}-${randomUUID().slice(0, 8)}`,
        platform: body.platform,
        alias: body.alias || '',
        enabled: body.enabled !== false,
        defaultWorkspace: body.defaultWorkspace || '',
        defaultModel: body.defaultModel || '',
        busyMode: body.busyMode === 'steer' ? 'steer' : 'queue',
        groupAtOptional: Boolean(body.groupAtOptional),
        allowAll: Boolean(body.allowAll),
      });
      if (body.secrets && typeof body.secrets === 'object') secrets.set(bot.id, body.secrets);
      await startBot(bot);
      return json(res, 200, { ok: true, bot: { ...bot, secrets: redact(secrets.get(bot.id) || {}) } });
    }

    if (pathname.startsWith('/api/bots/')) {
      const botId = pathname.split('/')[3];
      const bot = state.getBot(botId);
      if (!bot) return json(res, 404, { ok: false, error: '机器人不存在' });
      if (req.method === 'DELETE') {
        await stopBot(botId);
        state.removeBot(botId);
        secrets.remove(botId);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const updated = state.upsertBot({ ...bot, ...body, id: botId });
        if (body.secrets) secrets.set(botId, body.secrets);
        await stopBot(botId);
        if (updated.enabled !== false) await startBot(updated);
        return json(res, 200, { ok: true, bot: { ...updated, secrets: redact(secrets.get(botId) || {}) } });
      }
    }

    if (pathname === '/api/scan' && req.method === 'POST') {
      const body = await readBody(req);
      const platform = body.platform || 'weixin';
      if (platform === 'weixin') {
        // 只在扫码成功后才建机器人记录，避免中途取消留下一堆空卡片
        const botId = body.botId || `weixin-${randomUUID().slice(0, 8)}`;
        return json(res, 200, { ok: true, session: await startWeixinScan({ botId, alias: body.alias }) });
      }
      if (platform === 'qq') {
        return json(res, 200, { ok: true, session: await startQqScan({ alias: body.alias }) });
      }
      if (platform === 'feishu') {
        return json(res, 200, { ok: true, session: await startFeishuScan({ alias: body.alias, domain: body.domain }) });
      }
      return json(res, 400, { ok: false, error: `不支持的平台：${platform}` });
    }

    if (pathname === '/api/verify' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        if (body.platform === 'feishu') {
          const info = await verifyFeishuCredentials(body.secrets || {});
          return json(res, 200, { ok: true, info });
        }
        if (body.platform === 'qq') {
          const info = await verifyQqCredentials(body.secrets || {});
          return json(res, 200, { ok: true, info });
        }
        return json(res, 400, { ok: false, error: '只有飞书 / QQ 需要凭据校验' });
      } catch (error) {
        return json(res, 200, { ok: false, error: error?.message || String(error) });
      }
    }

    if (pathname.startsWith('/api/scan/')) {
      const sessionId = pathname.split('/')[3];
      const session = scanSessions.get(sessionId);
      if (req.method === 'DELETE') {
        // 面板切平台/关弹窗时会来撤销：停掉底层轮询，别让它继续拉平台接口
        if (session) {
          try {
            session.abort?.();
            session.stop?.();
          } catch {
            /* ignore */
          }
          scanSessions.delete(sessionId);
        }
        return json(res, 200, { ok: true, cancelled: Boolean(session) });
      }
      if (!session) return json(res, 404, { ok: false, error: '扫码会话不存在' });
      return json(res, 200, { ok: true, session });
    }

    if (pathname === '/api/conversations') {
      const workspace = url.searchParams.get('workspace') || '';
      const limit = Number(url.searchParams.get('limit') || 40);
      return json(res, 200, { ok: true, items: index.list({ limit, workspace }) });
    }

    if (pathname === '/api/workspaces') {
      const all = index.list({ limit: 500 });
      const map = new Map();
      for (const item of all) {
        for (const ws of item.workspaces || []) {
          if (!ws) continue;
          const entry = map.get(ws) || { path: ws, count: 0, last: '' };
          entry.count += 1;
          if (item.lastModified > entry.last) entry.last = item.lastModified;
          map.set(ws, entry);
        }
      }
      return json(res, 200, { ok: true, items: [...map.values()] });
    }

    if (pathname === '/api/models') {
      // 面板的模型下拉就吃这个接口：列表直接来自 Antigravity 的模型菜单
      try {
        const info = await workbench.listModels({ force: url.searchParams.get('force') === '1' });
        return json(res, 200, {
          ok: Boolean(info.ok),
          current: info.current || '',
          items: info.items || [],
          error: info.ok ? '' : info.reason || '读不到模型菜单',
        });
      } catch (error) {
        return json(res, 200, { ok: false, current: '', items: [], error: error?.message || String(error) });
      }
    }

    if (pathname === '/api/bind' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.botId || !body.chatId) return json(res, 400, { ok: false, error: 'botId / chatId 必填' });
      const binding = state.setBinding(body.botId, body.chatId, {
        conversationId: body.conversationId || '',
        title: body.title || '',
        workspace: body.workspace || '',
        model: body.model || '',
      });
      return json(res, 200, { ok: true, binding });
    }

    if (pathname === '/api/unbind' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.botId) return json(res, 400, { ok: false, error: 'botId 必填' });
      if (body.all) {
        const items = state.listBindings(body.botId);
        for (const item of items) state.clearBinding(body.botId, item.chatId);
        return json(res, 200, { ok: true, removed: items.length });
      }
      if (!body.chatId) return json(res, 400, { ok: false, error: 'chatId 必填' });
      const removed = state.clearBinding(body.botId, body.chatId);
      return json(res, 200, { ok: true, removed });
    }

    if (pathname === '/api/inject' && req.method === 'POST') {
      try {
        const result = await injector.ensure();
        return json(res, 200, { ok: true, result });
      } catch (error) {
        return json(res, 502, { ok: false, error: error?.message || String(error) });
      }
    }

    if (pathname === '/api/cookies' && req.method === 'GET') {
      const botId = url.searchParams.get('botId') || proactiveBot()?.id || state.listBots()[0]?.id || '';
      const cookies = secrets.get(botId)?.cookies || {};
      return json(res, 200, {
        ok: true,
        botId,
        platforms: ['xhs', 'douyin', 'twitter'].map((key) => ({ key, configured: Boolean(cookies[key]) })),
      });
    }

    if (pathname === '/api/cookies' && req.method === 'POST') {
      const body = await readBody(req);
      const botId = body.botId || proactiveBot()?.id || state.listBots()[0]?.id || '';
      if (!botId) return json(res, 400, { ok: false, error: '还没有机器人' });
      const platform = String(body.platform || '');
      if (!['xhs', 'douyin', 'twitter'].includes(platform)) {
        return json(res, 400, { ok: false, error: '只支持 xhs / douyin / twitter' });
      }
      const existing = secrets.get(botId) || {};
      const cookies = { ...(existing.cookies || {}) };
      const value = String(body.cookie || '').trim();
      if (!value) delete cookies[platform];
      else cookies[platform] = value;
      secrets.set(botId, { cookies });
      return json(res, 200, { ok: true, platform, configured: Boolean(cookies[platform]) });
    }

    if (pathname === '/api/bili/status' && req.method === 'GET') {
      const botId = url.searchParams.get('botId') || proactiveBot()?.id || '';
      const cookie = secrets.get(botId)?.biliCookie || '';
      if (!cookie) return json(res, 200, { ok: true, loggedIn: false });
      const check = await verifyCookie(cookie);
      return json(res, 200, { ok: true, loggedIn: Boolean(check.ok), name: check.name || '', reason: check.reason || '' });
    }

    if (pathname === '/api/bili/qrcode' && req.method === 'POST') {
      try {
        const qr = await generateQr();
        if (!qr.ok) return json(res, 502, { ok: false, error: qr.reason });
        const dataUrl = await QRCode.toDataURL(qr.url, { margin: 1, width: 360 });
        biliScans.set(qr.qrcodeKey, { at: Date.now() });
        return json(res, 200, { ok: true, qrcodeKey: qr.qrcodeKey, dataUrl });
      } catch (error) {
        return json(res, 502, { ok: false, error: error?.message || String(error) });
      }
    }

    if (pathname.startsWith('/api/bili/qrcode/') && req.method === 'GET') {
      const key = pathname.split('/')[4];
      const botId = url.searchParams.get('botId') || proactiveBot()?.id || '';
      try {
        const resPoll = await pollQr(key);
        if (!resPoll.ok) return json(res, 200, { ok: false, status: resPoll.status, error: resPoll.reason });
        if (resPoll.status === 'confirmed' && resPoll.cookie) {
          const check = await verifyCookie(resPoll.cookie);
          if (check.ok) {
            secrets.set(botId, { biliCookie: resPoll.cookie, biliName: check.name, biliMid: check.mid });
            biliScans.delete(key);
            broadcast('bili-login', { botId, name: check.name });
            return json(res, 200, { ok: true, status: 'confirmed', name: check.name, mid: check.mid });
          }
          return json(res, 200, { ok: false, status: 'verify-failed', error: check.reason });
        }
        return json(res, 200, { ok: true, status: resPoll.status });
      } catch (error) {
        return json(res, 502, { ok: false, error: error?.message || String(error) });
      }
    }

    if (pathname === '/api/proactive' && req.method === 'GET') {
      const bot = proactiveBot();
      return json(res, 200, {
        ok: true,
        enabled: Boolean(bot),
        botId: bot?.id || '',
        config: bot?.proactive || null,
        platforms: platformStatus(bot?.proactive?.platforms || {}, { biliLoggedIn: Boolean(secrets.get(bot?.id)?.biliCookie) }),
        ...roamEngine.status(),
      });
    }

    if (pathname === '/api/proactive/config' && req.method === 'POST') {
      const body = await readBody(req);
      const bot = state.getBot(body.botId);
      if (!bot) return json(res, 404, { ok: false, error: '机器人不存在' });
      const next = { ...(bot.proactive || {}), ...(body.proactive || {}) };
      state.upsertBot({ ...bot, proactive: next });
      if (Array.isArray(next.windows)) {
        proactiveClock.windows = next.windows.map((w) => w).filter(Boolean);
        proactiveClock.windows = (await import('./proactive/bio-clock.mjs')).parseWindows(next.windows);
      }
      proactiveClock.skipChance = Math.max(0, Math.min(1, Number(next.skipChance ?? proactiveClock.skipChance)));
      proactiveClock.invalidate();
      if (body.biliCookie) secrets.set(bot.id, { biliCookie: String(body.biliCookie) });
      applyProactiveConfig(state.getBot(bot.id));
      return json(res, 200, { ok: true, config: state.getBot(bot.id).proactive, clock: proactiveClock.describe() });
    }

    if (pathname === '/api/proactive/roam' && req.method === 'POST') {
      const body = await readBody(req);
      const bot = state.getBot(body.botId) || proactiveBot();
      if (!bot) return json(res, 404, { ok: false, error: '机器人不存在' });
      applyProactiveConfig(bot);
      const chatId = body.chatId || state.listBindings(bot.id)[0]?.chatId || '';
      const channel = channels.get(bot.id);
      try {
        const result = await roamEngine.runOnce({
          reason: 'manual',
          bot,
          send: chatId && channel ? async (text) => channel.sendText(chatId, text) : null,
        });
        return json(res, 200, { ok: true, ...result, gate: proactiveGate.status() });
      } catch (error) {
        return json(res, 502, { ok: false, error: error?.message || String(error) });
      }
    }

    if (pathname === '/api/self-test' && req.method === 'POST') {
      // 本地自检：用一条假消息走完整的 dispatch 链路，把过程和错误原样返回（不依赖平台）
      const body = await readBody(req);
      const bot = state.getBot(body.botId);
      if (!bot) return json(res, 404, { ok: false, error: '机器人不存在' });
      const chatId = body.chatId || state.listBindings(bot.id)[0]?.chatId || 'self-test';
      // 自检不该污染真实绑定：跑完把这条临时聊天的绑定恢复原样
      const beforeBinding = state.getBinding(bot.id, chatId);
      const replies = [];
      const stub = {
        sendAck: async (_chatId, text) => {
          replies.push({ kind: 'ack', text: text || '（表情回应）' });
          return true;
        },
        sendText: async (_chatId, text) => {
          replies.push({ kind: 'text', text });
          return true;
        },
        sendFinal: async (_chatId, text, meta) => {
          replies.push({ kind: 'final', text, meta: meta || null });
          return true;
        },
        streamProgress: async () => {},
        beginTyping: async () => {},
        endTyping: async () => {},
      };
      try {
        const result = await hub.dispatch({
          bot,
          chatId,
          text: body.text || '自检：只回复两个字 收到',
          channel: stub,
        });
        if (chatId === 'self-test') {
          if (beforeBinding) state.setBinding(bot.id, chatId, beforeBinding);
          else state.clearBinding(bot.id, chatId);
        }
        return json(res, 200, { ok: true, chatId, result, replies });
      } catch (error) {
        return json(res, 500, {
          ok: false,
          chatId,
          error: error?.message || String(error),
          stack: String(error?.stack || '').split('\n').slice(0, 4),
          replies,
        });
      }
    }

    if (pathname === '/api/state') {
      return json(res, 200, {
        ok: true,
        bots: state.listBots().length,
        bindings: state.listBindings(),
        workbench: { connected: workbench.connected },
        running: [...harness.runs.entries()].map(([conversationId, info]) => ({ conversationId, ...info })),
      });
    }

    if (pathname === '/api/test-message' && req.method === 'POST') {
      const body = await readBody(req);
      const channel = channels.get(body.botId);
      if (!channel) return json(res, 404, { ok: false, error: '机器人未启动' });
      await channel.sendText(body.chatId || body.botId, body.text || 'antigravity远程-mogu 连接测试 ✅');
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/send' && req.method === 'POST') {
      const body = await readBody(req);
      const bindings = state.listBindings();
      let chatId = '';
      let botId = '';
      if (!body.target || body.target === 'last') {
        const latest = bindings.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
        if (latest) {
          botId = latest.key.split(':')[0];
          chatId = latest.chatId;
        }
      } else if (body.target.includes(':') && !bindings.some((item) => item.key === body.target)) {
        const [platform, ...rest] = body.target.split(':');
        chatId = rest.join(':');
        const bot = state.listBots().find((item) => item.platform === platform);
        botId = bot?.id || '';
      } else {
        const match = bindings.find((item) => item.key === body.target || item.chatId === body.target);
        botId = match ? match.key.split(':')[0] : '';
        chatId = match ? match.chatId : body.target;
      }
      const channel = channels.get(botId);
      if (!channel) return json(res, 404, { ok: false, error: '找不到对应的机器人或会话' });
      if (body.file) {
        const delivered = await channel.sendFile(chatId, body.file, { caption: body.text || '' });
        if (!delivered && body.text) await channel.sendText(chatId, body.text);
        return json(res, 200, { ok: true, delivered, chatId, botId });
      }
      await channel.sendText(chatId, body.text || '');
      return json(res, 200, { ok: true, delivered: true, chatId, botId });
    }

    if (pathname === '/api/approvals') {
      return json(res, 200, {
        ok: true,
        items: [...approvals.entries()].map(([id, item]) => ({ id, ...item })),
      });
    }

    if (pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return undefined;
    }

    if (pathname === '/api/help') return json(res, 200, { ok: true, text: helpText() });

    return json(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    logger.error('HTTP 处理异常：', error?.message || error);
    return json(res, 500, { ok: false, error: error?.message || String(error) });
  }
});

server.listen(PORT, HOST, async () => {
  logger.info(`antigravity远程-mogu 已启动：http://${HOST}:${PORT}/ui/panel.html`);
  logger.info(`状态目录：${dirs.home}`);
  // 设置面板注入不依赖任何渠道状态：先启动，否则一个挂住的渠道就会让面板永久白屏
  injector.start();
  logger.info('设置面板注入已启动（每 6s 检查一次）');
  checkForUpdate().catch(() => {});
  setInterval(() => checkForUpdate().catch(() => {}), 6 * 3600_000).unref();
  bootstrap().catch((error) => logger.error('后台启动未完成：', error?.message || error));
});

function shutdown() {
  sessionSync.stop();
  injector.stop();
  for (const channel of channels.values()) channel.stop?.();
  workbench.close();
  server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (error) => logger.error('未处理的 Promise 拒绝：', error));

export { hub, server, state, secrets, index, workbench, harness };
