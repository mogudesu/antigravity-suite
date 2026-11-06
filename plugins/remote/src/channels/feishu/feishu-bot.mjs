/**
 * 飞书机器人：WSClient 长连接 + 单张流式过程卡（Patch）+ 群 @ 门禁 + 卡片审批。
 *
 * 群聊安全：只有明确 @ 到本机器人的消息才响应，其它一律静默（旧版全群误触发的 bug 在这里堵住）。
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { splitText, Dedupe, stripMentions } from '../shared/text.mjs';
import { IMAGE_EXT, MAX_MEDIA_BYTES, sanitizeFileName, sniffImageExt } from '../shared/media.mjs';
import { ensureRuntimeDirs } from '../../store/paths.mjs';

const CARD_STREAM_INTERVAL_MS = 1000;
const FEISHU_IMAGE_LIMIT = 10 * 1024 * 1024;
const FEISHU_FILE_LIMIT = 30 * 1024 * 1024;

export class FeishuBot {
  constructor({ bot, secrets, hub, logger = console }) {
    this.bot = bot;
    this.secrets = secrets;
    this.hub = hub;
    this.logger = logger;
    this.client = null;
    this.ws = null;
    this.status = 'offline';
    this.lastError = '';
    this.dedupe = new Dedupe();
    this.cards = new Map(); // chatId -> { messageId, lastText, timer, patchable, replyTo }
    this.lastInbound = new Map(); // chatId -> 最近一条用户消息的 message_id（用于引用回复）
    this.ackReactions = new Map(); // chatId -> { messageId, emoji }，思考结束后要撤掉这颗「GET」
  }

  async start() {
    const { appId, appSecret } = this.secrets || {};
    if (!appId || !appSecret) {
      this.status = 'need-credentials';
      return;
    }
    const domain = this.secrets.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;
    this.client = new Lark.Client({ appId, appSecret, domain, loggerLevel: Lark.LoggerLevel.warn });

    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => this._onMessage(data),
      'card.action.trigger': async (data) => this._onCardAction(data),
    });
    this.ws = new Lark.WSClient({ appId, appSecret, domain, loggerLevel: Lark.LoggerLevel.warn });
    this.status = 'online';
    this.ws.start({ eventDispatcher: dispatcher }).catch((error) => {
      this.status = 'error';
      this.lastError = error?.message || String(error);
      this.logger.error?.(`[feishu] 长连接异常：${this.lastError}`);
    });
  }

  stop() {
    this.status = 'offline';
    try {
      this.ws?.close?.();
    } catch {
      /* ignore */
    }
  }

  async _onMessage(data) {
    const event = data?.message || data?.event?.message;
    const sender = data?.sender || data?.event?.sender;
    if (!event) return;
    if (sender?.sender_type === 'app') return; // 忽略机器人自己

    const chatId = event.chat_id;
    const chatType = event.chat_type || 'p2p';
    const messageId = event.message_id;
    if (!this.dedupe.check(messageId)) return;

    let content = {};
    try {
      content = JSON.parse(event.content || '{}');
    } catch {
      content = {};
    }
    const mentions = event.mentions || [];
    const mentionKeys = mentions.map((item) => item.key).filter(Boolean);

    // 群聊必须 @ 到本机器人
    if (chatType !== 'p2p') {
      const atMe = mentions.some((item) => {
        const name = item.name || '';
        return name && (name.includes(this.bot.alias || '') || item.id?.open_id === this.secrets.botOpenId);
      });
      if (!atMe && !this.bot.groupAtOptional) {
        this.logger.debug?.(`[feishu] 群里没 @ 我，忽略：${messageId}`);
        return;
      }
    }

    let text = '';
    let postImages = [];
    if (event.message_type === 'text') text = content.text || '';
    else if (event.message_type === 'post') {
      const post = extractPost(content);
      text = post.text;
      postImages = post.images;
    } else if (event.message_type === 'image') text = '（收到一张图片）';
    else if (event.message_type === 'file') text = content.file_name ? `（收到文件 ${content.file_name}）` : '（收到一个文件）';
    else if (event.message_type === 'sticker') text = '（收到一个表情包）';
    else if (event.message_type === 'audio') text = '（收到一条语音）';
    else if (event.message_type === 'media') text = content.file_name ? `（收到视频 ${content.file_name}）` : '（收到一个视频）';
    else text = `（收到 ${event.message_type} 消息）`;

    text = stripMentions(text, mentionKeys);
    const hasMedia = ['image', 'file', 'sticker', 'audio', 'media'].includes(event.message_type) || postImages.length > 0;
    if (!text.trim() && !hasMedia) return;
    if (!text.trim() && postImages.length) text = '（收到一张图片）';
    if (messageId) this.lastInbound.set(chatId, messageId);

    const attachments = hasMedia
      ? await this._downloadAll({ messageType: event.message_type, content, postImages, messageId })
      : [];
    if (hasMedia && !attachments.length) text = `${text}（附件下载失败，请重试）`;

    await this.hub.dispatch({
      bot: this.bot,
      chatId,
      text: text.trim() || '（收到一条媒体消息）',
      channel: this,
      messageId,
      replyTo: messageId,
      attachments,
    });
  }

  /** 入站图片/文件落盘到临时目录，交给 Agent 直接读路径。 */
  async _downloadAll({ messageType, content, postImages = [], messageId }) {
    if (!messageId || !this.client) return [];
    const refs = [];
    if (messageType === 'image' && content.image_key) {
      refs.push({ kind: 'image', resourceType: 'image', fileKey: content.image_key, name: 'image' });
    }
    if (messageType === 'file' && content.file_key) {
      refs.push({ kind: 'file', resourceType: 'file', fileKey: content.file_key, name: content.file_name || 'file' });
    }
    if (messageType === 'sticker') {
      const fileKey = content.file_key || content.image_key;
      if (fileKey) {
        refs.push({
          kind: 'image',
          resourceTypes: content.image_key ? ['image', 'file'] : ['file', 'image'],
          fileKey,
          name: 'sticker',
        });
      }
    }
    if (messageType === 'audio' && content.file_key) {
      refs.push({ kind: 'file', resourceType: 'audio', fileKey: content.file_key, name: content.file_name || 'audio.opus' });
    }
    if (messageType === 'media' && content.file_key) {
      refs.push({ kind: 'file', resourceType: 'media', fileKey: content.file_key, name: content.file_name || 'media.mp4' });
    }
    for (const imageKey of postImages) {
      refs.push({ kind: 'image', resourceType: 'image', fileKey: imageKey, name: 'image' });
    }
    if (!refs.length) return [];

    const dir = ensureRuntimeDirs().tmp;
    const saved = [];
    for (const [index, ref] of refs.entries()) {
      try {
        const name = sanitizeFileName(ref.name, ref.kind === 'image' ? `image-${index + 1}.jpg` : `file-${index + 1}`);
        let ext = path.extname(name);
        if (ref.kind === 'image') ext = ext || '.jpg';
        const file = path.join(dir, `fs-${Date.now()}-${randomUUID().slice(0, 6)}${ext}`);
        let resource = null;
        let lastError = null;
        for (const type of ref.resourceTypes || [ref.resourceType]) {
          try {
            resource = await this.client.im.v1.messageResource.get({
              params: { type },
              path: { message_id: messageId, file_key: ref.fileKey },
            });
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (!resource) throw lastError || new Error('下载失败');
        await resource.writeFile(file);
        const size = fs.statSync(file).size;
        if (size <= 0 || size > MAX_MEDIA_BYTES) {
          fs.rmSync(file, { force: true });
          this.logger.warn?.(`[feishu] 附件大小异常（${size}）：${ref.fileKey}`);
          continue;
        }
        if (ref.kind === 'image') {
          const actual = sniffImageExt(fs.readFileSync(file).subarray(0, 16));
          if (actual && actual !== ext) {
            const renamed = `${file.slice(0, -ext.length)}${actual}`;
            fs.renameSync(file, renamed);
            saved.push(renamed);
            continue;
          }
        }
        saved.push(file);
      } catch (error) {
        this.logger.warn?.(`[feishu] 下载附件失败（${ref.fileKey}）：${error?.message || error}`);
      }
    }
    return saved;
  }

  async _onCardAction(data) {
    const value = data?.action?.value || data?.event?.action?.value || {};
    if (!value?.agb_action) return { toast: { type: 'info', content: '未知操作' } };
    const chatId = data?.context?.open_chat_id || data?.event?.context?.open_chat_id || '';
    try {
      const result = await this.hub.handleApproval({
        botId: this.bot.id,
        chatId,
        approvalId: value.agb_id,
        action: value.agb_action,
      });
      return { toast: { type: 'success', content: result || '已处理' } };
    } catch (error) {
      return { toast: { type: 'error', content: `处理失败：${error?.message || error}` } };
    }
  }

  /** 发文本（自动按 3000 字切分）。 */
  async sendText(chatId, text, { replyTo = '' } = {}) {
    for (const chunk of splitText(text, 3000)) {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: chunk }) },
      });
    }
    return true;
  }

  /**
   * 收到消息的回执：**只给你那条消息加一个表情**（飞书原生 reaction），不发任何文字。
   * 正式答案才发文字，聊天记录里不会多出一条"收到"。
   */
  async sendAck(chatId, _text = '') {
    const messageId = this.lastInbound.get(chatId);
    if (!messageId) return false;
    // 飞书没有字面的「收到」emoji_type（会 231001），中文界面里「收到」对应 Get
    const preferred = this.bot.ackEmoji || 'Get';
    for (const emoji of [preferred, 'OK']) {
      try {
        const created = await this.client.im.v1.messageReaction.create({
          path: { message_id: messageId },
          data: { reaction_type: { emoji_type: emoji } },
        });
        this.ackReactions.set(chatId, {
          messageId,
          emoji,
          reactionId: created?.data?.reaction_id || '',
        });
        this.logger.debug?.(`[feishu] 已用表情回应：${emoji}`);
        return true;
      } catch (error) {
        const code = error?.response?.data?.code || '';
        this.logger.warn?.(`[feishu] 表情回应失败（${emoji}${code ? ' / ' + code : ''}）：${error?.message || error}`);
      }
    }
    return false;
  }

  /** 思考结束（出答案 / 失败 / 超时）后撤掉回执表情，别让「GET」一直挂在你那条消息上。 */
  async clearAck(chatId) {
    const ack = this.ackReactions.get(chatId);
    if (!ack) return false;
    this.ackReactions.delete(chatId);
    // 这个 SDK 的 delete 是按 reaction_id 删的；拿不到 id 时再退回按表情类型删
    const attempts = ack.reactionId
      ? [{ path: { message_id: ack.messageId, reaction_id: ack.reactionId } }]
      : [
        { path: { message_id: ack.messageId }, params: { reaction_type: JSON.stringify({ emoji_type: ack.emoji }) } },
        { path: { message_id: ack.messageId }, data: { reaction_type: JSON.stringify({ emoji_type: ack.emoji }) } },
      ];
    for (const payload of attempts) {
      try {
        await this.client.im.v1.messageReaction.delete(payload);
        return true;
      } catch (error) {
        this.logger.debug?.('[feishu] 撤销回执表情失败：', error?.message || error);
      }
    }
    return false;
  }

  /** 过程不推送：正式答案才发文字，避免刷屏。 */
  async streamProgress() {
    return false;
  }

  /** 正式答复：一条普通文本消息（不引用、不卡片）。 */
  async sendFinal(chatId, text) {
    return this.sendText(chatId, text);
  }

  /** 审批卡片。 */
  async sendApproval(chatId, approval) {
    const card = {
      config: { wide_screen_mode: true },
      header: { template: 'red', title: { tag: 'plain_text', content: `需要确认：${approval.title}` } },
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: approval.detail || '' } },
        {
          tag: 'action',
          actions: [
            { tag: 'button', text: { tag: 'plain_text', content: '允许' }, type: 'primary', value: { agb_action: 'approve', agb_id: approval.id } },
            { tag: 'button', text: { tag: 'plain_text', content: '拒绝' }, type: 'danger', value: { agb_action: 'deny', agb_id: approval.id } },
          ],
        },
        { tag: 'note', elements: [{ tag: 'plain_text', content: `编号 ${approval.id}` }] },
      ],
    };
    await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
    });
    return true;
  }

  /** 出站图片/文件：先上传拿 key，再发原生 image/file 消息。 */
  async sendFile(chatId, filePath, { caption = '' } = {}) {
    if (!filePath || !fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) return false;
    const name = path.basename(filePath);
    try {
      if (IMAGE_EXT.test(name) && stat.size <= FEISHU_IMAGE_LIMIT) {
        const uploaded = await this.client.im.v1.image.create({
          data: { image_type: 'message', image: fs.createReadStream(filePath) },
        });
        const imageKey = uploaded?.image_key || uploaded?.data?.image_key;
        if (!imageKey) throw new Error('图片上传未返回 image_key');
        await this._sendMedia(chatId, 'image', { image_key: imageKey });
      } else {
        if (stat.size > FEISHU_FILE_LIMIT) {
          this.logger.warn?.(`[feishu] 文件超过 30MB，无法上传：${name}`);
          return false;
        }
        const uploaded = await this.client.im.v1.file.create({
          data: { file_type: feishuFileType(name), file_name: name, file: fs.createReadStream(filePath) },
        });
        const fileKey = uploaded?.file_key || uploaded?.data?.file_key;
        if (!fileKey) throw new Error('文件上传未返回 file_key');
        await this._sendMedia(chatId, 'file', { file_key: fileKey });
      }
      if (caption) await this.sendText(chatId, caption);
      return true;
    } catch (error) {
      this.logger.warn?.(`[feishu] 发送文件失败：${error?.message || error}`);
      return false;
    }
  }

  async _sendMedia(chatId, msgType, content) {
    await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: msgType, content: JSON.stringify(content) },
    });
  }

  describe() {
    return { status: this.status, lastError: this.lastError };
  }
}

function extractPost(content) {
  const body = content.content || content.zh_cn?.content || [];
  const title = content.title || content.zh_cn?.title || '';
  const parts = [];
  const images = [];
  if (title) parts.push(title);
  for (const line of body) {
    for (const node of line || []) {
      if (node?.text) parts.push(node.text);
      if (node?.tag === 'img' && node.image_key) images.push(node.image_key);
      if (node?.tag === 'emotion') parts.push(node.emoji_type ? `[${node.emoji_type}]` : '[表情]');
    }
    parts.push('\n');
  }
  return { text: parts.join('').trim(), images: [...new Set(images)] };
}

function extractPostText(content) {
  return extractPost(content).text;
}

function feishuFileType(name) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.mp4') return 'mp4';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.doc' || ext === '.docx') return 'doc';
  if (ext === '.xls' || ext === '.xlsx') return 'xls';
  if (ext === '.ppt' || ext === '.pptx') return 'ppt';
  if (ext === '.opus' || ext === '.ogg') return 'opus';
  return 'stream';
}

function renderProgress(progress) {
  if (progress?.ack) return String(progress.ack);
  const lines = [];
  if (progress.tools?.length) {
    const recent = progress.tools.slice(-3).map((tool) => `· ${tool.name}`);
    lines.push('正在执行：', ...recent);
  }
  if (progress.thinking) {
    lines.push('', progress.thinking.slice(-600));
  }
  if (progress.answer) {
    lines.push('', progress.answer.slice(0, 1200));
  }
  if (!lines.length) lines.push('正在思考…');
  return lines.join('\n');
}

function buildProgressCard(text) {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: 'Antigravity 正在处理…' } },
    elements: [{ tag: 'div', text: { tag: 'plain_text', content: text.slice(0, 2000) } }],
  };
}

function buildResultCard(text, meta) {
  const footer = [meta.model ? `模型 ${meta.model}` : '', meta.elapsed ? `耗时 ${Math.round(meta.elapsed / 1000)}s` : '']
    .filter(Boolean)
    .join(' · ');
  return {
    config: { wide_screen_mode: true },
    header: { template: 'green', title: { tag: 'plain_text', content: 'Antigravity 回复' } },
    elements: [
      { tag: 'div', text: { tag: 'plain_text', content: text.slice(0, 3000) } },
      ...(footer ? [{ tag: 'note', elements: [{ tag: 'plain_text', content: footer }] }] : []),
    ],
  };
}

export const __test__ = { extractPost, extractPostText, renderProgress, buildProgressCard, buildResultCard };
