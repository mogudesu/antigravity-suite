/**
 * cdp.js —— chrome.debugger（Chrome DevTools Protocol）薄封装。
 * 只在 service worker 中运行。附加失败（DevTools 已打开、受保护页面等）时由调用方兜底到页面脚本方案。
 */

const CDP_VERSION = "1.3";
const attached = new Map(); // tabId -> true

export function isAttached(tabId) {
  return attached.has(Number(tabId));
}

export function attachedTabIds() {
  return Array.from(attached.keys());
}

export async function attach(tabId) {
  const id = Number(tabId);
  if (attached.has(id)) return { ok: true, already: true };
  try {
    await chrome.debugger.attach({ tabId: id }, CDP_VERSION);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    throw new Error(
      "CDP 附加失败（" + msg + "）。常见原因：该标签页已打开 DevTools、属于受保护页面（edge://、chrome://、扩展商店），或另一个调试器已附加。"
    );
  }
  attached.set(id, true);
  // 按需开启域；个别域不可用时忽略，不影响主流程
  for (const domain of ["Page", "Runtime", "DOM", "Log", "Network"]) {
    try { await send(id, domain + ".enable", {}); } catch (e) { /* ignore */ }
  }
  return { ok: true };
}

export async function detach(tabId) {
  const id = Number(tabId);
  if (!attached.has(id)) return { ok: true, already: true };
  try { await chrome.debugger.detach({ tabId: id }); } catch (e) { /* ignore */ }
  attached.delete(id);
  return { ok: true };
}

export function forget(tabId) {
  attached.delete(Number(tabId));
}

export async function send(tabId, method, params) {
  const id = Number(tabId);
  return await chrome.debugger.sendCommand({ tabId: id }, method, params || {});
}

/** 在页面主世界求值，绕开页面 CSP，可拿到真正的全局对象 */
export async function evaluate(tabId, expression, opts = {}) {
  const res = await send(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: opts.returnByValue !== false,
    awaitPromise: opts.awaitPromise !== false,
    userGesture: true,
    allowUnsafeEvalBlockedByCSP: true,
    includeCommandLineAPI: false,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error("页面求值抛错：" + ((d.exception && d.exception.description) || d.text || "unknown"));
  }
  const r = res.result || {};
  return { type: r.type, value: r.value, description: r.description };
}

/** 真实鼠标点击（含 mouseMoved，便于触发 hover 态） */
export async function clickAt(tabId, x, y, opts = {}) {
  const button = opts.button || "left";
  const clickCount = Number(opts.clickCount || 1);
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", clickCount: 0 });
  await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount });
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount });
}

export async function moveTo(tabId, x, y) {
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", clickCount: 0 });
}

export async function wheel(tabId, x, y, deltaX, deltaY) {
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseWheel", x, y, deltaX: Number(deltaX || 0), deltaY: Number(deltaY || 0),
    button: "none", clickCount: 0,
  });
}

const KEY_TABLE = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  " ": { key: " ", code: "Space", keyCode: 32, text: " " },
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
  Control: { key: "Control", code: "ControlLeft", keyCode: 17 },
  Alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
  Meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
};
for (let i = 1; i <= 12; i++) {
  KEY_TABLE["F" + i] = { key: "F" + i, code: "F" + i, keyCode: 111 + i };
}

const OEM_CHARS = {
  "-": { code: "Minus", keyCode: 189, shift: false },
  "_": { code: "Minus", keyCode: 189, shift: true },
  "=": { code: "Equal", keyCode: 187, shift: false },
  "+": { code: "Equal", keyCode: 187, shift: true },
  "[": { code: "BracketLeft", keyCode: 219, shift: false },
  "{": { code: "BracketLeft", keyCode: 219, shift: true },
  "]": { code: "BracketRight", keyCode: 221, shift: false },
  "}": { code: "BracketRight", keyCode: 221, shift: true },
  "\\": { code: "Backslash", keyCode: 220, shift: false },
  "|": { code: "Backslash", keyCode: 220, shift: true },
  ";": { code: "Semicolon", keyCode: 186, shift: false },
  ":": { code: "Semicolon", keyCode: 186, shift: true },
  "'": { code: "Quote", keyCode: 222, shift: false },
  "\"": { code: "Quote", keyCode: 222, shift: true },
  ",": { code: "Comma", keyCode: 188, shift: false },
  "<": { code: "Comma", keyCode: 188, shift: true },
  ".": { code: "Period", keyCode: 190, shift: false },
  ">": { code: "Period", keyCode: 190, shift: true },
  "/": { code: "Slash", keyCode: 191, shift: false },
  "?": { code: "Slash", keyCode: 191, shift: true },
  "`": { code: "Backquote", keyCode: 192, shift: false },
  "~": { code: "Backquote", keyCode: 192, shift: true },
  "!": { code: "Digit1", keyCode: 49, shift: true },
  "@": { code: "Digit2", keyCode: 50, shift: true },
  "#": { code: "Digit3", keyCode: 51, shift: true },
  "$": { code: "Digit4", keyCode: 52, shift: true },
  "%": { code: "Digit5", keyCode: 53, shift: true },
  "^": { code: "Digit6", keyCode: 54, shift: true },
  "&": { code: "Digit7", keyCode: 55, shift: true },
  "*": { code: "Digit8", keyCode: 56, shift: true },
  "(": { code: "Digit9", keyCode: 57, shift: true },
  ")": { code: "Digit0", keyCode: 48, shift: true },
};

function charKeySpec(ch) {
  if (ch === " ") return KEY_TABLE.Space;
  if (/^[a-zA-Z]$/.test(ch)) {
    const upper = ch.toUpperCase();
    return { key: ch, code: "Key" + upper, keyCode: upper.charCodeAt(0), shift: ch !== ch.toLowerCase(), text: ch };
  }
  if (/^[0-9]$/.test(ch)) {
    return { key: ch, code: "Digit" + ch, keyCode: ch.charCodeAt(0), shift: false, text: ch };
  }
  if (OEM_CHARS[ch]) {
    const o = OEM_CHARS[ch];
    return { key: ch, code: o.code, keyCode: o.keyCode, shift: o.shift, text: ch };
  }
  return null;
}

function keySpec(key) {
  if (KEY_TABLE[key]) return KEY_TABLE[key];
  if (key.length === 1) {
    const c = charKeySpec(key);
    if (c) return c;
    return { key, code: "Unidentified", keyCode: 0, text: key };
  }
  return { key, code: key, keyCode: 0 };
}

function parseCombo(combo) {
  const parts = String(combo || "").split("+").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { modifiers: 0, key: String(combo || "") };
  if (parts.length === 1) return { modifiers: 0, key: parts[0] };
  let modifiers = 0;
  for (let i = 0; i < parts.length - 1; i++) {
    const m = parts[i].toLowerCase();
    if (m === "alt") modifiers |= 1;
    else if (m === "control" || m === "ctrl") modifiers |= 2;
    else if (m === "meta" || m === "cmd" || m === "command" || m === "win") modifiers |= 4;
    else if (m === "shift") modifiers |= 8;
  }
  return { modifiers, key: parts[parts.length - 1] };
}

/** 真实按键与组合键；带 text 且无控制修饰键时走 keyDown，否则走 rawKeyDown */
export async function pressKey(tabId, key, opts = {}) {
  const parsed = parseCombo(key);
  const k = keySpec(parsed.key);
  const modifiers = Number(opts.modifiers || parsed.modifiers || 0) | (k.shift ? 8 : 0);
  const hasCtrlOrAltOrMeta = (modifiers & (1 | 2 | 4)) !== 0;
  const base = {
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.keyCode,
    nativeVirtualKeyCode: k.keyCode,
    modifiers,
  };
  const sendText = k.text && !hasCtrlOrAltOrMeta;
  const downType = sendText ? "keyDown" : "rawKeyDown";
  await send(tabId, "Input.dispatchKeyEvent", Object.assign({ type: downType }, base, sendText ? { text: k.text, unmodifiedText: k.text } : {}));
  await send(tabId, "Input.dispatchKeyEvent", Object.assign({ type: "keyUp" }, base));
}

/** 逐字符真实按键；非 ASCII/中文直接走 Input.insertText 避免 VK 错位 */
export async function typeKeys(tabId, text) {
  const chars = Array.from(String(text));
  for (const ch of chars) {
    const spec = charKeySpec(ch);
    if (!spec) {
      await send(tabId, "Input.insertText", { text: ch });
      continue;
    }
    const base = {
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
      modifiers: spec.shift ? 8 : 0,
    };
    await send(tabId, "Input.dispatchKeyEvent", Object.assign({ type: "keyDown", text: ch, unmodifiedText: ch }, base));
    await send(tabId, "Input.dispatchKeyEvent", Object.assign({ type: "keyUp" }, base));
  }
  return chars.length;
}

export async function insertText(tabId, text) {
  await send(tabId, "Input.insertText", { text: String(text) });
}

export async function screenshot(tabId, opts = {}) {
  const params = { format: opts.format === "jpeg" ? "jpeg" : "png" };
  if (params.format === "jpeg") params.quality = Number(opts.quality || 80);
  if (opts.fullPage) {
    params.captureBeyondViewport = true;
    try {
      const metrics = await send(tabId, "Page.getLayoutMetrics");
      const size = metrics.cssContentSize || metrics.contentSize;
      if (size && size.width && size.height) {
        params.clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
      }
    } catch (e) { /* 拿不到尺寸就退回可视区 */ }
  }
  const res = await send(tabId, "Page.captureScreenshot", params);
  return { data: res.data, mimeType: params.format === "jpeg" ? "image/jpeg" : "image/png" };
}

export function consoleLogBufferFactory() {
  return { console: [], network: [] };
}

/** 把 CDP RemoteObject 压成一行文本 */
export function formatRemoteObject(arg) {
  if (!arg) return "";
  if (arg.type === "string") return String(arg.value);
  if (arg.type === "number" || arg.type === "boolean") return String(arg.value);
  if (arg.type === "undefined") return "undefined";
  if (arg.subtype === "null") return "null";
  return arg.description || ("<" + arg.type + ">");
}
