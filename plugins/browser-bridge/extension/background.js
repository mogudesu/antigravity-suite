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
        : await chrome.tabs.group({ tabIds: [tab.id] });
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
    const active = await getActiveTab();
    let windowId = active && active.windowId;
    if (!windowId) {
      const last = await chrome.windows.getLastFocused().catch(() => null);
      windowId = last && last.id;
    }
    const props = { url, active: true };
    if (windowId) props.windowId = windowId;
    const tab = await chrome.tabs.create(props);
    await persistLease(tab.id, tab.windowId);
    await ensureLeaseGroup(tab.id);
    return tab;
  })().finally(() => { leaseCreating = null; });
  return leaseCreating;
}

async function createLeaseTab(url = "about:blank") {
  const lease = await getLeaseTab();
  if (!lease) return ensureLeaseTab(url);
  const tab = await chrome.tabs.create({
    windowId: lease.windowId,
    url,
    active: true,
  });
  await persistLease(tab.id, tab.windowId);
  await ensureLeaseGroup(tab.id);
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
      note: "所有控制类工具默认作用于扩展自己的 leaseTab：它在当前窗口内以「谷谷嘎嘎控制中」标签组打开并激活，页面内常驻可见鼠标，不会改写用户原标签页；需要指定其他标签时显式传 tabId。首次控制会附加 CDP 以显示浏览器原生调试提示条。",
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
      // A new grouped agent tab in the current window: visible to the user,
      // active for a real screenshot surface, and never reuses the user's tab.
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
      // A new grouped agent tab in the current window: visible to the user,
      // active for a real screenshot surface, and never reuses the user's tab.
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
    if (dx == null && dy == null) {
      const amount = Number(args.amount || 800);
      const dir = args.direction || "down";
      dy = dir === "up" ? -amount : dir === "down" ? amount : 0;
      dx = dir === "left" ? -amount : dir === "right" ? amount : 0;
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
    let tab = await getControlTab(args);
    const trace = [];
    const extractedData = {};
    let completedCount = 0;

    function buildTarget(loc) {
      loc = loc || {};
      const sem = loc.semantic || {};
      return {
        selector: loc.selector || undefined,
        fallbacks: Array.isArray(loc.fallbacks) ? loc.fallbacks : undefined,
        text: sem.text || sem.name || undefined,
      };
    }

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i] || {};
      const type = s.type;
      let res = { ok: true };
      try {
        if (type === "navigate") {
          if (s.url) {
            res = await HANDLERS.browser_open({ url: s.url, tabId: tab.id });
            if (res && res.tabId) tab = await getTab({ tabId: res.tabId });
          }
        } else if (type === "click") {
          const t = buildTarget(s.locator);
          res = await HANDLERS.browser_click(Object.assign({ tabId: tab.id }, t));
          await waitComplete(tab.id, 5000);
        } else if (type === "type") {
          if (s.sensitive === "password" || s.value === "[REDACTED_PASSWORD]") {
            res = { ok: true, skipped: "password-redacted", note: "密码框步骤已跳过写入，复用浏览器已有登录态" };
          } else {
            const t = buildTarget(s.locator);
            res = await HANDLERS.browser_type({
              tabId: tab.id,
              selector: t.selector,
              fallbacks: t.fallbacks,
              text: String(s.value == null ? "" : s.value),
              clear: s.clear !== false,
              submit: !!s.submit,
            });
            if (s.submit) await waitComplete(tab.id, 6000);
          }
        } else if (type === "select") {
          const t = buildTarget(s.locator);
          res = await HANDLERS.browser_select_option({
            tabId: tab.id,
            selector: t.selector,
            fallbacks: t.fallbacks,
            value: s.value,
            label: s.label,
          });
        } else if (type === "press") {
          const t = buildTarget(s.locator);
          res = await HANDLERS.browser_press({
            tabId: tab.id,
            key: s.key || "Enter",
            selector: t.selector,
          });
          if (s.key === "Enter") await waitComplete(tab.id, 5000);
        } else if (type === "scroll") {
          res = await HANDLERS.browser_scroll({
            tabId: tab.id,
            deltaY: s.deltaY,
            direction: s.direction || "down",
            amount: s.amount || 600,
          });
        } else if (type === "extract") {
          const t = buildTarget(s.locator);
          res = await pa(tab.id, "extractData", {
            listSelector: s.listSelector,
            selector: t.selector,
            fallbacks: t.fallbacks,
            text: t.text,
            maxItems: s.maxItems || 30,
          });
          if (res && res.ok) {
            const key = s.field || ("extract_step_" + (s.index || (i + 1)));
            extractedData[key] = res.mode === "list" ? res.items : res.text;
          }
        } else if (type === "wait") {
          if (s.selector || s.text) {
            res = await HANDLERS.browser_wait_for({ tabId: tab.id, selector: s.selector, text: s.text, timeoutMs: s.timeoutMs || 10000 });
          } else {
            await sleep(Number(s.ms || 1000));
            res = { ok: true, waitedMs: Number(s.ms || 1000) };
          }
        } else if (type === "note") {
          res = { ok: true, userNote: s.note };
        }
      } catch (e) {
        res = { ok: false, error: (e && e.message) || String(e) };
      }

      const stepOk = !!(res && res.ok !== false);
      trace.push({
        stepIndex: i,
        type,
        ok: stepOk,
        userNote: s.userNote || s.note || undefined,
        error: stepOk ? undefined : (res && res.error) || "步骤执行未成功",
      });

      if (!stepOk && stopOnError) {
        let curTab = tab;
        try { curTab = await chrome.tabs.get(tab.id); } catch (e) { /* ignore */ }
        return {
          ok: false,
          tabId: tab.id,
          currentUrl: curTab && curTab.url,
          currentTitle: curTab && curTab.title,
          completedCount,
          totalSteps: steps.length,
          failedStepIndex: i,
          failedStep: s,
          error: (res && res.error) || ("第 " + (i + 1) + " 步 (" + type + ") 回放未命中目标元素"),
          extractedData,
          trace,
          selfHealHint: "确定性 RPA 回放在第 " + (i + 1) + " 步中断。请调用 browser_snapshot 获取当前页面的最新 ref 结构，按照业务意图手动完成该步及后续步骤。",
        };
      }

      if (stepOk) completedCount++;
      if (i < steps.length - 1) await sleep(stepDelayMs);
    }

    let finalTab = tab;
    try { finalTab = await chrome.tabs.get(tab.id); } catch (e) { /* ignore */ }
    return {
      ok: true,
      tabId: tab.id,
      finalUrl: finalTab && finalTab.url,
      finalTitle: finalTab && finalTab.title,
      completedCount,
      totalSteps: steps.length,
      extractedData,
      trace,
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
