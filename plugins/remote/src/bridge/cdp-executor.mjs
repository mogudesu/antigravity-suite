/**
 * CDP 执行器：唯一允许碰 Antigravity 界面的地方。
 *
 * 设计原则（对应并发串台的根治）：
 *  1. 所有会改变界面的动作都走同一把全局 WorkbenchMutex，串行执行；
 *  2. 临界区尽量短——只做「切会话 → 填字 → 发送」或「切模型」，发完立刻释放；
 *  3. 等待回复完全不碰界面（读 transcript.jsonl），所以你在电脑上随便切会话都不影响；
 *  4. 每一步都用「读回来的真实状态」校验，失败就如实返回原因，不静默重试。
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { discoverWorkbench } from './port-discovery.mjs';
import { isAntigravityRunning, launchAntigravity } from './launcher.mjs';

export class Mutex {
  constructor() {
    this.tail = Promise.resolve();
    this.depth = 0;
  }

  get busy() {
    return this.depth > 0;
  }

  run(task) {
    const start = this.tail.then(
      () => {
        this.depth += 1;
        return task();
      },
      () => {
        this.depth += 1;
        return task();
      },
    );
    this.tail = start.catch(() => {}).finally(() => {
      this.depth -= 1;
    });
    return start;
  }
}

export class CdpError extends Error {}
export class CdpDisconnected extends CdpError {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function discoveryFailureMessage(found, launch = null) {
  const launched = Boolean(launch?.ok);
  if (found.reason === 'no-port-file') {
    if (launch?.reason === 'exe-not-found') {
      return '没找到 Antigravity.exe，也没读到 DevToolsActivePort：请确认 Antigravity 已安装，或手动启动后再试';
    }
    return launched
      ? '没找到 DevToolsActivePort：Antigravity 正在启动，请等窗口出现后再发一次'
      : '没找到 DevToolsActivePort：Antigravity 没在运行（发消息会自动拉起；也可以手动启动后再试）';
  }
  if (found.reason === 'browser-down') {
    return launched
      ? `Antigravity 的调试端口 ${found.port} 还没起来：已自动打开客户端，请等窗口加载完再发一次`
      : `Antigravity 的调试端口 ${found.port} 没有响应（DevToolsActivePort 多半是上次留下的旧文件）：请启动 Antigravity 后再试`;
  }
  return `CDP 端口 ${found.port} 在，但工作台页面还没就绪：Antigravity 正在启动，请稍后重试`;
}

export class CdpClient {
  constructor(wsUrl, { callTimeout = 20000 } = {}) {
    this.wsUrl = wsUrl;
    this.callTimeout = callTimeout;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
  }

  static async connect(wsUrl, options) {
    const client = new CdpClient(wsUrl, options);
    await client.open();
    return client;
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => reject(new CdpError('CDP 连接超时')), 8000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new CdpError('CDP 连接失败'));
      });
      ws.addEventListener('message', (event) => this._onMessage(event.data));
      ws.addEventListener('close', () => {
        this.closed = true;
        for (const { reject: rejectCall } of this.pending.values()) {
          rejectCall(new CdpDisconnected('CDP 连接已断开'));
        }
        this.pending.clear();
      });
    });
  }

  _onMessage(data) {
    let payload;
    try {
      payload = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      return;
    }
    if (payload.id == null) return;
    const entry = this.pending.get(payload.id);
    if (!entry) return;
    this.pending.delete(payload.id);
    if (payload.error) entry.reject(new CdpError(payload.error.message || JSON.stringify(payload.error)));
    else entry.resolve(payload.result || {});
  }

  get connected() {
    return Boolean(this.ws) && this.ws.readyState === 1;
  }

  call(method, params = {}, { timeout = this.callTimeout } = {}) {
    if (!this.connected) return Promise.reject(new CdpDisconnected('CDP 未连接'));
    this.nextId += 1;
    const id = this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`CDP 调用超时：${method}`));
      }, timeout);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, { awaitPromise = false } = {}) {
    const result = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
      includeCommandLineAPI: true,
    });
    if (result.exceptionDetails) {
      const desc =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        '页面脚本异常';
      throw new CdpError(String(desc).split('\n')[0].slice(0, 300));
    }
    return result.result?.value;
  }

  async insertText(text) {
    await this.call('Input.insertText', { text });
  }

  async clickAt(x, y) {
    const base = { x, y, button: 'left', clickCount: 1 };
    await this.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await this.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }

  async pressKey(key, code, vk, modifiers = 0) {
    const common = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
    await this.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common });
    await this.call('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}

// ---------------------------------------------------------------- 页面脚本

const SEL_DEFAULTS = {
  input: '[data-testid="agent-input-box"] [aria-label="Message input"]',
  send: '[data-testid="send-button"]',
  cancel: '[data-testid="agent-input-box"] button[aria-label*="Cancel"]',
  modelTrigger: '[data-testid="model-selector-trigger"]',
  modelMenu: '[role="menu"]',
  convRow: '[data-testid="conversation-row-sidebar"]',
  projectHeader: '[data-testid="project-header"]',
  newConversation: '[data-testid="new-conversation-button"]',
  settingsDialog: '[role="dialog"][aria-label="Settings"]',
};

/**
 * 选择器画像：默认值来自 legacy-python 的实测记录，可用 src/bridge/selectors.json 热覆盖。
 * 单项写数组时取第一个（和旧版 Python 的"按顺序尝试"语义保持一致）。
 */
export const SEL = (() => {
  const merged = { ...SEL_DEFAULTS };
  try {
    const file = fileURLToPath(new URL('./selectors.json', import.meta.url));
    const custom = JSON.parse(fs.readFileSync(file, 'utf8'));
    const map = {
      input: 'input',
      inputBox: 'inputBox',
      sendButton: 'send',
      cancelButton: 'cancel',
      conversationRow: 'convRow',
      projectHeader: 'projectHeader',
      newConversation: 'newConversation',
      modelTrigger: 'modelTrigger',
      modelMenu: 'modelMenu',
    };
    for (const [jsonKey, selKey] of Object.entries(map)) {
      const value = custom[jsonKey];
      if (!value) continue;
      merged[selKey] = Array.isArray(value) ? value[0] : String(value);
    }
  } catch {
    /* 没有覆盖文件就用默认值 */
  }
  return merged;
})();

const PRELUDE = `
const qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
  return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none'; };
const first = (sel) => qsa(sel).find(vis) || null;
const norm = (t) => String(t == null ? '' : t).replace(/\\s+/g, ' ').trim();
const convId = () => { const m = (location.href || '').match(/\\/c\\/([0-9a-zA-Z-]{8,})/); return m ? m[1] : ''; };
const convRows = () => { const seen = new Set(); const out = [];
  for (const el of qsa('${SEL.convRow}')) {
    if (!vis(el)) continue;
    const id = el.getAttribute('data-cascade-id') || (el.querySelector('a[href*="/c/"]')?.getAttribute('href') || '').split('/c/')[1] || '';
    if (!id || seen.has(id)) continue; seen.add(id); out.push(el);
  } return out; };
const cleanModel = (t) => String(t || '').replace(/\\s+/g, ' ')
  .replace(/\\s*(New|Notice|Beta|Preview|Unavailable)\\s*$/i, '').trim();
const readTriggerModel = () => {
  const trigger = first('${SEL.modelTrigger}');
  if (!trigger) return { text: '', aria: '', raw: '' };
  const aria = String(trigger.getAttribute('aria-label') || '');
  const m = aria.match(/current:\\s*(.+)$/i);
  const ariaModel = m ? cleanModel(m[1]) : '';
  const textModel = cleanModel(trigger.innerText);
  return { text: textModel, aria: ariaModel, raw: ariaModel || textModel };
};
const modelItems = () => { const menu = first('${SEL.modelMenu}'); if (!menu) return [];
  return qsa('[role="menuitem"]', menu).filter(vis).filter((el) => {
    if (el.getAttribute('aria-disabled') === 'true') return false;
    const raw = String(el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (/\\bUnavailable\\s*$/i.test(raw)) return false;
    const label = cleanModel(raw);
    return label && !/^(View Usage|使用量|查看用量|管理模型|Manage models?)$/i.test(label);
  }); };
`;

function script(body) {
  return `(() => { ${PRELUDE}\n${body}\n})()`;
}

const JS_STATE = script(`
const input = first('${SEL.input}');
const send = first('${SEL.send}');
const cancel = first('${SEL.cancel}') ||
  first('[aria-label="Stop execution"], [data-testid="status-task-running"], button[aria-label*="取消"]');
const triggerInfo = readTriggerModel();
const row = convRows().find((el) => el.getAttribute('data-selected') === 'true');
const menu = first('${SEL.modelMenu}');
return {
  ok: true,
  url: location.href,
  conversationId: convId(),
  conversationTitle: row ? norm(row.innerText) : '',
  pageTitle: document.title || '',
  hasInput: Boolean(input),
  inputText: input ? norm(input.innerText) : '',
  hasSend: Boolean(send),
  sendDisabled: send ? Boolean(send.disabled) : null,
  cancelVisible: Boolean(cancel),
  // 输入框为空时发送按钮本来就不渲染，绝不能据此判定"正在生成"
  busy: Boolean(cancel),
  model: triggerInfo.raw,
  modelDisplay: triggerInfo.text,
  menuOpen: Boolean(menu),
};
`);

const JS_INPUT_POINT = script(`
const input = first('${SEL.input}');
if (!input) return { ok: false, reason: 'no-input' };
const r = input.getBoundingClientRect();
return { ok: true, x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 18) };
`);

const JS_EXPAND = script(`
const headers = qsa('${SEL.projectHeader}').filter((el) => el.getAttribute('aria-expanded') === 'false');
if (!headers.length) return { ok: true, collapsed: 0 };
if (document.querySelector('${SEL.settingsDialog}')) return { ok: true, collapsed: headers.length, skipped: 'dialog-open' };
headers.forEach((header) => header.click());
return { ok: true, collapsed: headers.length };
`);

// 只做聚焦：把光标放进输入框，后续用 CDP 的 Input.insertText 打字。
// 这样不需要鼠标命中测试，设置弹窗盖住输入框也能写进去。
const JS_FOCUS_INPUT = script(`
const input = first('${SEL.input}');
if (!input) return { ok: false, reason: 'no-input' };
input.focus();
const range = document.createRange();
range.selectNodeContents(input);
const sel = window.getSelection();
if (sel) { sel.removeAllRanges(); sel.addRange(range); }
return { ok: document.activeElement === input || input.contains(document.activeElement), reason: 'focus-failed' };
`);

const JS_CLICK_SEND = script(`
const send = first('${SEL.send}');
if (!send) return { ok: false, reason: 'no-send' };
if (send.disabled) return { ok: false, reason: 'disabled' };
send.click();
return { ok: true };
`);

const JS_CLICK_CANCEL = script(`
const btn = first('${SEL.cancel}');
if (!btn) return { ok: false, reason: 'no-cancel' };
btn.click();
return { ok: true };
`);

const JS_OPEN_MODEL = script(`
const trigger = first('${SEL.modelTrigger}');
if (!trigger) return { ok: false, reason: 'no-model-trigger' };
trigger.click();
return { ok: true };
`);

const JS_MODEL_ITEMS = script(`
const triggerInfo = readTriggerModel();
const items = modelItems();
return {
  ok: true,
  current: triggerInfo.raw,
  currentDisplay: triggerInfo.text,
  items: items.map((el) => {
    const r = el.getBoundingClientRect();
    const effortGroup = el.querySelector('[data-testid="model-selector-effort-group"]');
    return {
      label: cleanModel(el.innerText),
      base: effortGroup?.dataset?.modelBase || '',
      hasSubmenu: el.getAttribute('aria-haspopup') === 'menu' || Boolean(effortGroup),
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
    };
  }),
};
`);

const JS_LIST_MODELS_LIVE = `(async () => {
  ${PRELUDE}
  const triggerInfo = readTriggerModel();
  const token = window.__APP_CONFIG__ && window.__APP_CONFIG__.csrfToken;
  if (!token) {
    return { ok: false, reason: 'no-csrf-token', currentRaw: triggerInfo.raw, currentDisplay: triggerInfo.text };
  }
  const payload = new TextEncoder().encode('{}');
  const frame = new Uint8Array(5 + payload.length);
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  const res = await fetch('/exa.language_server_pb.LanguageServerService/GetUserStatus', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/grpc-web+json',
      'x-grpc-web': '1',
      'x-codeium-csrf-token': token,
      'x-user-agent': 'CONNECT_ES_USER_AGENT',
    },
    body: frame,
  });
  if (!res.ok) {
    return { ok: false, reason: 'ls-http-' + res.status, currentRaw: triggerInfo.raw, currentDisplay: triggerInfo.text };
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  let off = 0;
  let msg = null;
  while (off + 5 <= buf.length) {
    const len = ((buf[off + 1] << 24) | (buf[off + 2] << 16) | (buf[off + 3] << 8) | buf[off + 4]) >>> 0;
    const start = off + 5;
    off = start + len;
    if (len > 0 && off <= buf.length) {
      try { msg = JSON.parse(new TextDecoder().decode(buf.subarray(start, off))); } catch {}
    }
  }
  const data = msg?.userStatus?.cascadeModelConfigData;
  if (!data || !Array.isArray(data.clientModelConfigs)) {
    return { ok: false, reason: 'no-model-configs', currentRaw: triggerInfo.raw, currentDisplay: triggerInfo.text };
  }
  return {
    ok: true,
    currentRaw: triggerInfo.raw,
    currentDisplay: triggerInfo.text,
    configs: data.clientModelConfigs.map((c) => ({
      label: String(c.label || ''),
      modelId: String(c.modelId || ''),
      model: String(c.modelOrAlias?.model || ''),
      disabled: Boolean(c.disabled),
      tagTitle: String(c.tagTitle || ''),
      quota: typeof c.quotaInfo?.remainingFraction === 'number' ? c.quotaInfo.remainingFraction : null,
      resetTime: String(c.quotaInfo?.resetTime || ''),
    })),
    sorts: Array.isArray(data.clientModelSorts) ? data.clientModelSorts : [],
  };
})()`;

const JS_PICK_EFFORT = (baseMatch, effort) => `(async () => {
  ${PRELUDE}
  const menu = qsa('${SEL.modelMenu}').filter(vis).find((n) => n.querySelector('[data-testid="model-selector-panel"]')) || first('${SEL.modelMenu}');
  if (!menu) return { ok: false, reason: 'no-menu' };
  const wantBase = ${JSON.stringify(baseMatch)}.toLowerCase();
  const rows = qsa('[role="menuitem"]', menu).filter(vis);
  const row = rows.find((el) => {
    const groupBase = (el.querySelector('[data-testid="model-selector-effort-group"]')?.dataset?.modelBase || '').trim().toLowerCase();
    const label = cleanModel(el.innerText).toLowerCase();
    return (groupBase && groupBase === wantBase) || label === wantBase || label.startsWith(wantBase);
  });
  if (!row) return { ok: false, reason: 'no-row' };
  const r = row.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 1, pointerType: 'mouse' };
  row.dispatchEvent(new PointerEvent('pointerenter', { ...opts, bubbles: false }));
  row.dispatchEvent(new PointerEvent('pointerover', opts));
  row.dispatchEvent(new PointerEvent('pointermove', opts));
  row.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
  row.dispatchEvent(new MouseEvent('mouseover', opts));
  row.dispatchEvent(new MouseEvent('mousemove', opts));
  await new Promise((resolve) => setTimeout(resolve, 160));
  row.focus();
  if (row.getAttribute('aria-expanded') !== 'true') {
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true }));
  }
  let submenu = null;
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 60));
    const controls = row.getAttribute('aria-controls');
    if (controls) {
      const candidate = document.getElementById(controls);
      if (candidate && candidate !== menu) { submenu = candidate; break; }
    }
    const found = qsa('[role="menu"]').find((node) => node !== menu && node.querySelector('[data-testid="model-selector-effort-option"]'));
    if (found) { submenu = found; break; }
  }
  if (!submenu) return { ok: false, reason: 'no-submenu' };
  const wantEffort = ${JSON.stringify(effort)}.toLowerCase();
  const aliasMap = { minimal: ['minimal', '极低'], low: ['low', '低'], medium: ['medium', '中'], high: ['high', '高'], xhigh: ['xhigh', '极高'] };
  const names = aliasMap[wantEffort] || [wantEffort];
  const optEl = submenu.querySelector('[data-testid="model-selector-effort-option"][data-effort="' + wantEffort + '"]');
  const target = optEl?.closest('[role="menuitem"], [role="menuitemradio"]') ||
    qsa('[role="menuitem"], [role="menuitemradio"]', submenu).find((item) => names.includes(norm(item.innerText).toLowerCase()));
  if (!target) return { ok: false, reason: 'no-effort-option' };
  target.click();
  return { ok: true };
})()`;

const JS_CLOSE_MENU = script(`
const menu = first('${SEL.modelMenu}');
if (!menu) return { ok: true, alreadyClosed: true };
// 优先再点一次触发器（toggle 关闭）——绝不能用 Escape：
// 设置弹窗监听 document 的 Escape，一按就把整个设置窗口关掉。
const trigger = first('${SEL.modelTrigger}');
if (trigger) trigger.click();
if (first('${SEL.modelMenu}') && !document.querySelector('${SEL.settingsDialog}')) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
}
return { ok: true };
`);

const JS_SELECT_CONV = (id) => script(`
const want = ${JSON.stringify(id)};
for (const row of convRows()) {
  if (row.getAttribute('data-cascade-id') !== want && !(row.querySelector('a[href*="/c/"]')?.getAttribute('href') || '').includes(want)) continue;
  row.scrollIntoView({ block: 'nearest' });
  (row.querySelector('a[href*="/c/"]') || row).click();
  const r = row.getBoundingClientRect();
  return { ok: true, point: { x: r.left + Math.min(r.width / 2, 80), y: r.top + r.height / 2 } };
}
return { ok: false, reason: 'not-in-sidebar' };
`);

const JS_CLICK_APPROVAL = (text, index) => script(`
const want = norm(${JSON.stringify(text)}).toLowerCase();
const scope = [first('${SEL.settingsDialog}') || document.body];
const agent = Array.from(qsa('[role="article"]')).filter(vis).filter((el) => /agent response/i.test(el.getAttribute('aria-label') || '')).pop();
if (agent) scope.push(agent);
const buttons = [];
for (const root of scope) {
  for (const el of qsa('button,[role="button"]', root)) {
    if (!vis(el)) continue;
    if (qsa('button,[role="button"]', el).length) continue;
    const label = norm(el.innerText).toLowerCase();
    if (label === want) buttons.push(el);
  }
}
if (!buttons.length) return { ok: false, reason: 'not-found' };
const target = buttons[${Number(index) || 0}];
if (!target) return { ok: false, reason: 'index-out-of-range', count: buttons.length };
target.click();
return { ok: true, count: buttons.length, clicked: norm(target.innerText) };
`);

// ---------------------------------------------------------------- Workbench

export class Workbench {
  constructor({ mutex = new Mutex(), logger = console, portFile, autoLaunch = process.env.AG_AUTO_LAUNCH !== '0' } = {}) {
    this.mutex = mutex;
    this.logger = logger;
    this.portFile = portFile;
    this.autoLaunch = autoLaunch;
    this.client = null;
    this.target = null;
    this.port = 0;
    this._launchAt = 0;
    this._launchResult = null;
    this._ensuring = null;
  }

  get connected() {
    return Boolean(this.client?.connected);
  }

  async ensure({ waitMs = 0 } = {}) {
    if (this.connected) return this.client;
    if (this._ensuring) return this._ensuring;
    this._ensuring = (async () => {
      const found = await discoverWorkbench({ portFile: this.portFile, waitMs });
      if (!found.ok) throw new CdpError(discoveryFailureMessage(found, this._launchResult));
      return this._attach(found);
    })();
    try {
      return await this._ensuring;
    } finally {
      this._ensuring = null;
    }
  }

  /**
   * 用户动作入口：等 Antigravity 就绪；没运行时自动拉起再等窗口。
   * 开机后 hub 先起、Antigravity 还没启动的窗口期就靠这里兜住。
   */
  async ensureReady({ waitMs = 30000 } = {}) {
    if (this.connected) return this.client;
    const deadline = Date.now() + Math.max(0, waitMs);
    let found = await discoverWorkbench({ portFile: this.portFile, waitMs: Math.min(1200, waitMs) });
    if (!found.ok && (found.reason === 'browser-down' || found.reason === 'no-port-file')) {
      this._launchResult = await this._ensureLaunched();
      found = await discoverWorkbench({ portFile: this.portFile, waitMs: Math.max(0, deadline - Date.now()) });
    } else if (!found.ok) {
      found = await discoverWorkbench({ portFile: this.portFile, waitMs: Math.max(0, deadline - Date.now()) });
    }
    if (!found.ok) throw new CdpError(discoveryFailureMessage(found, this._launchResult));
    return this._attach(found);
  }

  /** 只在「确实没在运行」且冷却结束时拉起一次，避免并发消息重复开窗。 */
  async _ensureLaunched() {
    if (!this.autoLaunch) return { ok: false, reason: 'disabled' };
    if (Date.now() - this._launchAt < 120_000) return this._launchResult || { ok: false, reason: 'cooldown' };
    this._launchAt = Date.now();
    if (await isAntigravityRunning()) {
      this._launchResult = { ok: false, reason: 'already-running' };
      return this._launchResult;
    }
    this._launchResult = launchAntigravity();
    if (this._launchResult.ok) this.logger.info?.(`Antigravity 未运行，已自动拉起：${this._launchResult.exe}`);
    else this.logger.warn?.(`自动拉起 Antigravity 失败：${this._launchResult.reason}`);
    return this._launchResult;
  }

  async _attach(found) {
    this.client?.close();
    this.client = await CdpClient.connect(found.target.wsUrl);
    this.target = found.target;
    this.port = found.port;
    this.logger.info?.(`CDP 已连接：${found.target.title || '(无标题)'} @ ${found.port}`);
    return this.client;
  }

  async snapshot() {
    const client = await this.ensure();
    return client.evaluate(JS_STATE);
  }

  /** 当前会话 id（来自 URL）。 */
  async currentConversationId() {
    const state = await this.snapshot();
    return state.conversationId;
  }

  /**
   * 切到指定会话。只点侧边栏（已验证不跳转），点不到就展开项目分组再试。
   * 必须在 mutex 内调用。
   */
  async _switchTo(conversationId) {
    const client = await this.ensure();
    let before = await client.evaluate(JS_STATE);
    if (before.conversationId === conversationId) return { ok: true, already: true };

    // 正在生成时切会话会打断当前回答，严重时会让应用重载 —— 只能等。
    // 等不到就必须失败：以前这里返回 ok:true（busy-skip），消息会落进用户当前那个对话，
    // 随后 adapter 还会把绑定改写成那个对话，等于把手机的消息劫持到别人的会话里。
    if (before.busy) {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        await sleep(800);
        before = await client.evaluate(JS_STATE);
        if (!before.busy) break;
      }
      if (before.busy) return { ok: false, reason: 'desktop-busy', actual: before.conversationId };
      if (before.conversationId === conversationId) return { ok: true, already: true };
    }

    let clicked = await client.evaluate(JS_SELECT_CONV(conversationId));
    if (!clicked?.ok) {
      await client.evaluate(JS_EXPAND);
      await sleep(450);
      clicked = await client.evaluate(JS_SELECT_CONV(conversationId));
    }
    if (!clicked?.ok) {
      // 侧边栏没渲染出这个会话（收起的分组 / 停在首页）：先走 SPA 路由，
      // 避免 location.assign 那种整页重载把应用状态全清掉。
      const path = '/c/' + conversationId;
      await client.evaluate(
        `(history.pushState({}, '', ${JSON.stringify(path)}), window.dispatchEvent(new PopStateEvent('popstate', { state: {} })), true)`
      ).catch(() => {});
      await sleep(1500);
      let routed = await this._stateWithRetry(4000);
      if (routed?.conversationId !== conversationId) {
        // 应用不吃这个 popstate 时才退回整页导航
        await client.evaluate(`location.assign(${JSON.stringify(path)})`).catch(() => {});
        await sleep(2600);
        routed = await this._stateWithRetry(6000);
        if (routed?.conversationId === conversationId) await this._waitComposer(8000);
      }
      if (routed?.conversationId === conversationId) return { ok: true, via: 'route' };
      return { ok: false, reason: clicked?.reason || 'not-in-sidebar' };
    }
    await sleep(900);
    let after = await client.evaluate(JS_STATE);
    if (after.conversationId === conversationId) return { ok: true };

    // SPA 的 DOM click 偶尔不生效，退化为真实鼠标点击
    if (clicked.point) {
      await client.clickAt(clicked.point.x, clicked.point.y);
      await sleep(900);
      after = await client.evaluate(JS_STATE);
      if (after.conversationId === conversationId) return { ok: true, via: 'mouse' };
    }
    return { ok: false, reason: 'switch-not-applied', expected: conversationId, actual: after.conversationId };
  }

  /**
   * 往输入框里写字。
   * Input.insertText 遇到换行只插入第一行（后面的会丢），所以逐行插入、行间用 Shift+Enter。
   */
  async _typeIntoInput(client, text) {
    const lines = String(text).split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (i > 0) {
        await client.pressKey('Enter', 'Enter', 13, 8); // modifiers 8 = Shift
        await sleep(60);
      }
      if (lines[i]) await client.insertText(lines[i]);
    }
  }

  /**
   * 关掉会挡住输入框的弹窗（主要是设置弹窗 —— 我们的面板就开在里面）。
   * 不碰其它 dialog，避免误关用户正在填的东西。
   */
  async _closeBlockingDialogs() {
    // 没连上就别为了关弹窗去连（单测/无窗口时不该触发 CDP）
    if (!this.connected) return { ok: true, skipped: true };
    try {
      const client = await this.ensure();
      const result = await client.evaluate(script(`
        const dlg = document.querySelector('${SEL.settingsDialog}');
        if (!dlg) return { ok: true, hadDialog: false };
        const closeBtn = dlg.querySelector('[aria-label="Close"]');
        if (closeBtn) closeBtn.click();
        else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        return { ok: true, hadDialog: true };
      `));
      if (result?.hadDialog) await sleep(450);
      return result;
    } catch {
      return { ok: false };
    }
  }

  /** 页面正在导航时 evaluate 会失败，这里重试几次。 */
  async _stateWithRetry(timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        return await this.snapshot();
      } catch {
        await sleep(400);
      }
    }
    return null;
  }

  /**
   * 实时读取 Antigravity 可用模型列表与当前选中模型：
   * 1. 优先直接调用本地 LanguageServerService/GetUserStatus + 读取触发器，零闪烁、不弹窗、实时同步；
   * 2. 拿不到时再回退到旧的打开模型菜单读取路径。
   */
  async listModels({ force = false } = {}) {
    const cached = this._modelsCache;
    if (!force && cached && Date.now() - cached.at < 2500) return cached.value;

    try {
      const client = await this.ensure();
      const live = await client.evaluate(JS_LIST_MODELS_LIVE, { awaitPromise: true });
      if (live?.ok && Array.isArray(live.configs) && live.configs.length) {
        const value = normalizeLiveModels(live);
        this._modelsCache = { at: Date.now(), value };
        return value;
      }
    } catch {
      /* 降级到菜单读取，若仍不可达则由下面统一抛出或返回 */
    }

    return this.mutex.run(async () => {
      const client = await this.ensure();
      const opened = await client.evaluate(JS_OPEN_MODEL);
      if (!opened?.ok) return { ok: false, reason: opened?.reason || 'no-model-trigger', current: '', items: [], models: [] };
      await sleep(450);
      let listing;
      try {
        listing = await client.evaluate(JS_MODEL_ITEMS);
      } finally {
        await client.evaluate(JS_CLOSE_MENU).catch(() => {});
      }
      const items = (listing?.items || []).map((item) => item.label).filter(Boolean);
      const current = listing?.current || '';
      const models = items.map((label) => ({
        label,
        base: label,
        effort: extractEffort(label),
        modelId: '',
        quota: null,
        resetTime: '',
        tag: '',
        available: true,
      }));
      const value = {
        ok: true,
        current,
        currentRaw: listing?.currentDisplay || current,
        items,
        models,
        source: 'dom-menu',
        updatedAt: Date.now(),
      };
      this._modelsCache = { at: Date.now(), value };
      return value;
    });
  }

  /** 对外公开的切模型入口（持锁并清缓存）。 */
  async selectModel(label) {
    return this.mutex.run(async () => this._selectModel(label));
  }

  /** 切模型（支持直接点击与带思考强度的二级子菜单）。 */
  async _selectModel(label) {
    this._modelsCache = null;
    const client = await this.ensure();
    const before = await client.evaluate(JS_STATE).catch(() => null);
    if (before?.model && sameModelExact(before.model, label)) {
      return { ok: true, current: before.model, picked: label, unchanged: true };
    }

    const opened = await client.evaluate(JS_OPEN_MODEL);
    if (!opened?.ok) return { ok: false, reason: opened?.reason || 'no-model-trigger' };
    await sleep(380);
    try {
      let listing = await client.evaluate(JS_MODEL_ITEMS);
      let items = listing?.items || [];
      if (!items.length) {
        // 菜单刚打开还没渲染完，等一下再读一次
        await sleep(550);
        listing = await client.evaluate(JS_MODEL_ITEMS);
        items = listing?.items || [];
      }
      const want = modelKey(label);
      const target =
        items.find((item) => modelKey(item.base || item.label) === want) ||
        items.find((item) => modelKey(item.label) === want) ||
        items.find((item) => modelKey(item.base || item.label).startsWith(want));
      if (!target) return { ok: false, reason: 'not-found', available: items.map((i) => i.label) };

      const wantEffort = extractEffort(label);
      let pickedViaSubmenu = false;
      if (target.hasSubmenu && wantEffort) {
        await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y }).catch(() => {});
        const picked = await client.evaluate(JS_PICK_EFFORT(target.base || target.label, wantEffort), { awaitPromise: true });
        pickedViaSubmenu = Boolean(picked?.ok);
      }
      if (!pickedViaSubmenu) {
        await client.clickAt(target.x, target.y);
      }
      await sleep(750);
    } finally {
      await client.evaluate(JS_CLOSE_MENU).catch(() => {});
    }
    this._modelsCache = null;
    const state = await client.evaluate(JS_STATE);
    const ok = extractEffort(label) ? sameModelExact(state.model, label) : sameModel(state.model, label);
    return { ok, current: state.model, picked: label };
  }

  /**
   * 输入框是 Lexical：React 重渲染会把它的内部状态写回 DOM，所以「按过删除键」不等于
   * 「框真的空了」。不确认这一点就接着打字，新字会和被恢复的旧内容拼在一起，
   * 之后的 innerText === text 校验永远对不上（表现为 fill-failed）。
   */
  async _clearAndWait(client, timeoutMs = 2600) {
    for (let round = 0; round < 2; round += 1) {
      for (let i = 0; i < 2; i += 1) {
        await client.pressKey('a', 'KeyA', 65, 2);
        await client.pressKey('Backspace', 'Backspace', 8);
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const state = await client.evaluate(JS_STATE).catch(() => null);
        if (state && !normalize(state.inputText)) return { ok: true };
        await sleep(120);
      }
    }
    const state = await client.evaluate(JS_STATE).catch(() => null);
    return { ok: false, got: normalize(state && state.inputText || '').slice(0, 60) };
  }

  /**
   * Lexical 会丢掉「聚焦后同一拍里」的 insertText：实测 0ms 停顿时 3 次全部落空，
   * 120ms 起就稳定。所以打完清空键之后必须留一个停顿再打字。
   */
  async _focusAndSettle(client, settleMs = 160) {
    await client.evaluate(JS_FOCUS_INPUT).catch(() => null);
    await sleep(settleMs);
  }

  /** 轮询确认文字真的进了框，而不是读一次就下结论。 */
  async _waitForText(client, text, timeoutMs = 1400) {
    const want = normalize(text);
    const deadline = Date.now() + timeoutMs;
    let got = '';
    while (Date.now() < deadline) {
      const state = await client.evaluate(JS_STATE).catch(() => null);
      got = normalize(state && state.inputText || '');
      if (got === want) return { ok: true };
      await sleep(100);
    }
    return { ok: false, got: got.slice(0, 60) };
  }

  /** 填字并发送。必须在 mutex 内调用。 */
  async _submit(text) {
    const client = await this.ensure();

    // 路径 A：JS 聚焦输入框 + CDP 打字 + JS 点发送。
    // 不依赖鼠标命中测试，所以设置弹窗盖住输入框时也能发，不会打断用户。
    const focused = await client.evaluate(JS_FOCUS_INPUT).catch(() => null);
    if (focused?.ok && (await this._clearAndWait(client)).ok) {
      await this._focusAndSettle(client);
      await this._typeIntoInput(client, text);
      if ((await this._waitForText(client, text)).ok) {
        const clicked = await client.evaluate(JS_CLICK_SEND);
        if (clicked?.ok) {
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            await sleep(200);
            const after = await client.evaluate(JS_STATE);
            if (!normalize(after.inputText)) return { ok: true, via: 'js' };
          }
          return { ok: false, reason: 'send-not-applied' };
        }
      }
    }

    // 路径 B：鼠标点输入框（JS 路径被拒时的兜底）——这时才需要把挡路的弹窗关掉
    await this._closeBlockingDialogs();
    let point = await client.evaluate(JS_INPUT_POINT);
    if (!point?.ok) {
      // 刚切会话/刚关弹窗时输入框可能还没挂上，等一会儿再试
      await this._waitComposer(4000);
      point = await client.evaluate(JS_INPUT_POINT);
    }
    if (!point?.ok) return { ok: false, reason: point?.reason || 'no-input' };
    await client.clickAt(point.x, point.y);
    const cleared = await this._clearAndWait(client);
    if (!cleared.ok) {
      // 框里清不掉的东西多半是用户自己的草稿：继续打字会把它一起发出去，宁可停下来问。
      return { ok: false, reason: 'composer-busy', got: cleared.got };
    }
    await sleep(160);
    await this._typeIntoInput(client, text);
    let typed = await this._waitForText(client, text);

    if (!typed.ok) {
      // 兜底：页面内 execCommand（同样遵守「先停顿再打字」）
      await client.evaluate(script(`
        const input = first('${SEL.input}');
        if (!input) return { ok: false };
        input.click(); input.focus();
        const range = document.createRange(); range.selectNodeContents(input);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        document.execCommand('delete', false, null);
        document.execCommand('insertText', false, ${JSON.stringify(text)});
        return { ok: true };
      `));
      typed = await this._waitForText(client, text);
    }
    if (!typed.ok) {
      // 兜底二连：重新点一次输入框（弹窗刚关/焦点丢失时第一次会落空）
      const again = await client.evaluate(JS_INPUT_POINT);
      if (again?.ok) {
        await client.clickAt(again.x, again.y);
        if ((await this._clearAndWait(client)).ok) {
          await sleep(160);
          await this._typeIntoInput(client, text);
          typed = await this._waitForText(client, text);
        }
      }
      if (!typed.ok) return { ok: false, reason: 'fill-failed', got: typed.got };
    }

    const clicked = await client.evaluate(JS_CLICK_SEND);
    if (!clicked?.ok) {
      if (clicked?.reason === 'disabled') await client.pressKey('Enter', 'Enter', 13);
      else return { ok: false, reason: clicked?.reason || 'send-failed' };
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await sleep(200);
      const after = await client.evaluate(JS_STATE);
      if (!normalize(after.inputText)) return { ok: true };
    }
    return { ok: false, reason: 'send-not-applied' };
  }

  /**
   * 对外唯一入口：切会话 + 切模型 + 填字发送，全程持锁但临界区很短。
   */
  async sendPrompt({ conversationId, text, model = '' }) {
    return this.mutex.run(async () => {
      try {
        await this.ensureReady();
      } catch (error) {
        return { ok: false, stage: 'connect', reason: error?.message || String(error) };
      }

      const switched = conversationId ? await this._switchTo(conversationId) : { ok: true };
      if (!switched.ok) return { ok: false, stage: 'switch', ...switched };

      // 切完会话界面可能还在渲染，先等输入区就绪，否则读到的模型是空的。
      // 只在已连接时等（单测里没有浏览器，别去连）
      if (this.connected) await this._waitComposer(6000);

      let modelResult = { ok: true, skipped: true };
      let modelWarning = '';
      if (model) {
        const state = await this.snapshot();
        // 读不到当前模型（界面还没渲染完）就别硬切，静默跳过，免得误报
        if (!state.model) {
          modelResult = { ok: true, skipped: true, reason: 'model-unknown' };
        } else if (!sameModelExact(state.model, model)) {
          modelResult = await this._selectModel(model);
        }
        if (!modelResult.ok) {
          // 切不过去不该让整条消息失败：用当前模型继续，但如实告诉用户
          const actual = (await this.snapshot()).model || '当前模型';
          modelWarning = `⚠️ 没能切到模型「${model}」，本次用的是「${actual}」`;
        }
      }

      const submitted = await this._submit(text);
      if (!submitted.ok) return { ok: false, stage: 'submit', ...submitted };
      const after = await this.snapshot();
      return {
        ok: true,
        conversationId: after.conversationId,
        model: after.model,
        modelWarning,
        switched: Boolean(conversationId),
        via: submitted.via || 'mouse',
      };
    });
  }

  async stopGeneration() {
    return this.mutex.run(async () => {
      const client = await this.ensure();
      return client.evaluate(JS_CLICK_CANCEL);
    });
  }

  async clickApproval(text, index = 0) {
    return this.mutex.run(async () => {
      const client = await this.ensure();
      return client.evaluate(JS_CLICK_APPROVAL(text, index));
    });
  }

  async newConversation({ model = '' } = {}) {
    return this.mutex.run(async () => {
      const client = await this.ensure();
      const clicked = await client.evaluate(script(`
        const btn = first('${SEL.newConversation}');
        if (!btn) return { ok: false, reason: 'no-button' };
        btn.click();
        return { ok: true };
      `));
      if (!clicked?.ok) return clicked;
      await this._waitComposer(6000);
      let modelResult = { ok: true, skipped: true };
      if (model) {
        modelResult = await this._selectModel(model);
        await sleep(600);
        const state = await this.snapshot();
        if (!sameModelExact(state.model, model)) modelResult = await this._selectModel(model);
      }
      const state = await this.snapshot();
      return { ok: true, conversationId: state.conversationId, model: state.model, modelOk: modelResult.ok !== false };
    });
  }

  async _waitComposer(timeout = 6000) {
    const client = await this.ensure();
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const state = await client.evaluate(JS_STATE);
      if (state.hasInput && state.model !== undefined) {
        const hasTrigger = await client.evaluate(script(`return { ok: true, has: Boolean(first('${SEL.modelTrigger}')) };`));
        if (hasTrigger?.has) return true;
      }
      await sleep(300);
    }
    return false;
  }

  close() {
    this.client?.close();
    this.client = null;
  }
}

// ---------------------------------------------------------------- 模型名比较与归一化

const EFFORT_ALIAS = {
  minimal: 'minimal',
  极低: 'minimal',
  low: 'low',
  低: 'low',
  medium: 'medium',
  中: 'medium',
  high: 'high',
  高: 'high',
  xhigh: 'xhigh',
  极高: 'xhigh',
};

export function extractEffort(text) {
  const cleaned = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\s*(New|Notice|Beta|Preview|Unavailable)\s*$/i, '')
    .trim();
  const paren = cleaned.match(/\((minimal|low|medium|xhigh|high)\)\s*$/i);
  if (paren) return EFFORT_ALIAS[paren[1].toLowerCase()] || '';
  const tail = cleaned.match(/(?:^|\s)(极低|极高|低|中|高|minimal|low|medium|xhigh|high)\s*$/i);
  if (tail) return EFFORT_ALIAS[tail[1].toLowerCase()] || '';
  return '';
}

export function modelBaseName(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\s*(New|Notice|Beta|Preview|Unavailable)\s*$/i, '')
    .replace(/\s*\((?:minimal|low|medium|xhigh|high)\)\s*$/i, '')
    .replace(/\s*(极低|极高|低|中|高|minimal|low|medium|xhigh|high)\s*$/i, '')
    .trim();
}

export function modelKey(text) {
  return modelBaseName(text).toLowerCase();
}

export function sameModel(current, expected) {
  const left = modelKey(current);
  const right = modelKey(expected);
  if (!left || !right) return false;
  return left === right || left.startsWith(right) || right.startsWith(left);
}

export function sameModelExact(current, expected) {
  if (!sameModel(current, expected)) return false;
  const wantEffort = extractEffort(expected);
  if (!wantEffort) return true;
  const gotEffort = extractEffort(current);
  return !gotEffort || gotEffort === wantEffort;
}

export function normalizeLiveModels(live) {
  const rawConfigs = Array.isArray(live?.configs) ? live.configs : [];
  const orderList = [];
  for (const sortGroup of live?.sorts || []) {
    for (const grp of sortGroup?.groups || []) {
      for (const lbl of grp?.modelLabels || []) orderList.push(lbl);
    }
  }
  const byLabel = new Map();
  for (const cfg of rawConfigs) {
    if (cfg?.label && !byLabel.has(cfg.label)) byLabel.set(cfg.label, cfg);
  }
  const ordered = [];
  const seen = new Set();
  for (const lbl of orderList) {
    const cfg = byLabel.get(lbl);
    if (cfg && !seen.has(cfg.label)) {
      seen.add(cfg.label);
      ordered.push(cfg);
    }
  }
  for (const cfg of rawConfigs) {
    if (cfg?.label && !seen.has(cfg.label)) {
      seen.add(cfg.label);
      ordered.push(cfg);
    }
  }

  const available = ordered.filter(
    (cfg) => !cfg.disabled && String(cfg.tagTitle || '').toLowerCase() !== 'unavailable',
  );
  const models = available.map((cfg) => ({
    label: cfg.label,
    base: modelBaseName(cfg.label),
    effort: extractEffort(cfg.label),
    modelId: cfg.modelId || '',
    model: cfg.model || '',
    quota: typeof cfg.quota === 'number' ? Math.max(0, Math.min(1, cfg.quota)) : null,
    resetTime: cfg.resetTime || '',
    tag: cfg.tagTitle || '',
    available: true,
  }));

  const currentRaw = String(live?.currentRaw || live?.currentDisplay || '').trim();
  const matched =
    models.find((m) => sameModelExact(currentRaw, m.label)) ||
    models.find((m) => sameModel(currentRaw, m.label));
  const current = matched ? matched.label : currentRaw;

  return {
    ok: true,
    current,
    currentRaw: String(live?.currentDisplay || currentRaw || current),
    items: models.map((m) => m.label),
    models,
    source: 'language-server',
    updatedAt: Date.now(),
  };
}

function normalize(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

export const __test__ = { script, PRELUDE, JS_STATE, normalize };
