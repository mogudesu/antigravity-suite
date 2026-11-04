/**
 * banner.js —— 「谷谷嘎嘎正在控制你的浏览器」页面提示的注入与移除。
 * 只在 MV3 service worker 中运行；真正的 DOM 逻辑在 banner-page.js（隔离世界）。
 *
 * 约定：任何失败都只返回 { ok:false }，绝不抛给工具调用方——
 * 受保护页面（edge://、chrome://、扩展商店、PDF 阅读器）注入失败是预期行为。
 */

const BANNER_FILE = "banner-page.js";
const BANNER_ID = "agbb-control-banner-host";
const INJECT_TIMEOUT_MS = 500;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(resolve, ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** 在指定标签页显示/续期提示条；返回 { ok, ... }，不抛错。 */
export async function show(tabId, opts) {
  const target = { tabId: Number(tabId) };
  try {
    await withTimeout(
      chrome.scripting.executeScript({ target, files: [BANNER_FILE], world: "ISOLATED" }),
      INJECT_TIMEOUT_MS
    );
    const out = await withTimeout(
      chrome.scripting.executeScript({
        target,
        world: "ISOLATED",
        func: (options) => {
          const b = globalThis.__AGBB_BANNER;
          if (!b || typeof b.show !== "function") return { ok: false, error: "提示条模块未就绪" };
          return b.show(options || {});
        },
        args: [opts || {}],
      }),
      INJECT_TIMEOUT_MS
    );
    const r = out && out[0] ? out[0].result : null;
    if (r && r.ok) return r;
    return { ok: false, error: (r && r.error) || "提示条注入失败" };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/** 移除指定标签页的提示条；返回是否已处理，不抛错。 */
export async function hide(tabId) {
  const target = { tabId: Number(tabId) };
  try {
    const out = await withTimeout(
      chrome.scripting.executeScript({
        target,
        world: "ISOLATED",
        func: (hostId) => {
          const b = globalThis.__AGBB_BANNER;
          if (b && typeof b.hide === "function") return b.hide();
          const host = document.getElementById(hostId);
          if (host && host.parentNode) host.parentNode.removeChild(host);
          return { ok: true, removed: !!host };
        },
        args: [BANNER_ID],
      }),
      INJECT_TIMEOUT_MS
    );
    return !!(out && out[0] && out[0].result && out[0].result.ok);
  } catch (e) {
    return false;
  }
}
