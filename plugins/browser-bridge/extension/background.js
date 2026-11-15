/**
 * background.js —— MV3 service worker。
 * 职责：维护到本地 MCP 服务的 WebSocket 长连接；接收工具调用；用 CDP 或页面脚本执行动作。
 */
import * as Cdp from "./cdp.js";
import * as Banner from "./banner.js";

const DEFAULT_SETTINGS = {
  port: 8767,
  token: "",
  autoConnect: true,
  searchEngine: "https://www.bing.com/search?q=",
};
const WS_PATH = "/bridge";
const PA_FILE = "page-actions.js";
const CURSOR_FILE = "cursor-page.js";
const RECORDER_FILE = "recorder-page.js";
const REC_ACTIVE_KEY = "ag:recordingSession";
const REC_LAST_KEY = "ag:lastCompletedRecording";
const MAX_LOG_ENTRIES = 400;
const KEEPALIVE_ALARM = "ag-keepalive";

let settings = Object.assign({}, DEFAULT_SETTINGS);
let ws = null;
let wsState = "disconnected"; // disconnected | connecting | connected
let reconnectDelay = 800;
let reconnectTimer = null;
let lastError = "";
let lastConnectedAt = 0;
let bannerTabId = null; // 当前正在控制的标签页（原生调试提示条由 CDP 附加触发）
const bannerTabs = new Set(); // 控制过的标签页，断开时统一清理鼠标/旧顶栏/原生调试条
const legacyBannerCleared = new Set(); // 已清除旧版页面顶栏的标签页
let recordingSession = null; // 当前正在进行的 RPA 录制会话
let lastCompletedRecording = null; // 最近一次完成的 RPA 录制会话（供弹窗停止后由 MCP 拉取）

const logs = new Map(); // tabId -> { console: [], network: [] }

/* ------------------------------------------------------------------ 基础工具 */

function detectBrowser() {
  const ua = navigator.userAgent || "";
  if (/Edg\//.test(ua)) return "edge";
  if (/OPR\//.test(ua)) return "opera";
  if (/Chrome\//.test(ua)) return "chrome";
  return "chromium";
}

function normalizeUrl(input) {
  const s = String(input == null ? "" : input).trim();
  if (!s) return "about:blank";
  if (/^(https?|file|data|about|edge|chrome|chrome-extension|view-source|ftp|ws|wss):/i.test(s)) return s;
  if (/^localhost(:\d+)?(\/|$|\?)/i.test(s) || /^127\.0\.0\.1(:\d+)?(\/|$|\?)/.test(s)) return "http://" + s;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$|\?)/.test(s) && !/\s/.test(s)) return "https://" + s;
  return settings.searchEngine + encodeURIComponent(s);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getTab(args = {}, { preferLease = false } = {}) {
  if (args.tabId != null) {
    try {
      return await chrome.tabs.get(Number(args.tabId));
    } catch (e) {
      throw new Error("找不到 tabId=" + args.tabId + " 的标签页：" + ((e && e.message) || e));
    }
  }
  if (preferLease) {
    const leased = await getLeaseTab();
    if (leased) return leased;
  }
  const active = await getActiveTab();
  if (active) return active;
  throw new Error("当前没有可操作的标签页");
}

async function getActiveTab() {
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs.length) tabs = await chrome.tabs.query({ active: true });
  if (!tabs.length) tabs = await chrome.tabs.query({});
  return tabs[0] || null;
}

/* ---------------- 专属控制标签页（Tab Lease） ---------------- */

const LEASE_KEY = "ag:leaseTabId";
let leaseTabId = null;
let leaseWindowId = null;
let leaseCreating = null;

async function loadLeaseId() {
  try {
    const data = await chrome.storage.local.get(LEASE_KEY);
    const stored = data && data[LEASE_KEY];
    if (stored && typeof stored === "object") {
      const tabId = Number(stored.tabId);
      const windowId = Number(stored.windowId);
      if (Number.isInteger(tabId) && tabId > 0) leaseTabId = tabId;
      if (Number.isInteger(windowId) && windowId > 0) leaseWindowId = windowId;
    } else {
      const legacy = Number(stored);
      if (Number.isInteger(legacy) && legacy > 0) leaseTabId = legacy;
    }
  } catch (e) { /* storage 不可用时退回内存态 */ }
}
const leaseReady = loadLeaseId();

async function persistLease(id, windowId = null) {
  leaseTabId = Number.isInteger(Number(id)) && Number(id) > 0 ? Number(id) : null;
  leaseWindowId = leaseTabId && Number.isInteger(Number(windowId)) && Number(windowId) > 0
    ? Number(windowId)
    : null;
  try {
    if (leaseTabId == null) await chrome.storage.local.remove(LEASE_KEY);
    else await chrome.storage.local.set({ [LEASE_KEY]: { tabId: leaseTabId, windowId: leaseWindowId } });
  } catch (e) { /* 持久化只用于扩展重载后复用 */ }
}

async function getLeaseTab() {
  await leaseReady;
  if (leaseTabId == null) return null;
  try {
    const tab = await chrome.tabs.get(leaseTabId);
    leaseWindowId = tab.windowId;
    return tab;
  } catch (e) {
    await persistLease(null);
    return null;
  }
}

const LEASE_GROUP_TITLE = "谷谷嘎嘎控制中";
let leaseGroupId = null;

async function ensureLeaseGroup(tabId) {
  try {
    if (!chrome.tabs.group || !chrome.tabGroups) return;
    const tab = await chrome.tabs.get(Number(tabId));
    let groupId = tab.groupId;
    if (groupId == null || groupId === -1) {
      let target = null;
      if (leaseGroupId != null) {
        try {
          const group = await chrome.tabGroups.get(leaseGroupId);
          if (group && group.windowId === tab.windowId) target = leaseGroupId;
        } catch (e) { /* old group disappeared */ }
      }
      groupId = target != null
        ? await chrome.tabs.group({ groupId: target, tabIds: [tab.id] })
        // createProperties.windowId is required: without it chrome.tabs.group
        // creates the group in the last-focused window and MOVES this tab out of
        // the dedicated background window (which then closes empty), defeating
        // the non-intrusive design and leaving the tab inactive (no screenshot).
        : await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
    }
    await chrome.tabGroups.update(groupId, {
      title: LEASE_GROUP_TITLE,
      color: "purple",
      collapsed: false,
    });
    leaseGroupId = groupId;
  } catch (e) {
    /* tab grouping is a visual marker; never block control */
  }
}

async function ensureLeaseTab(url = "about:blank") {
  const existing = await getLeaseTab();
  if (existing) {
    await ensureLeaseGroup(existing.id);
    return existing;
  }
  if (leaseCreating) return leaseCreating;
  leaseCreating = (async () => {
    // Dedicated non-focused window: the lease tab is active inside it (real
    // screenshot surface) while the user's focused window/tab stay untouched.
    const win = await chrome.windows.create({ url, focused: false, type: "normal" });
    const created = win && win.tabs && win.tabs[0];
    if (!created) throw new Error("无法创建代理后台窗口");
    await persistLease(created.id, win.id);
    await ensureLeaseGroup(created.id);
    return chrome.tabs.get(created.id);
  })().finally(() => { leaseCreating = null; });
  return leaseCreating;
}

/**
 * 控制动作开始前，记录用户正在使用的窗口（排除代理后台窗口）。
 * chrome.tabs.create({ active: true }) 在部分 Chrome/Windows 组合下会把目标
 * 窗口一起前置、抢走用户焦点，所以要能在动作结束后把焦点还回去。
 */
async function focusedUserWindowId(excludeWindowId) {
  try {
    const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
    const w = wins.find((x) => x.focused && x.id !== excludeWindowId);
    return w ? w.id : null;
  } catch (e) {
    return null;
  }
}

/** 仅当代理窗口真的抢到焦点时才恢复，避免多余的窗口操作（标签在后台窗口内仍 active，截图 surface 不受影响）。 */
async function restoreUserFocus(userWindowId, leaseWindowId) {
  if (userWindowId == null) return;
  try {
    const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
    const now = wins.find((x) => x.focused);
    if (!now || now.id === userWindowId) return;
    // 焦点是被别的应用/窗口拿走时不强行抢回，只有代理窗口自己抢走才恢复。
    if (leaseWindowId != null && now.id !== leaseWindowId) return;
    await chrome.windows.update(userWindowId, { focused: true });
  } catch (e) {
    /* 焦点恢复是尽力而为，失败不阻断控制；下一次动作会再试 */
  }
}

async function createLeaseTab(url = "about:blank") {
  const lease = await getLeaseTab();
  if (!lease) return ensureLeaseTab(url);
  const userWindowId = await focusedUserWindowId(lease.windowId);
  // 先以 active:false 建标签，再在后台窗口内 update 激活：既保证 CDP 截图所需
  // 的窗口内 active surface，又避开 tabs.create({active:true}) 的前置窗口行为。
  const tab = await chrome.tabs.create({
    windowId: lease.windowId,
    url,
    active: false,
  });
  await chrome.tabs.update(tab.id, { active: true });
  await persistLease(tab.id, tab.windowId);
  await ensureLeaseGroup(tab.id);
  // 兜底：某些平台仍可能把后台窗口前置，把焦点还给用户窗口。
  await restoreUserFocus(userWindowId, lease.windowId);
  return tab;
}

async function controlTabFor(args = {}) {
  if (args.tabId != null) return getTab(args);
  return ensureLeaseTab();
}

/**
 * 控制类工具取标签页时确保浏览器原生调试提示条出现。
 *
 * Chrome / Edge 只有在 chrome.debugger 附加到标签页时才会显示标准提示条；
 * 页面脚本动作本身不触发它。因此这里主动附加 CDP，让原生提示条在第一次
 * 控制动作就出现，而不是额外绘制一条页面顶栏。
 */
async function ensureNativeControlBar(tabId) {
  try {
    await Cdp.attach(Number(tabId));
  } catch (e) {
    /* 受保护页面 / DevTools 已打开时无法附加；页面动作仍可继续 */
  }
  if (!legacyBannerCleared.has(Number(tabId))) {
    legacyBannerCleared.add(Number(tabId));
    try { await Banner.hide(Number(tabId)); } catch (e) { /* 清理旧版顶栏，失败不影响控制 */ }
  }
}

/**
 * 控制类工具取标签页时点亮浏览器原生调试提示条与页面鼠标。
 * 原生提示条附加失败（受保护页面、标签页已关闭等）不会抛出。
 */
async function getControlTab(args = {}) {
  const tab = await controlTabFor(args);
  await setControlTab(tab.id);
  await showCursorCenter(tab.id, "control");
  return tab;
}

/** 记录当前被控制的标签页：换标签时撤掉上一个的鼠标/旧顶栏/原生提示条 */
async function setControlTab(tabId) {
  const id = Number(tabId);
  if (!Number.isFinite(id)) return;
  const previous = bannerTabId;
  if (previous != null && previous !== id) {
    bannerTabId = null;
    Banner.hide(previous).catch(() => {});
    hideCursor(previous).catch(() => {});
    Cdp.detach(previous).catch(() => {});
  }
  bannerTabId = id;
  bannerTabs.add(id);
  if (id === leaseTabId) await ensureLeaseGroup(id);
  await ensureNativeControlBar(id);
}

/** 断开连接 / 手动重连时撤掉所有鼠标、旧顶栏与原生调试提示条 */
async function clearControlBanner() {
  const ids = Array.from(bannerTabs);
  if (bannerTabId != null) ids.push(bannerTabId);
  bannerTabs.clear();
  legacyBannerCleared.clear();
  bannerTabId = null;
  const unique = Array.from(new Set(ids));
  await Promise.all(unique.map((id) => Banner.hide(id).catch(() => false)));
  await Promise.all(unique.map((id) => hideCursor(id).catch(() => false)));
  await Promise.all(unique.map((id) => Cdp.detach(id).catch(() => false)));
}

async function waitComplete(tabId, timeoutMs = 15000) {
  const started = Date.now();
  for (;;) {
    let t = null;
    try { t = await chrome.tabs.get(tabId); } catch (e) { return null; }
    if (t.status === "complete" || Date.now() - started >= timeoutMs) return t;
    await sleep(150);
  }
}

/** 调用页面动作模块；只在模块缺失（首次受控或页面刚刷新）时才注入文件 */
async function pa(tabId, method, args) {
  const target = { tabId: Number(tabId) };
  const call = () => chrome.scripting.executeScript({
    target,
    world: "ISOLATED",
    func: (m, a) => {
      const mod = globalThis.__AG_PA;
      if (!mod || typeof mod[m] !== "function") return { __AG_PA_MISSING__: true };
      return mod[m](a);
    },
    args: [method, args || {}],
  });
  const inject = async () => {
    try {
      await chrome.scripting.executeScript({ target, files: [CURSOR_FILE, PA_FILE], world: "ISOLATED" });
      return true;
    } catch (e) {
      return false;
    }
  };
  const unwrap = (results) => (results && results[0] ? results[0].result : null);

  let results;
  try {
    results = await call();
  } catch (e) {
    if (!(await inject())) {
      throw new Error(
        "无法在页面注入脚本（" + ((e && e.message) || e) + "）。受保护页面（edge://、chrome://、扩展商店、内置 PDF 阅读器、新标签页）不支持页面动作，请先 browser_open 到一个普通网页。"
      );
    }
    results = await call();
  }
  let r = unwrap(results);
  if (r && r.__AG_PA_MISSING__) {
    if (!(await inject())) return { ok: false, error: "页面动作模块未就绪" };
    r = unwrap(await call());
    if (r && r.__AG_PA_MISSING__) return { ok: false, error: "页面动作模块未就绪" };
  }
  if (r === null || r === undefined) throw new Error("页面动作没有返回结果（方法 " + method + "）");
  return r;
}

/* 无进展熔断：同一动作连续两次没有改变页面，第三次直接拒绝，
 * 避免弹窗阻塞或点击失效时反复空转。只覆盖会产生副作用的工具。 */
const GUARDED_TOOLS = new Set([
  "browser_open", "browser_history", "browser_click", "browser_type",
  "browser_press", "browser_scroll", "browser_select_option",
]);
let progressGuard = { key: "", noProgress: 0 };

function guardKey(tool, args) {
  try { return tool + "|" + JSON.stringify(args || {}); } catch (e) { return tool + "|"; }
}

async function pageSignature(tabId) {
  try {
    const r = await pa(tabId, "signature", {});
    if (r && r.ok && r.signature) return r.signature;
  } catch (e) { /* 受保护页面：退回标签页级签名 */ }
  try {
    const tab = await chrome.tabs.get(Number(tabId));
    return [tab.url, tab.title, tab.status].join("|");
  } catch (e) {
    return "";
  }
}

async function guardBefore(tool, args) {
  if (!GUARDED_TOOLS.has(tool)) return null;
  const tab = await controlTabFor(args);
  const key = guardKey(tool, args);
  if (progressGuard.key === key && progressGuard.noProgress >= 2) {
    const detail = "同一动作已连续 2 次没有改变页面，第 3 次已熔断。" +
      "常见原因：弹窗/系统对话框阻塞、目标被遮挡、权限隔离，或页面状态本来就不需要再操作。请先 browser_snapshot 查看当前页面，必要时人工介入。";
    progressGuard = { key: "", noProgress: 0 };
    return {
      ok: false,
      blocked: "no-progress",
      error: detail,
      guard: { tool: tool, noProgress: 3, tabId: tab.id },
    };
  }
  return { key: key, tabId: tab.id, before: await pageSignature(tab.id) };
}

async function guardAfter(ctx) {
  if (!ctx || !ctx.key) return;
  const after = await pageSignature(ctx.tabId);
  if (ctx.key === progressGuard.key) {
    progressGuard.noProgress = after === ctx.before ? progressGuard.noProgress + 1 : 0;
  } else {
    progressGuard.key = ctx.key;
    progressGuard.noProgress = after === ctx.before ? 1 : 0;
  }
}

async function showCursor(tabId, args) {
  try {
    await pa(tabId, "cursorPoint", Object.assign({}, args, { persistent: true }));
  } catch (e) {
    /* 鼠标视觉不能影响控制流程 */
  }
}

async function showCursorCenter(tabId, action) {
  try {
    await pa(tabId, "cursorCenter", { action: action || "control", persistent: true });
  } catch (e) {
    /* 受保护页面 / 注入失败时忽略 */
  }
}

async function hideCursor(tabId) {
  try {
    await pa(tabId, "cursorHide", {});
  } catch (e) {
    /* 受保护页面 / 注入失败时忽略 */
  }
}

function bufferFor(tabId) {
  const id = Number(tabId);
  if (!logs.has(id)) logs.set(id, { console: [], network: [] });
  return logs.get(id);
}

function trim(arr) {
  if (arr.length > MAX_LOG_ENTRIES) arr.splice(0, arr.length - MAX_LOG_ENTRIES);
}

/* ------------------------------------------------------------------ 连接管理 */

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (!settings.autoConnect) return;
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(Math.round(reconnectDelay * 1.7), 30000);
}

function sendRaw(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }
  return false;
}

function connect() {
  clearTimeout(reconnectTimer);
  if (!settings.autoConnect) { wsState = "disconnected"; refreshBadge(); return; }
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

  wsState = "connecting";
  refreshBadge();

  let sock;
  try {
    sock = new WebSocket("ws://127.0.0.1:" + settings.port + WS_PATH);
  } catch (e) {
    lastError = "WebSocket 创建失败：" + ((e && e.message) || e);
    wsState = "disconnected";
    scheduleReconnect();
    return;
  }
  ws = sock;

  sock.onopen = () => {
    wsState = "connected";
    reconnectDelay = 800;
    lastError = "";
    lastConnectedAt = Date.now();
    sendRaw({
      t: "hello",
      browser: detectBrowser(),
      version: chrome.runtime.getManifest().version,
      id: chrome.runtime.id,
      features: ["record", "recordReplay"],
      token: settings.token || undefined,
      ua: navigator.userAgent,
    });
    refreshBadge();
  };

  sock.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    handleServerMessage(msg);
  };

  sock.onclose = () => {
    if (ws === sock) { ws = null; wsState = "disconnected"; }
    lastError = lastError || "与本地 MCP 服务的连接已断开";
    clearControlBanner();
    refreshBadge();
    scheduleReconnect();
  };

  sock.onerror = () => {
    lastError = "无法连接 ws://127.0.0.1:" + settings.port + "（MCP 服务未启动？）";
    refreshBadge();
  };
}

async function handleServerMessage(msg) {
  if (!msg || !msg.t) return;
  if (msg.t === "ping") { sendRaw({ t: "pong", at: Date.now() }); return; }
  if (msg.t === "welcome") { lastError = ""; refreshBadge(); return; }
  if (msg.t === "error") { lastError = "服务端拒绝：" + msg.message; refreshBadge(); return; }
  if (msg.t === "req") {
    const { id, tool, args } = msg;
    const handler = HANDLERS[tool];
    if (!handler) { sendRaw({ t: "res", id, ok: false, error: "扩展不认识这个工具：" + tool }); return; }
    let guard = null;
    try {
      guard = await guardBefore(tool, args || {});
      if (guard && guard.blocked) {
        sendRaw({ t: "res", id, ok: true, result: guard });
        return;
      }
      const result = await handler(args || {});
      if (guard) await guardAfter(guard);
      sendRaw({ t: "res", id, ok: true, result });
    } catch (e) {
      sendRaw({ t: "res", id, ok: false, error: (e && e.message) || String(e) });
    }
  }
}

function refreshBadge() {
  const isRec = !!(recordingSession && recordingSession.active);
  const text = isRec ? "REC" : (wsState === "connected" ? "ON" : "");
  const color = isRec ? "#d93025" : "#1e8e3e";
  try {
    const p = chrome.action.setBadgeText({ text });
    if (p && p.catch) p.catch(() => {});
    const p2 = chrome.action.setBadgeBackgroundColor({ color });
    if (p2 && p2.catch) p2.catch(() => {});
  } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------------ RPA 录制管理 */

async function loadRecordingState() {
  try {
    const data = await chrome.storage.local.get([REC_ACTIVE_KEY, REC_LAST_KEY]);
    if (data && data[REC_ACTIVE_KEY] && data[REC_ACTIVE_KEY].active) {
      recordingSession = data[REC_ACTIVE_KEY];
    }
    if (data && data[REC_LAST_KEY]) {
      lastCompletedRecording = data[REC_LAST_KEY];
    }
  } catch (e) { /* ignore */ }
}
const recordingReady = loadRecordingState();

async function persistRecordingState() {
  try {
    await chrome.storage.local.set({
      [REC_ACTIVE_KEY]: recordingSession || null,
      [REC_LAST_KEY]: lastCompletedRecording || null,
    });
  } catch (e) { /* ignore */ }
}

async function injectRecorder(tabId, opts = {}) {
  const target = { tabId: Number(tabId) };
  try {
    await chrome.scripting.executeScript({ target, files: [RECORDER_FILE], world: "ISOLATED" });
    const res = await chrome.scripting.executeScript({
      target,
      world: "ISOLATED",
      func: (o) => {
        const rec = globalThis.__AGBB_RECORDER;
        if (!rec || typeof rec.start !== "function") return { ok: false, error: "录制模块未就绪" };
        return rec.start(o || {});
      },
      args: [opts],
    });
    return (res && res[0] && res[0].result) || { ok: false, error: "录制模块未返回状态" };
  } catch (e) {
    return {
      ok: false,
      error: "无法在当前页面注入录制器（" + ((e && e.message) || e) + "）。受保护页面（edge://、chrome://、新标签页等）不支持录制，请先打开一个普通网页。",
    };
  }
}

async function stopRecorderOnTab(tabId) {
  const target = { tabId: Number(tabId) };
  try {
    await chrome.scripting.executeScript({
      target,
      world: "ISOLATED",
      func: () => {
        const rec = globalThis.__AGBB_RECORDER;
        if (rec && typeof rec.stop === "function") return rec.stop();
        const host = document.getElementById("agbb-recorder-hud-host");
        if (host && host.parentNode) host.parentNode.removeChild(host);
        return { ok: true };
      },
    });
  } catch (e) { /* 标签页已关闭或受保护页面 */ }
}

async function startRecordingSession(args = {}) {
  await recordingReady;
  if (recordingSession && recordingSession.active) {
    for (const tid of (recordingSession.tabIds || [])) {
      await stopRecorderOnTab(tid);
    }
  }

  let tab = null;
  if (args.tabId != null) {
    tab = await getTab({ tabId: args.tabId });
  } else if (args.newTab) {
    const url = normalizeUrl(args.url || "about:blank");
    tab = await chrome.tabs.create({ url, active: true });
    await waitComplete(tab.id, 15000);
    tab = await chrome.tabs.get(tab.id);
  } else {
    tab = await getActiveTab();
    if (!tab) throw new Error("当前没有可录制的标签页");
  }

  if (args.url && !args.newTab) {
    const targetUrl = normalizeUrl(args.url);
    await chrome.tabs.update(tab.id, { url: targetUrl, active: true });
    await waitComplete(tab.id, 15000);
    tab = await chrome.tabs.get(tab.id);
  } else {
    try { await chrome.tabs.update(tab.id, { active: true }); } catch (e) { /* ignore */ }
  }

  const now = Date.now();
  const recordingId = "rec-" + now.toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  const initialSteps = [];
  if (tab.url && !/^(about:blank|edge:\/\/|chrome:\/\/)/i.test(tab.url)) {
    initialSteps.push({
      index: 1,
      type: "navigate",
      url: tab.url,
      pageTitle: tab.title || "",
      tabId: tab.id,
      at: now,
    });
  }

  recordingSession = {
    recordingId,
    title: args.title || tab.title || "浏览器操作录制",
    active: true,
    paused: false,
    startedAt: new Date(now).toISOString(),
    browser: detectBrowser(),
    initialUrl: tab.url || "",
    initialTitle: tab.title || "",
    tabIds: [tab.id],
    steps: initialSteps,
  };

  await persistRecordingState();
  refreshBadge();

  const injected = await injectRecorder(tab.id, {
    sessionId: recordingId,
    stepCount: recordingSession.steps.length,
    paused: false,
    lastSummary: tab.url ? ("已就绪: " + (tab.title || tab.url)) : "等待操作…",
  });

  return {
    ok: true,
    status: "recording",
    recordingId,
    title: recordingSession.title,
    tabId: tab.id,
    url: tab.url,
    pageTitle: tab.title,
    hudInjected: !!(injected && injected.ok),
    hudNote: injected && !injected.ok ? injected.error : undefined,
    stepCount: recordingSession.steps.length,
    message: "RPA 录制已开启。请在浏览器中正常演示操作，右下角悬浮录制胶囊可随时添加「💬 备注规则」、开启「🎯 标记提取」或点击「⏹ 完成」。",
  };
}

async function stopRecordingSession(args = {}) {
  await recordingReady;
  if (recordingSession && recordingSession.active) {
    const tids = Array.from(new Set(recordingSession.tabIds || []));
    await Promise.all(tids.map((id) => stopRecorderOnTab(id)));
    recordingSession.active = false;
    recordingSession.paused = false;
    recordingSession.stoppedAt = new Date().toISOString();
    if (args.title) recordingSession.title = args.title;
    lastCompletedRecording = Object.assign({}, recordingSession);
    recordingSession = null;
    await persistRecordingState();
    refreshBadge();
    return {
      ok: true,
      status: "stopped",
      recording: lastCompletedRecording,
    };
  }
  if (lastCompletedRecording) {
    if (args.title) lastCompletedRecording.title = args.title;
    return {
      ok: true,
      status: "already_stopped",
      note: "录制此前已在页面悬浮胶囊或扩展弹窗中完成，直接返回最近一次完成的录制数据。",
      recording: lastCompletedRecording,
    };
  }
  return {
    ok: false,
    error: "当前没有正在进行或已完成的录制记录。请先调用 browser_record_start 开启录制，或在浏览器扩展弹窗中点击「开始录制」。",
  };
}

/* ------------------------------------------------------------------ 工具实现 */

const HANDLERS = {

  async browser_status() {
    let tabs = [];
    try { tabs = await chrome.tabs.query({}); } catch (e) { /* ignore */ }
    let active = null;
    try {
      const t = await getActiveTab();
      if (t) active = { id: t.id, title: t.title, url: t.url, windowId: t.windowId };
    } catch (e) { /* ignore */ }
    let leased = null;
    let leaseWindow = null;
    let leaseGroup = null;
    try {
      const t = await getLeaseTab();
      if (t) {
        leased = {
          id: t.id, title: t.title, url: t.url, active: t.active,
          windowId: t.windowId, groupId: t.groupId == null ? -1 : t.groupId,
        };
        try {
          const w = await chrome.windows.get(t.windowId);
          leaseWindow = { id: w.id, focused: w.focused, state: w.state, left: w.left, top: w.top, width: w.width, height: w.height };
        } catch (e) { /* ignore */ }
        try {
          if (chrome.tabGroups && leased.groupId !== -1) {
            const g = await chrome.tabGroups.get(leased.groupId);
            leaseGroup = { id: g.id, title: g.title, color: g.color, collapsed: g.collapsed, windowId: g.windowId };
          }
        } catch (e) { /* group may have been removed */ }
      }
    } catch (e) { /* ignore */ }
    let leaseCursor = null;
    if (leased) {
      try {
        const cursor = await pa(leased.id, "cursorState", {});
        if (cursor && cursor.ok) leaseCursor = cursor;
      } catch (e) { /* 受保护页面没有鼠标层 */ }
    }
    return {
      ok: true,
      browser: detectBrowser(),
      extensionVersion: chrome.runtime.getManifest().version,
      bridge: {
        state: wsState,
        port: settings.port,
        lastConnectedAt: lastConnectedAt || null,
        lastError: lastError || null,
      },
      tabs: tabs.length,
      activeTab: active,
      leaseTabId: leased ? leased.id : null,
      leaseTab: leased,
      leaseWindow,
      leaseGroup,
      leaseCursor,
      cdpAttachedTabs: Cdp.attachedTabIds(),
      note: "所有控制类工具默认作用于扩展自己的 leaseTab：它在专属后台窗口（创建时不抢焦点）内以「谷谷嘎嘎控制中」标签组打开、并在该窗口内激活，用户当前窗口与标签保持不变；常驻鼠标与原生调试提示条只在该后台页显示，默认不打扰用户。需要指定其他标签时显式传 tabId；browser_tabs activate 可显式前台化。首次控制会附加 CDP 以显示浏览器原生调试提示条。",
    };
  },

  async browser_tabs(args) {
    const action = args.action || "list";
    if (action === "list") {
      const tabs = await chrome.tabs.query({});
      const leased = await getLeaseTab();
      return {
        ok: true,
        count: tabs.length,
        leaseTabId: leased ? leased.id : null,
        tabs: tabs.map((t) => ({
          id: t.id, windowId: t.windowId, index: t.index, active: t.active,
          pinned: t.pinned, status: t.status, title: t.title, url: t.url,
          groupId: t.groupId == null ? -1 : t.groupId,
          leased: !!leased && t.id === leased.id,
        })),
      };
    }
    if (action === "activate") {
      const t = await getTab(args, { preferLease: true });
      await chrome.tabs.update(t.id, { active: true });
      try { await chrome.windows.update(t.windowId, { focused: true }); } catch (e) { /* ignore */ }
      if (leaseTabId === t.id) {
        await setControlTab(t.id);
        await showCursorCenter(t.id, "control");
      }
      return {
        ok: true, activated: t.id, url: t.url, title: t.title,
        controlled: leaseTabId === t.id,
      };
    }
    if (action === "close") {
      const t = await getTab(args, { preferLease: true });
      const info = { id: t.id, url: t.url, title: t.title };
      const wasLease = leaseTabId === t.id;
      await chrome.tabs.remove(t.id);
      bannerTabs.delete(t.id);
      legacyBannerCleared.delete(t.id);
      if (bannerTabId === t.id) bannerTabId = null;
      if (wasLease) await persistLease(null);
      return { ok: true, closed: info, leaseCleared: wasLease };
    }
    if (action === "new") {
      const url = normalizeUrl(args.url || "about:blank");
      // A new grouped agent tab in the dedicated background window: active
      // inside it for a real screenshot surface, never focused over the user.
      const t = await createLeaseTab(url);
      await waitComplete(t.id, 8000);
      await setControlTab(t.id);
      await showCursorCenter(t.id, "open");
      const after = await chrome.tabs.get(t.id);
      return {
        ok: true, created: t.id, url: after.url, title: after.title,
        active: after.active, leased: true,
      };
    }
    throw new Error("未知 action：" + action + "（可选 list / activate / close / new）");
  },

  async browser_open(args) {
    if (!args.url) throw new Error("browser_open 需要 url 参数");
    const url = normalizeUrl(args.url);
    if (args.newTab) {
      // A new grouped agent tab in the dedicated background window: active
      // inside it for a real screenshot surface, never focused over the user.
      const t = await createLeaseTab(url);
      await waitComplete(t.id, 20000);
      const after = await chrome.tabs.get(t.id);
      await setControlTab(t.id);
      await showCursorCenter(t.id, "open");
      if ((!after.url || after.url === "about:blank") && url !== "about:blank") {
        return { ok: false, error: "浏览器没有接受这个地址：" + url + "（可能是不支持的协议，或该地址被浏览器禁止访问）" };
      }
      return {
        ok: true, tabId: t.id, url: after.url, title: after.title, status: after.status,
        active: after.active, leased: true, interpretedAs: url,
      };
    }
    const tab = await getControlTab(args);
    const beforeUrl = tab.url;
    await chrome.tabs.update(tab.id, { url });
    const after = await waitComplete(tab.id, 20000);
    const final = after || (await chrome.tabs.get(tab.id));
    await setControlTab(tab.id);
    await showCursorCenter(tab.id, "open");
    if (final.url === beforeUrl && url !== beforeUrl) {
      return {
        ok: false,
        tabId: tab.id,
        error: "浏览器没有接受这个地址：" + url + "。可能是不支持的协议，或该地址被浏览器禁止访问；标签页仍停留在 " + beforeUrl,
      };
    }
    return {
      ok: true, tabId: tab.id, url: final.url, title: final.title, status: final.status,
      interpretedAs: url,
      note: url === String(args.url) ? undefined : "输入不像 URL，已按搜索处理",
    };
  },

  async browser_history(args) {
    const tab = await getControlTab(args);
    const action = args.action || "reload";
    if (action === "back") { await chrome.tabs.goBack(tab.id); }
    else if (action === "forward") { await chrome.tabs.goForward(tab.id); }
    else if (action === "reload") { await chrome.tabs.reload(tab.id, { bypassCache: !!args.bypassCache }); }
    else throw new Error("未知 action：" + action + "（可选 back / forward / reload）");
    const after = await waitComplete(tab.id, 15000);
    const final = after || (await chrome.tabs.get(tab.id));
    await setControlTab(tab.id);
    await showCursorCenter(tab.id, "open");
    return { ok: true, action, tabId: tab.id, url: final.url, title: final.title, status: final.status };
  },

  async browser_snapshot(args) {
    const tab = await getControlTab(args);
    const compact = args.compact === true || args.mode === "compact";
    const r = await pa(tab.id, "snapshot", {
      maxChars: args.maxChars || (compact ? 6000 : undefined),
      maxDepth: args.maxDepth,
      compact: compact,
    });
    return Object.assign({ tabId: tab.id }, r);
  },

  async browser_screenshot(args) {
    const tab = await getControlTab(args);
    if (!tab.active) {
      return {
        ok: false,
        tabId: tab.id,
        error: "后台标签页没有可供截图的前台 surface。请使用代理专属窗口中的页面，或显式激活该标签页后再截图；扩展不会自动切换用户当前标签页。",
      };
    }
    try {
      await Cdp.attach(tab.id);
      const shot = await Cdp.screenshot(tab.id, { fullPage: !!args.fullPage, format: args.format });
      return {
        ok: true,
        engine: "cdp",
        tabId: tab.id,
        url: tab.url,
        image: shot,
        text: "已截图 " + tab.url + "（" + (args.fullPage ? "整页" : "可视区") + "）",
      };
    } catch (e) {
      if (!tab.active) {
        return {
          ok: false,
          tabId: tab.id,
          error: "后台标签页截图需要 CDP，但附加失败：" + ((e && e.message) || e) +
            "。为不打断用户当前页面，扩展不会自动切换标签页；请检查该页是否被 DevTools 占用，或显式传 tabId 到当前前台标签。",
        };
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return {
        ok: true,
        engine: "tabs.captureVisibleTab",
        tabId: tab.id,
        url: tab.url,
        image: { data: String(dataUrl).split(",")[1], mimeType: "image/png" },
        text: "已截图 " + tab.url + "（仅可视区，兜底模式）",
        fallbackReason: (e && e.message) || String(e),
      };
    }
  },

  async browser_click(args) {
    const tab = await getControlTab(args);
    let x = args.x, y = args.y, info = null;
    if (x == null || y == null) {
      info = await pa(tab.id, "locate", { ref: args.ref, selector: args.selector, fallbacks: args.fallbacks, text: args.text, nth: args.nth });
      if (!info.ok) return info;
      x = info.x; y = info.y;
    }
    await showCursor(tab.id, { x, y, action: "click" });
    try {
      await Cdp.attach(tab.id);
      await Cdp.clickAt(tab.id, x, y, { button: args.button, clickCount: args.clickCount });
      return { ok: true, engine: "cdp", tabId: tab.id, x, y, target: info };
    } catch (e) {
      if (!info) {
        return { ok: false, error: "坐标点击需要 CDP 通道，但附加失败：" + ((e && e.message) || e) };
      }
      const r = await pa(tab.id, "clickJs", { ref: args.ref, selector: args.selector, fallbacks: args.fallbacks, text: args.text, nth: args.nth });
      return Object.assign({ tabId: tab.id, fallbackReason: (e && e.message) || String(e) }, r);
    }
  },

  async browser_type(args) {
    if (args.text == null) throw new Error("browser_type 需要 text 参数");
    const tab = await getControlTab(args);
    const target = { ref: args.ref, selector: args.selector, fallbacks: args.fallbacks, text: args.text };
    if (args.realKeys) {
      const focused = await pa(tab.id, "focus", { ref: args.ref, selector: args.selector, fallbacks: args.fallbacks, text: args.text });
      if (!focused.ok) return focused;
      if (focused.sensitive === "password") {
        return {
          ok: false,
          blocked: "password-field",
          tabId: tab.id,
          error: "安全策略拒绝向密码框写入内容（realKeys 与 JS 写值都不处理密码、验证码与支付凭据）",
        };
      }
      try {
        await Cdp.attach(tab.id);
        const n = await Cdp.typeKeys(tab.id, args.text);
        return { ok: true, engine: "cdp-keys", tabId: tab.id, typed: n, target: focused };
      } catch (e) { /* 落到 JS 写值 */ }
    }
    const r = await pa(tab.id, "type", { ref: target.ref, selector: target.selector, fallbacks: target.fallbacks, text: args.text, clear: args.clear, submit: args.submit });
    return Object.assign({ tabId: tab.id }, r);
  },

  async browser_press(args) {
    if (!args.key) throw new Error("browser_press 需要 key 参数");
    const tab = await getControlTab(args);
    if (args.ref || args.selector) {
      const focused = await pa(tab.id, "focus", { ref: args.ref, selector: args.selector });
      if (focused && focused.sensitive === "password" && (String(args.key).length === 1 || ["Backspace", "Delete", "Space"].includes(args.key))) {
        return { ok: false, blocked: "password-field", tabId: tab.id, error: "安全策略拒绝向密码框发送字符输入" };
      }
    }
    const focusState = await pa(tab.id, "focusIsPassword", {});
    if (focusState && focusState.sensitive && (String(args.key).length === 1 || ["Backspace", "Delete", "Space"].includes(args.key))) {
      return { ok: false, blocked: "password-field", tabId: tab.id, error: "当前焦点是密码框，安全策略拒绝字符输入" };
    }
    try {
      await Cdp.attach(tab.id);
      await Cdp.pressKey(tab.id, args.key);
      return { ok: true, engine: "cdp", tabId: tab.id, key: args.key };
    } catch (e) {
      const r = await pa(tab.id, "pressJs", { key: args.key });
      return Object.assign({ tabId: tab.id, fallbackReason: (e && e.message) || String(e) }, r);
    }
  },

  async browser_hover(args) {
    const tab = await getControlTab(args);
    const info = await pa(tab.id, "locate", { ref: args.ref, selector: args.selector, text: args.text, nth: args.nth });
    if (!info.ok) return info;
    try {
      await Cdp.attach(tab.id);
      await Cdp.moveTo(tab.id, info.x, info.y);
      return { ok: true, engine: "cdp", tabId: tab.id, x: info.x, y: info.y, target: info };
    } catch (e) {
      return { ok: false, error: "悬停需要 CDP 通道，附加失败：" + ((e && e.message) || e) };
    }
  },

  async browser_scroll(args) {
    const tab = await getControlTab(args);
    let dx = args.deltaX, dy = args.deltaY;
    const hasExplicitScroll = dx != null || dy != null || args.direction != null || args.amount != null;
    if (dx == null && dy == null) {
      const amount = Number(args.amount || 800);
      const dir = args.direction || "down";
      dy = dir === "up" ? -amount : dir === "down" ? amount : 0;
      dx = dir === "left" ? -amount : dir === "right" ? amount : 0;
    }
    if (args.ref || args.selector || args.text) {
      const info = await pa(tab.id, "locate", { ref: args.ref, selector: args.selector, fallbacks: args.fallbacks, text: args.text, nth: args.nth });
      if (!info.ok) return info;
      if (hasExplicitScroll) {
        const containerScroll = await pa(tab.id, "scrollJs", { ref: args.ref, selector: args.selector, text: args.text, deltaX: dx || 0, deltaY: dy || 0 });
        if (containerScroll && containerScroll.container) {
          return Object.assign({ tabId: tab.id, deltaX: dx || 0, deltaY: dy || 0 }, containerScroll);
        }
        try {
          await Cdp.attach(tab.id);
          await showCursor(tab.id, { x: info.x, y: info.y, action: "scroll" });
          await Cdp.wheel(tab.id, info.x, info.y, dx, dy);
          await sleep(120);
          const after = await Cdp.evaluate(tab.id, "JSON.stringify({scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight, innerHeight: innerHeight})");
          return Object.assign({ ok: true, engine: "cdp", tabId: tab.id, target: info, deltaX: dx || 0, deltaY: dy || 0 }, JSON.parse(after.value));
        } catch (e) {
          return Object.assign({ tabId: tab.id, fallbackReason: (e && e.message) || String(e) }, containerScroll);
        }
      }
      return Object.assign({ tabId: tab.id, target: info }, await pa(tab.id, "scrollJs", { ref: args.ref, selector: args.selector, text: args.text }));
    }
    try {
      await Cdp.attach(tab.id);
      const vp = await Cdp.evaluate(tab.id, "JSON.stringify({x: Math.round(innerWidth/2), y: Math.round(innerHeight/2)})");
      const pt = JSON.parse(vp.value);
      await showCursor(tab.id, { x: pt.x, y: pt.y, action: "scroll" });
      await Cdp.wheel(tab.id, pt.x, pt.y, dx, dy);
      await sleep(120);
      const after = await Cdp.evaluate(tab.id, "JSON.stringify({scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight, innerHeight: innerHeight})");
      return Object.assign({ ok: true, engine: "cdp", tabId: tab.id, deltaX: dx || 0, deltaY: dy || 0 }, JSON.parse(after.value));
    } catch (e) {
      const r = await pa(tab.id, "scrollJs", { ref: args.ref, selector: args.selector, deltaX: dx || 0, deltaY: dy || 0 });
      return Object.assign({ tabId: tab.id, fallbackReason: (e && e.message) || String(e) }, r);
    }
  },

  async browser_select_option(args) {
    const tab = await getControlTab(args);
    const r = await pa(tab.id, "select", { ref: args.ref, selector: args.selector, fallbacks: args.fallbacks, value: args.value, label: args.label });
    return Object.assign({ tabId: tab.id }, r);
  },

  async browser_get_text(args) {
    const tab = await getControlTab(args);
    const r = await pa(tab.id, "getText", { ref: args.ref, selector: args.selector, text: args.text, maxChars: args.maxChars });
    return Object.assign({ tabId: tab.id }, r);
  },

  async browser_evaluate(args) {
    if (!args.expression) throw new Error("browser_evaluate 需要 expression 参数");
    const tab = await getControlTab(args);
    try {
      await Cdp.attach(tab.id);
    } catch (e) {
      return { ok: false, error: "browser_evaluate 依赖 CDP 通道，但附加失败：" + ((e && e.message) || e) };
    }
    const r = await Cdp.evaluate(tab.id, args.expression, { awaitPromise: args.awaitPromise !== false });
    return { ok: true, engine: "cdp", tabId: tab.id, type: r.type, value: r.value, description: r.description };
  },

  async browser_wait_for(args) {
    if (!args.selector && !args.text) throw new Error("browser_wait_for 需要 selector 或 text");
    const tab = await getControlTab(args);
    const r = await pa(tab.id, "waitFor", { selector: args.selector, text: args.text, timeoutMs: args.timeoutMs });
    return Object.assign({ tabId: tab.id }, r);
  },

  async browser_console(args) {
    const tab = await getControlTab(args);
    const buf = logs.get(tab.id) || { console: [], network: [] };
    let list = buf.console.slice();
    if (args.level) list = list.filter((x) => x.level === args.level);
    const limit = Number(args.limit || 50);
    const tail = list.slice(-limit);
    if (args.clear) buf.console = [];
    return {
      ok: true,
      tabId: tab.id,
      attached: Cdp.isAttached(tab.id),
      count: tail.length,
      entries: tail,
      note: Cdp.isAttached(tab.id)
        ? undefined
        : "CDP 尚未附加到该标签页，控制台日志从首次 CDP 动作（截图/点击/求值等）之后才开始采集",
    };
  },

  async browser_get_cookies(args) {
    const tab = await getControlTab(args);
    const targetUrl = args.url || tab.url;
    await Cdp.attach(tab.id);
    const res = await Cdp.send(tab.id, "Network.getCookies", targetUrl ? { urls: [targetUrl] } : {});
    let cookies = (res && res.cookies) || [];
    if (args.domain) {
      const want = String(args.domain).toLowerCase();
      cookies = cookies.filter((c) => String(c.domain || "").toLowerCase().includes(want));
    }
    return {
      ok: true,
      tabId: tab.id,
      url: targetUrl,
      cookies: cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        expires: c.expires,
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        sameSite: c.sameSite || "Lax",
      })),
    };
  },

  async browser_network(args) {
    const tab = await getControlTab(args);
    const buf = logs.get(tab.id) || { console: [], network: [] };
    let list = buf.network.slice();
    if (args.filter) {
      const f = String(args.filter).toLowerCase();
      list = list.filter((x) => String(x.url || "").toLowerCase().indexOf(f) !== -1);
    }
    const limit = Number(args.limit || 50);
    const tail = list.slice(-limit);
    if (args.clear) buf.network = [];
    return {
      ok: true,
      tabId: tab.id,
      attached: Cdp.isAttached(tab.id),
      count: tail.length,
      entries: tail,
      note: Cdp.isAttached(tab.id) ? undefined : "CDP 尚未附加到该标签页，网络记录从首次 CDP 动作之后才开始采集",
    };
  },

  async browser_record_start(args) {
    return await startRecordingSession(args || {});
  },

  async browser_record_stop(args) {
    return await stopRecordingSession(args || {});
  },

  async browser_record_list() {
    await recordingReady;
    return {
      ok: true,
      browser: detectBrowser(),
      activeRecording: recordingSession || null,
      lastCompletedRecording: lastCompletedRecording || null,
    };
  },

  async browser_record_replay(args) {
    const steps = Array.isArray(args && args.steps) ? args.steps : [];
    if (!steps.length) {
      return { ok: false, error: "browser_record_replay 没有收到可执行的 steps 数组" };
    }
    const stopOnError = args.stopOnError !== false;
    const stepDelayMs = Math.max(50, Math.min(Number(args.stepDelayMs || 400), 10000));
    const maxSteps = Math.max(1, Math.min(Number(args.maxSteps || 2000), 10000));

    const ctx = {
      vars: Object.assign({}, (args && args.vars) || {}),
      tab: await getControlTab(args),
      trace: [],
      checks: [],
      extractedData: {},
      completedCount: 0,
      iterations: 0,
      stepsExecuted: 0,
      lastActionAt: 0,
    };

    class ReplayFailure extends Error {
      constructor(message, path, step) {
        super(message);
        this.path = path;
        this.step = step;
      }
    }

    // 运行时插值：解析 loop 变量、evaluate/saveAs、setVar 产生的变量。
    // 服务端已做过一次静态 vars 替换；未命中的 {{key}} 原样留给后续阶段。
    function applyFilter(v, filter) {
      switch (filter) {
        case "url":
        case "encodeURIComponent": return encodeURIComponent(String(v));
        case "json": return JSON.stringify(v);
        case "upper": return String(v).toUpperCase();
        case "lower": return String(v).toLowerCase();
        case "trim": return String(v).trim();
        default: return typeof v === "object" ? JSON.stringify(v) : String(v);
      }
    }
    function rt(value) {
      if (typeof value === "string") {
        return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*(?:\|\s*([a-zA-Z0-9_]+)\s*)?\}\}/g, (whole, key, filter) => {
          const v = ctx.vars[key];
          if (v === undefined || v === null) return whole;
          return applyFilter(v, filter);
        });
      }
      if (Array.isArray(value)) return value.map(rt);
      if (value && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = rt(v);
        return out;
      }
      return value;
    }
    // 子步骤字段留给递归执行时再插值，避免嵌套 loop 被外层变量提前替换。
    function rtStep(s) {
      const out = {};
      for (const [k, v] of Object.entries(s || {})) {
        out[k] = (k === "steps" || k === "then" || k === "else") ? v : rt(v);
      }
      return out;
    }
    function buildTarget(loc, s) {
      loc = loc || {};
      s = s || {};
      const sem = loc.semantic || {};
      const fallbacks = Array.isArray(loc.fallbacks)
        ? loc.fallbacks
        : (Array.isArray(s.fallbacks) ? s.fallbacks : undefined);
      return {
        // 兼容录制格式 locator.selector 与手写 workflow 的顶层 selector。
        selector: loc.selector || s.selector || undefined,
        fallbacks,
        text: sem.text || sem.name || undefined,
      };
    }
    async function evalExpr(expression) {
      const r = await HANDLERS.browser_evaluate({ tabId: ctx.tab.id, expression: rt(expression) });
      if (!r || r.ok === false) throw new Error("页面求值失败：" + ((r && r.error) || "未知错误"));
      return r.value;
    }
    function childSteps(v) { return Array.isArray(v) ? v : []; }
    function record(path, type, ok, extra) {
      ctx.trace.push(Object.assign({
        path,
        stepIndex: path.length ? path[0] : 0,
        type,
        ok,
      }, extra || {}));
    }

    async function runSteps(list, pathPrefix) {
      for (let i = 0; i < list.length; i++) {
        const raw = list[i] || {};
        const s = rtStep(raw);
        const type = s.type;
        const path = pathPrefix.concat([i]);
        if (++ctx.stepsExecuted > maxSteps) {
          throw new ReplayFailure("超过最大执行步数上限 " + maxSteps + "（可能有失控循环）", path, raw);
        }

        let res = { ok: true };
        try {
          if (type === "loop" || type === "forEach") {
            let items = s.items;
            if (!Array.isArray(items)) {
              const count = Math.max(0, Math.min(Number(s.count || 0), 1000));
              items = Array.from({ length: count }, (_, k) => k);
            }
            const cap = Math.max(1, Math.min(Number(s.maxIterations || 200), 1000));
            const seq = items.slice(0, cap);
            const varName = String(s.var || "item");
            const idxName = String(s.indexVar || "index");
            const hadVar = Object.prototype.hasOwnProperty.call(ctx.vars, varName);
            const hadIdx = Object.prototype.hasOwnProperty.call(ctx.vars, idxName);
            const oldVar = ctx.vars[varName];
            const oldIdx = ctx.vars[idxName];
            for (let k = 0; k < seq.length; k++) {
              ctx.vars[varName] = seq[k];
              ctx.vars[idxName] = k;
              ctx.iterations++;
              try {
                await runSteps(childSteps(raw.steps), path.concat(["loop", k]));
              } catch (e) {
                if (!s.continueOnError) throw e;
                record(path, type, false, { iteration: k, error: (e && e.message) || String(e) });
              }
              if (Number(s.delayMs) > 0 && k < seq.length - 1) await sleep(Number(s.delayMs));
            }
            if (hadVar) ctx.vars[varName] = oldVar; else delete ctx.vars[varName];
            if (hadIdx) ctx.vars[idxName] = oldIdx; else delete ctx.vars[idxName];
            res = { ok: true, iterations: seq.length };
          } else if (type === "if") {
            let cond = false;
            if (s.expression) {
              cond = !!(await evalExpr(s.expression));
            } else if (s.selector) {
              cond = !!(await evalExpr("(() => !!document.querySelector(" + JSON.stringify(s.selector) + "))()"));
            } else if (s.var != null) {
              const left = ctx.vars[s.var];
              const right = s.value;
              switch (s.op || "truthy") {
                case "equals": cond = String(left) === String(right); break;
                case "notEquals": cond = String(left) !== String(right); break;
                case "gt": cond = Number(left) > Number(right); break;
                case "lt": cond = Number(left) < Number(right); break;
                case "contains": cond = String(left).includes(String(right)); break;
                default: cond = !!left;
              }
            }
            await runSteps(childSteps(cond ? raw.then : raw.else), path.concat([cond ? "then" : "else"]));
            res = { ok: true, condition: cond };
          } else if (type === "evaluate") {
            const value = await evalExpr(s.expression);
            if (s.saveAs) ctx.vars[s.saveAs] = value;
            res = { ok: true, value, saveAs: s.saveAs || undefined };
          } else if (type === "assert" || type === "verify") {
            let passed = false;
            let detail;
            if (s.expression) {
              detail = await evalExpr(s.expression);
              passed = s.expected === undefined ? !!detail : String(detail) === String(s.expected);
            } else if (s.selector) {
              detail = await evalExpr("(() => !!document.querySelector(" + JSON.stringify(s.selector) + "))()");
              passed = !!detail;
            } else if (s.text) {
              detail = await evalExpr("(() => document.body.innerText.includes(" + JSON.stringify(s.text) + "))()");
              passed = !!detail;
            } else if (s.var != null) {
              detail = ctx.vars[s.var];
              passed = s.expected === undefined ? !!detail : String(detail) === String(s.expected);
            }
            const check = {
              name: s.name || s.field || ("assert@" + path.join(".")),
              ok: !!passed, soft: !!s.soft, value: detail, expected: s.expected,
            };
            ctx.checks.push(check);
            if (!passed && !s.soft) {
              throw new Error("断言失败：" + check.name + "（实际 " + JSON.stringify(detail) + "，期望 " + JSON.stringify(s.expected) + "）");
            }
            res = { ok: true, check };
          } else if (type === "throttle") {
            const ms = Math.max(0, Number(s.ms || 1000));
            const wait = ms - (Date.now() - ctx.lastActionAt);
            if (wait > 0) await sleep(wait);
            ctx.lastActionAt = Date.now();
            res = { ok: true, waitedMs: Math.max(0, wait) };
          } else if (type === "retry") {
            const times = Math.max(1, Math.min(Number(s.times || 3), 10));
            let lastErr = null;
            let attempts = 0;
            for (let a = 0; a < times; a++) {
              attempts++;
              const traceStart = ctx.trace.length;
              const completedStart = ctx.completedCount;
              const checksStart = ctx.checks.length;
              const iterationsStart = ctx.iterations;
              try {
                await runSteps(childSteps(raw.steps), path.concat(["retry", a]));
                lastErr = null;
                break;
              } catch (e) {
                lastErr = e;
                // 失败的一次尝试整体回滚，不能把中间失败的断言/轨迹算进最终结果。
                ctx.trace.length = traceStart;
                ctx.completedCount = completedStart;
                ctx.checks.length = checksStart;
                ctx.iterations = iterationsStart;
                if (a < times - 1) await sleep(Math.max(0, Number(s.delayMs || 500)));
              }
            }
            if (lastErr) throw lastErr;
            res = { ok: true, attempts };
          } else if (type === "setVar") {
            const v = s.expression ? await evalExpr(s.expression) : s.value;
            ctx.vars[s.name] = v;
            res = { ok: true, name: s.name, value: v };
          } else if (type === "newTab") {
            const t = await createLeaseTab(s.url || "about:blank");
            ctx.tab = t;
            await setControlTab(t.id);
            if (s.url) await waitComplete(t.id, 8000);
            res = { ok: true, tabId: t.id, url: t.url };
          } else if (type === "selectTab") {
            const tabs = await chrome.tabs.query({});
            let t = null;
            if (s.tabId != null) t = tabs.find((x) => x.id === Number(s.tabId));
            else if (s.index != null) t = tabs.filter((x) => x.windowId === ctx.tab.windowId)[Number(s.index)];
            else if (s.url) t = tabs.find((x) => String(x.url || "").includes(s.url));
            if (!t) throw new Error("selectTab 找不到目标标签");
            ctx.tab = t;
            await setControlTab(t.id);
            res = { ok: true, tabId: t.id, url: t.url };
          } else if (type === "navigate") {
            if (s.url) {
              res = await HANDLERS.browser_open({ url: s.url, tabId: ctx.tab.id });
              if (res && res.tabId) ctx.tab = await getTab({ tabId: res.tabId });
            }
          } else if (type === "click") {
            const t = buildTarget(s.locator, s);
            res = await HANDLERS.browser_click(Object.assign({ tabId: ctx.tab.id }, t));
            await waitComplete(ctx.tab.id, 5000);
          } else if (type === "type") {
            if (s.sensitive === "password" || s.value === "[REDACTED_PASSWORD]") {
              res = { ok: true, skipped: "password-redacted", note: "密码框步骤已跳过写入，复用浏览器已有登录态" };
            } else {
              const t = buildTarget(s.locator, s);
              res = await HANDLERS.browser_type({
                tabId: ctx.tab.id,
                selector: t.selector,
                fallbacks: t.fallbacks,
                text: String(s.value == null ? "" : s.value),
                clear: s.clear !== false,
                submit: !!s.submit,
              });
              if (s.submit) await waitComplete(ctx.tab.id, 6000);
            }
          } else if (type === "select") {
            const t = buildTarget(s.locator, s);
            res = await HANDLERS.browser_select_option({
              tabId: ctx.tab.id, selector: t.selector, fallbacks: t.fallbacks,
              value: s.value, label: s.label,
            });
          } else if (type === "press") {
            const t = buildTarget(s.locator, s);
            res = await HANDLERS.browser_press({
              tabId: ctx.tab.id, key: s.key || "Enter", selector: t.selector,
            });
            if (s.key === "Enter") await waitComplete(ctx.tab.id, 5000);
          } else if (type === "scroll") {
            res = await HANDLERS.browser_scroll({
              tabId: ctx.tab.id, deltaY: s.deltaY,
              direction: s.direction || "down", amount: s.amount || 600,
            });
          } else if (type === "extract") {
            const t = buildTarget(s.locator, s);
            res = await pa(ctx.tab.id, "extractData", {
              listSelector: s.listSelector, selector: t.selector, fallbacks: t.fallbacks,
              text: t.text, maxItems: s.maxItems || 30,
            });
            if (res && res.ok) {
              const key = s.field || ("extract_step_" + (s.index || (i + 1)));
              const value = res.mode === "list" ? res.items : res.text;
              ctx.extractedData[key] = value;
              if (s.saveAs) ctx.vars[s.saveAs] = value;
            }
          } else if (type === "wait") {
            if (s.selector || s.text) {
              res = await HANDLERS.browser_wait_for({
                tabId: ctx.tab.id, selector: s.selector, text: s.text,
                timeoutMs: s.timeoutMs || 10000,
              });
            } else {
              await sleep(Number(s.ms || 1000));
              res = { ok: true, waitedMs: Number(s.ms || 1000) };
            }
          } else if (type === "note") {
            res = { ok: true, userNote: s.note };
          } else {
            throw new Error("未知步骤类型：" + type);
          }
        } catch (e) {
          if (e instanceof ReplayFailure) throw e;
          res = { ok: false, error: (e && e.message) || String(e) };
        }

        const stepOk = !!(res && res.ok !== false);
        record(path, type, stepOk, {
          userNote: s.userNote || s.note || undefined,
          error: stepOk ? undefined : (res && res.error) || "步骤执行未成功",
          detail: stepOk && (type === "loop" || type === "if" || type === "evaluate" || type === "assert" || type === "retry")
            ? { iterations: res.iterations, condition: res.condition, value: res.value, attempts: res.attempts }
            : undefined,
        });
        if (stepOk) ctx.completedCount++;
        ctx.lastActionAt = Date.now();

        if (!stepOk) {
          const tolerate = s.continueOnError === true || stopOnError === false;
          if (!tolerate) {
            throw new ReplayFailure((res && res.error) || ("第 " + (i + 1) + " 步 (" + type + ") 回放未命中目标元素"), path, raw);
          }
        }
        if (i < list.length - 1 && pathPrefix.length === 0) await sleep(stepDelayMs);
      }
    }

    try {
      await runSteps(steps, []);
    } catch (e) {
      const path = (e && e.path) || [];
      let curTab = ctx.tab;
      try { curTab = await chrome.tabs.get(ctx.tab.id); } catch (err) { /* ignore */ }
      return {
        ok: false,
        validated: false,
        tabId: ctx.tab.id,
        currentUrl: curTab && curTab.url,
        currentTitle: curTab && curTab.title,
        completedCount: ctx.completedCount,
        totalSteps: steps.length,
        iterations: ctx.iterations,
        failedStepIndex: path.length ? path[0] : 0,
        failedPath: path,
        failedStep: (e && e.step) || null,
        error: (e && e.message) || String(e),
        extractedData: ctx.extractedData,
        vars: ctx.vars,
        checks: ctx.checks,
        trace: ctx.trace,
        selfHealHint: "确定性 RPA 回放中断。请调用 browser_snapshot 获取当前页面的最新 ref 结构，按照业务意图手动完成该步及后续步骤。",
      };
    }

    let finalTab = ctx.tab;
    try { finalTab = await chrome.tabs.get(ctx.tab.id); } catch (e) { /* ignore */ }
    const validated = ctx.trace.every((t) => t.ok !== false) && ctx.checks.every((c) => c.ok || c.soft);
    return {
      ok: true,
      validated,
      tabId: ctx.tab.id,
      finalUrl: finalTab && finalTab.url,
      finalTitle: finalTab && finalTab.title,
      completedCount: ctx.completedCount,
      totalSteps: steps.length,
      iterations: ctx.iterations,
      extractedData: ctx.extractedData,
      vars: ctx.vars,
      checks: ctx.checks,
      trace: ctx.trace,
    };
  },
};

/* ------------------------------------------------------------------ 事件与生命周期 */

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source && source.tabId;
  if (tabId == null) return;
  const buf = bufferFor(tabId);
  try {
    if (method === "Runtime.consoleAPICalled") {
      buf.console.push({
        level: params.type || "log",
        text: (params.args || []).map(Cdp.formatRemoteObject).join(" "),
        at: Date.now(),
      });
      trim(buf.console);
    } else if (method === "Runtime.exceptionThrown") {
      const d = params.exceptionDetails || {};
      buf.console.push({
        level: "error",
        text: (d.exception && d.exception.description) || d.text || "未捕获异常",
        url: d.url,
        at: Date.now(),
      });
      trim(buf.console);
    } else if (method === "Log.entryAdded") {
      const e = params.entry || {};
      buf.console.push({ level: e.level || "log", text: e.text, url: e.url, at: Date.now() });
      trim(buf.console);
    } else if (method === "Network.requestWillBeSent") {
      buf.network.push({ phase: "request", method: params.request && params.request.method, url: params.request && params.request.url, type: params.type, at: Date.now() });
      trim(buf.network);
    } else if (method === "Network.responseReceived") {
      buf.network.push({ phase: "response", status: params.response && params.response.status, url: params.response && params.response.url, mimeType: params.response && params.response.mimeType, at: Date.now() });
      trim(buf.network);
    } else if (method === "Network.loadingFailed") {
      buf.network.push({ phase: "failed", error: params.errorText, at: Date.now() });
      trim(buf.network);
    }
  } catch (e) { /* ignore */ }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId != null) Cdp.forget(source.tabId);
  refreshBadge();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  logs.delete(tabId);
  Cdp.forget(tabId);
  bannerTabs.delete(tabId);
  legacyBannerCleared.delete(tabId);
  if (bannerTabId === tabId) bannerTabId = null;
  if (leaseTabId === tabId) persistLease(null);
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (leaseWindowId === windowId) persistLease(null);
});

chrome.tabs.onCreated.addListener((tab) => {
  if (
    recordingSession &&
    recordingSession.active &&
    tab &&
    tab.id != null &&
    tab.openerTabId != null &&
    Array.isArray(recordingSession.tabIds) &&
    recordingSession.tabIds.includes(tab.openerTabId)
  ) {
    if (!recordingSession.tabIds.includes(tab.id)) {
      recordingSession.tabIds.push(tab.id);
      persistRecordingState();
    }
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo && changeInfo.status === "loading") logs.delete(tabId);
  if (changeInfo && changeInfo.status === "complete" && bannerTabId === tabId) {
    setTimeout(() => {
      if (wsState !== "connected" || bannerTabId !== tabId) return;
      setControlTab(tabId)
        .then(() => showCursorCenter(tabId, "open"))
        .catch(() => {});
    }, 220);
  }
  if (
    changeInfo &&
    changeInfo.status === "complete" &&
    recordingSession &&
    recordingSession.active &&
    Array.isArray(recordingSession.tabIds) &&
    recordingSession.tabIds.includes(tabId)
  ) {
    const url = (tab && tab.url) || "";
    const title = (tab && tab.title) || "";
    if (url && !/^(about:blank|edge:\/\/|chrome:\/\/)/i.test(url)) {
      const steps = recordingSession.steps || [];
      const last = steps[steps.length - 1];
      if (!last || last.type !== "navigate" || last.url !== url) {
        steps.push({
          index: steps.length + 1,
          type: "navigate",
          url,
          pageTitle: title,
          tabId,
          at: Date.now(),
        });
        persistRecordingState();
      }
    }
    setTimeout(() => {
      if (!recordingSession || !recordingSession.active) return;
      injectRecorder(tabId, {
        sessionId: recordingSession.recordingId,
        stepCount: (recordingSession.steps || []).length,
        paused: !!recordingSession.paused,
        lastSummary: "已跳转: " + (title || url),
      }).catch(() => {});
    }, 180);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (wsState !== "connected") connect();
  else sendRaw({ t: "ping", at: Date.now() });
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  (async () => {
    try {
      if (msg && msg.type === "ag:status") {
        await recordingReady;
        let tabs = 0, active = null;
        try { tabs = (await chrome.tabs.query({})).length; } catch (e) { /* ignore */ }
        try {
          const t = await getActiveTab();
          if (t) active = { id: t.id, title: t.title, url: t.url };
        } catch (e) { /* ignore */ }
        const ids = Cdp.attachedTabIds();
        respond({
          ok: true, wsState, settings, browser: detectBrowser(),
          tabs, activeTab: active, leaseTabId, cdpTabId: ids.length ? ids[0] : null, lastError,
          extensionId: chrome.runtime.id, recordingSupported: true,
          recording: recordingSession && recordingSession.active ? {
            active: true,
            paused: !!recordingSession.paused,
            recordingId: recordingSession.recordingId,
            title: recordingSession.title,
            stepCount: (recordingSession.steps || []).length,
          } : null,
          lastRecording: lastCompletedRecording ? {
            recordingId: lastCompletedRecording.recordingId,
            title: lastCompletedRecording.title,
            stepCount: (lastCompletedRecording.steps || []).length,
            stoppedAt: lastCompletedRecording.stoppedAt,
          } : null,
        });
        return;
      }
      if (msg && msg.type === "ag:record:step") {
        await recordingReady;
        if (!recordingSession || !recordingSession.active || recordingSession.paused) {
          respond({ ok: false, ignored: true });
          return;
        }
        const rawStep = Object.assign({}, msg.step || {});
        const steps = recordingSession.steps || (recordingSession.steps = []);
        if (sender && sender.tab && sender.tab.id != null) {
          rawStep.tabId = sender.tab.id;
          if (!recordingSession.tabIds.includes(sender.tab.id)) {
            recordingSession.tabIds.push(sender.tab.id);
          }
        }
        // 用户在 HUD 添加的规则备注同时绑定到最近一个操作步骤上，方便编译 Skill 时直接关联上下文
        if (rawStep.type === "note" && rawStep.note && steps.length > 0) {
          const prev = steps[steps.length - 1];
          prev.userNote = prev.userNote ? (prev.userNote + "；" + rawStep.note) : rawStep.note;
        }
        rawStep.index = steps.length + 1;
        steps.push(rawStep);
        await persistRecordingState();
        respond({ ok: true, stepCount: steps.length });
        return;
      }
      if (msg && msg.type === "ag:record:pause") {
        await recordingReady;
        if (recordingSession && recordingSession.active) {
          recordingSession.paused = !!msg.paused;
          await persistRecordingState();
        }
        respond({ ok: true, paused: !!(recordingSession && recordingSession.paused) });
        return;
      }
      if (msg && (msg.type === "ag:record:finishFromHud" || msg.type === "ag:record:stop")) {
        const res = await stopRecordingSession(msg.args || {});
        if (res && res.ok && res.recording) {
          sendRaw({ t: "record_done", recording: res.recording });
        }
        respond(res);
        return;
      }
      if (msg && msg.type === "ag:record:start") {
        const res = await startRecordingSession(msg.args || {});
        respond(res);
        return;
      }
      if (msg && msg.type === "ag:settings") {
        settings = Object.assign({}, settings, msg.settings || {});
        await chrome.storage.local.set(settings);
        respond({ ok: true, settings });
        return;
      }
      if (msg && msg.type === "ag:reconnect") {
        reconnectDelay = 800;
        await clearControlBanner();
        if (ws) { try { ws.close(); } catch (e) { /* ignore */ } ws = null; }
        wsState = "disconnected";
        connect();
        respond({ ok: true });
        return;
      }
      respond({ ok: false, error: "未知消息类型" });
    } catch (e) {
      respond({ ok: false, error: (e && e.message) || String(e) });
    }
  })();
  return true;
});

async function init() {
  try {
    const got = await chrome.storage.local.get(["port", "token", "autoConnect", "searchEngine"]);
    settings = Object.assign({}, DEFAULT_SETTINGS, got || {});
    if (got && got.port == null) await chrome.storage.local.set({ port: DEFAULT_SETTINGS.port });
  } catch (e) {
    lastError = "读取设置失败：" + ((e && e.message) || e);
  }
  try { chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 }); } catch (e) { /* ignore */ }
  connect();
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
init();
