"use strict";

/**
 * isolated-engine.js
 * 默认后台无头双轨引擎（基于 playwright-core + 本机 Edge/Chrome + 独立 user-data-dir）。
 *
 * 设计目标：
 *   1. 与用户日常浏览器完全隔离：无「正在调试此浏览器」黄条、不抢焦点、最小化/锁屏不挂起。
 *   2. 真正的多会话并发：按 sessionId 隔离页面池与 ref/日志/弹窗状态，共享 isolated-profile 登录态。
 *   3. 支持 iframe + Shadow DOM 穿透快照、敏感字段拦截、弹窗自动捕获与尺寸受控截图。
 *   4. 按需显式弹窗登录（browser_open_auth_window）与状态导入导出（browser_auth_sync）。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright-core");
const { resolveBrowser } = require("./launch");
const { canonicalInside } = require("./recordings");

const MAX_LOG_ENTRIES = 400;
const MAX_SNAPSHOT_REFS = 1500;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

const SENSITIVE_NAME_RE = /(?:password|passwd|pwd|passcode|otp|one.?time.?code|pin.?code|cvv|cvc|card.?num|credit.?card|cc.?num|cc.?csc|银行卡|密码|支付密码|交易密码|验证码|口令)/i;

function getMemoryBaseDir() {
  return process.env.AG_BRIDGE_AUDIT_DIR ||
    path.join(os.homedir(), ".gemini", "memory", "browser-bridge");
}

function getDefaultProfileDir() {
  return process.env.AG_BRIDGE_PROFILE_DIR ||
    path.join(getMemoryBaseDir(), "isolated-profile");
}

function normalizeUrl(raw, searchEngine) {
  const s = String(raw || "").trim();
  if (!s) return "about:blank";
  if (/^\s*javascript:/i.test(s)) {
    throw new Error("安全策略拒绝打开 javascript: 协议链接");
  }
  if (/^(https?|about|file):/i.test(s)) return s;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(s)) return "http://" + s;
  if (/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+([/?#:].*)?$/.test(s)) return "https://" + s;
  const base = searchEngine || "https://www.bing.com/search?q=";
  return base + encodeURIComponent(s);
}

function sanitizeKey(v, fallback = "default") {
  const clean = String(v || fallback).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
  return clean || fallback;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 在页面内（支持 open Shadow DOM）执行的紧凑/完整 DOM 遍历器 */
const FRAME_WALKER_FN = (opts) => {
  const compact = !!opts.compact;
  const interactiveOnly = !!opts.interactiveOnly;
  const maxDepth = Number(opts.maxDepth || 40);
  const startIndex = Number(opts.startIndex || 1);
  const maxRefs = Number(opts.maxRefs || 800);
  const maxLines = Number(opts.maxLines || 600);

  const INTERACTIVE_TAGS = { A: 1, BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, OPTION: 1, SUMMARY: 1, DETAILS: 1 };
  const ROLE_BY_TAG = { a: "link", button: "button", select: "combobox", textarea: "textbox", summary: "button", option: "option", label: "label" };
  const ROLE_BY_INPUT = {
    text: "textbox", search: "searchbox", email: "textbox", password: "textbox",
    tel: "textbox", url: "textbox", number: "spinbutton", checkbox: "checkbox",
    radio: "radio", submit: "button", button: "button", reset: "button",
    file: "file", range: "slider", color: "color", date: "date", "datetime-local": "date",
    month: "date", time: "time", week: "date", hidden: "",
  };
  const SENSITIVE_RE = /(?:password|passwd|pwd|passcode|otp|one.?time.?code|pin.?code|cvv|cvc|card.?num|credit.?card|cc.?num|cc.?csc|银行卡|密码|支付密码|交易密码|验证码|口令)/i;

  function trunc(s, n) {
    s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    const style = getComputedStyle(el);
    if (!style || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    if (el.hasAttribute("hidden")) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0 && !el.shadowRoot && el.tagName !== "BODY") return false;
    return true;
  }

  function sensitiveType(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea") return false;
    const type = String(el.getAttribute("type") || "text").toLowerCase();
    if (type === "password") return "password";
    const ac = String(el.getAttribute("autocomplete") || "").toLowerCase();
    if (ac.includes("current-password") || ac.includes("new-password")) return "password";
    if (ac.includes("one-time-code") || ac.includes("cc-number") || ac.includes("cc-csc") || ac.includes("cc-exp")) return "sensitive";
    const meta = [
      el.getAttribute("name") || "",
      el.getAttribute("id") || "",
      el.getAttribute("aria-label") || "",
      el.getAttribute("placeholder") || "",
    ].join(" ");
    if (SENSITIVE_RE.test(meta)) return "sensitive";
    return false;
  }

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") return ROLE_BY_INPUT[String(el.getAttribute("type") || "text").toLowerCase()] || "textbox";
    if (el.isContentEditable) return "textbox";
    if (el.hasAttribute("onclick") || el.getAttribute("tabindex") === "0") return "button";
    return ROLE_BY_TAG[tag] || "";
  }

  function textOf(el) {
    return (el.innerText != null ? el.innerText : el.textContent) || "";
  }

  function nameOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return trunc(aria, 100);
    const labelled = el.getAttribute("aria-labelledby");
    if (labelled) {
      const refEl = document.getElementById(labelled);
      if (refEl) return trunc(textOf(refEl), 100);
    }
    const ph = el.getAttribute("placeholder");
    if (ph) return trunc(ph, 100);
    const title = el.getAttribute("title");
    if (title) return trunc(title, 100);
    const alt = el.getAttribute("alt");
    if (alt) return trunc(alt, 100);
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      if (sensitiveType(el)) return trunc(el.getAttribute("name") || el.id || "[SENSITIVE]", 100);
      if (el.value) return trunc(el.value, 100);
      return trunc(el.getAttribute("name") || el.id || "", 100);
    }
    return trunc(textOf(el), 100);
  }

  const elements = [];
  const entries = [];
  let nextRef = startIndex;

  function walk(node, depth, inShadow) {
    if (depth > maxDepth || entries.length >= maxLines) return;
    if (!node || node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template" ||
        tag === "meta" || tag === "link" || tag === "head" || tag === "br" || tag === "hr") return;
    if (!isVisible(node)) return;

    if (tag === "iframe") {
      const iframeTitle = trunc(node.getAttribute("title") || node.getAttribute("name") || node.getAttribute("src") || "iframe", 80);
      entries.push({ kind: "iframe", depth, line: `- iframe "${iframeTitle}"` });
      return;
    }

    const indent = "  ".repeat(Math.min(depth, 10));
    const role = roleOf(node);
    const interactive = !!INTERACTIVE_TAGS[node.tagName] || !!node.isContentEditable || (role && role !== "label");

    if (interactive && elements.length < maxRefs) {
      const ref = "e" + (nextRef++);
      const sens = sensitiveType(node);
      const name = nameOf(node);
      let line = indent + "- " + (role || "element") + ' "' + name + '" [ref=' + ref + "]";
      if (inShadow) line += " [shadow]";
      if (tag === "input") {
        const type = String(node.getAttribute("type") || "text").toLowerCase();
        const val = sens ? "[REDACTED]" : trunc(node.value, 60);
        line += " type=" + type + ' value="' + val + '"';
        if (sens) line += " sensitive=" + sens;
        if (node.checked) line += " checked";
        if (node.disabled) line += " disabled";
        if (node.required) line += " required";
      } else if (tag === "select") {
        const opts = [];
        for (let i = 0; i < Math.min(node.options.length, 8); i++) opts.push(node.options[i].value);
        line += ' value="' + trunc(node.value, 40) + '" options=[' + opts.join(", ") + (node.options.length > 8 ? ", …" : "") + "]";
      } else if (tag === "textarea") {
        const val = sens ? "[REDACTED]" : trunc(node.value, 60);
        line += ' value="' + val + '"';
        if (sens) line += " sensitive=" + sens;
      } else if (tag === "a" && node.getAttribute("href")) {
        line += ' href="' + trunc(node.getAttribute("href"), 80) + '"';
      }
      if (node.disabled && tag !== "input") line += " disabled";
      elements.push({ el: node, ref, tag, role, name, sensitive: sens });
      entries.push({ kind: "node", depth, line });
    } else if (!interactiveOnly && /^h[1-6]$/.test(tag)) {
      const ht = trunc(textOf(node), 120);
      if (ht) entries.push({ kind: "node", depth, line: indent + "- heading[h" + tag.slice(1) + "] " + ht });
    } else if (!compact && !interactiveOnly && !node.children.length && !node.shadowRoot) {
      const t = trunc(textOf(node), 160);
      if (t) entries.push({ kind: "node", depth, line: indent + "- text: " + t });
    }

    if (node.shadowRoot) {
      const sKids = node.shadowRoot.children;
      for (let s = 0; s < sKids.length; s++) walk(sKids[s], depth + 1, true);
    }
    const kids = node.children;
    for (let k = 0; k < kids.length; k++) walk(kids[k], depth + 1, inShadow);
  }

  if (document.body) {
    const kids = document.body.children;
    for (let i = 0; i < kids.length; i++) walk(kids[i], 0, false);
  }

  globalThis.__agbbLastSnapshot = elements;
  return {
    lines: entries.map((e) => e.line),
    meta: elements.map((e, i) => ({ idx: i, ref: e.ref, tag: e.tag, role: e.role, name: e.name, sensitive: e.sensitive })),
    nextRef,
  };
};

function createEngineError(code, message, payload = null) {
  const err = new Error(message);
  err.code = code;
  if (payload) err.payload = payload;
  return err;
}

function normalizeUrlPath(raw) {
  try {
    return new URL(String(raw || "")).pathname.toLowerCase();
  } catch {
    return "";
  }
}

class IsolatedEngine {
  constructor(opts = {}) {
    this.profileDir = path.resolve(opts.profileDir || getDefaultProfileDir());
    this.authStatesDir = path.join(path.dirname(this.profileDir), "auth-states");
    this.fallbackStatePath = path.join(path.dirname(this.profileDir), "isolated-storage-state.json");
    this.searchEngine = opts.searchEngine || "https://www.bing.com/search?q=";
    this.log = opts.log || (() => {});

    this.context = null;
    this.contextKind = "none"; // "persistent" | "ephemeral"
    this.launchPromise = null;
    this.authWindowContext = null;
    this.authWindowInfo = null;
    this.browserKind = "edge";
    this.executablePath = "";
    this.headless = true;

    this.nextTabId = 1;
    this.pages = new Map(); // tabId -> PageRecord
    this.sessions = new Map(); // sessionId -> { activeTabId, tabIds: Set<number> }
    this.screenshotHelperPage = null;
  }

  getBrowserInfo(args = {}) {
    const resolved = resolveBrowser({
      browser: args.browser || "edge",
      executablePath: args.executablePath,
    });
    return resolved;
  }

  ensureSession(sessionId) {
    const sid = sanitizeKey(sessionId, "default");
    if (!this.sessions.has(sid)) {
      this.sessions.set(sid, { id: sid, activeTabId: null, tabIds: new Set(), explicitVisible: false });
    }
    return this.sessions.get(sid);
  }

  _buildConflictPayload(sid, wantHeadless, extra = {}) {
    const waitingAuth = !!extra.awaitingAuth;
    const msg = waitingAuth
      ? "当前正在可见认证窗口等待用户登录，后台请求不得在未完成前继续并宣称后台成功。"
      : (this.headless === false
        ? "当前 isolated 实例正以可见窗口（headless:false）运行，后台请求不得复用可见实例或关闭其他任务的窗口。"
        : "当前 isolated 实例正以后台无头（headless:true）运行，与请求 headless:false 冲突，不关闭现有后台实例。");
    const recovery = waitingAuth
      ? [
          "等待用户完成登录并关闭可见认证窗口；",
          "或登录完成后显式调用 browser_open_auth_window(action='complete') 恢复后台无头模式。",
        ]
      : (this.headless === false
        ? [
            "等待当前可见会话完成后再执行后台任务，或使用独立 AG_BRIDGE_PROFILE_DIR；",
            "若确实要操作可见窗口，请在同一会话通过 browser_launch(headless:false) 或显式 mode='extension' 执行。",
          ]
        : [
            "如需一次性手动登录/2FA，请改用 browser_open_auth_window(action='open', url=...)；",
            "如需操作日常可见浏览器，请显式传入 mode='extension'。",
          ]);
    return {
      ok: false,
      code: "MODE_CONFLICT",
      conflict: true,
      status: waitingAuth ? "awaiting_auth_window" : undefined,
      mode: "isolated",
      currentMode: "isolated",
      currentHeadless: waitingAuth ? false : this.headless,
      requestedMode: "isolated",
      requestedHeadless: wantHeadless,
      sessionId: sid,
      instanceReused: false,
      authWindow: waitingAuth ? this.authWindowInfo : undefined,
      recovery,
      error: msg,
    };
  }

  async ensureLaunched(args = {}, opts = {}) {
    const sid = sanitizeKey(args.sessionId, "default");
    const sess = this.ensureSession(sid);
    const wantHeadless = opts.fromLaunch
      ? (args.headless !== false)
      : (typeof args.headless === "boolean" ? args.headless : !sess.explicitVisible);

    if (this.context) {
      let alive = false;
      try {
        this.context.pages();
        alive = true;
      } catch (e) {
        this.context = null;
      }
      if (alive) {
        if (this.headless !== wantHeadless) {
          const payload = this._buildConflictPayload(sid, wantHeadless);
          throw createEngineError("MODE_CONFLICT", payload.error, payload);
        }
        return {
          ok: true,
          launched: false,
          instanceReused: true,
          headless: this.headless,
          stage: "already-running",
        };
      }
    }
    if (this.authWindowContext) {
      const payload = this._buildConflictPayload(sid, wantHeadless, { awaitingAuth: true });
      throw createEngineError("MODE_CONFLICT", payload.error, payload);
    }
    if (this.launchPromise) {
      await this.launchPromise;
      if (this.context && this.headless !== wantHeadless) {
        const payload = this._buildConflictPayload(sid, wantHeadless);
        throw createEngineError("MODE_CONFLICT", payload.error, payload);
      }
      return {
        ok: true,
        launched: false,
        instanceReused: true,
        headless: this.headless,
        stage: "already-running",
      };
    }

    this.launchPromise = this._launchInternal(args).finally(() => {
      this.launchPromise = null;
    });
    return await this.launchPromise;
  }

  async _launchInternal(args = {}) {
    const resolved = this.getBrowserInfo(args);
    if (resolved.error) {
      throw new Error(resolved.error.message);
    }
    if (!resolved.exists) {
      throw new Error(`找不到 ${resolved.browser} 可执行文件：${resolved.exe}`);
    }
    this.browserKind = resolved.browser;
    this.executablePath = resolved.exe;
    fs.mkdirSync(this.profileDir, { recursive: true });
    fs.mkdirSync(this.authStatesDir, { recursive: true });

    const headless = args.headless !== false;
    this.headless = headless;
    const launchArgs = [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    ];
    if (headless) launchArgs.push("--headless=new");

    try {
      this.context = await chromium.launchPersistentContext(this.profileDir, {
        executablePath: resolved.exe,
        headless,
        args: launchArgs,
        viewport: DEFAULT_VIEWPORT,
        deviceScaleFactor: 1,
        acceptDownloads: true,
      });
      this.contextKind = "persistent";
    } catch (err) {
      // 若孤立 profile 被另一进程占用，自动回退到独立 session profile + storageState 副本，保证并发零崩溃
      const msg = String((err && err.message) || err);
      if (/ProcessSingleton|SingletonLock|used by another|profile.*in use|Target page, context or browser has been closed/i.test(msg)) {
        const subProfile = path.join(path.dirname(this.profileDir), "sessions", "proc-" + process.pid);
        fs.mkdirSync(subProfile, { recursive: true });
        this.context = await chromium.launchPersistentContext(subProfile, {
          executablePath: resolved.exe,
          headless,
          args: launchArgs,
          viewport: DEFAULT_VIEWPORT,
          deviceScaleFactor: 1,
          acceptDownloads: true,
        });
        this.contextKind = "session-fallback";
        await this._seedFallbackCookies();
      } else {
        throw err;
      }
    }

    this.context.on("close", () => {
      this.context = null;
      this.screenshotHelperPage = null;
      for (const rec of this.pages.values()) {
        this._disposeRefs(rec);
      }
      this.pages.clear();
      for (const sess of this.sessions.values()) {
        sess.activeTabId = null;
        sess.tabIds.clear();
        sess.explicitVisible = false;
      }
    });

    // 注册已存在的空白页
    for (const p of this.context.pages()) {
      this._registerPage(p, "default");
    }

    if (!headless) {
      this.ensureSession(args && args.sessionId).explicitVisible = true;
    }

    return { ok: true, launched: true, instanceReused: false, headless: this.headless, stage: "connected" };
  }

  async _seedFallbackCookies() {
    if (!this.context || !fs.existsSync(this.fallbackStatePath)) return;
    try {
      const state = JSON.parse(fs.readFileSync(this.fallbackStatePath, "utf8"));
      if (Array.isArray(state.cookies) && state.cookies.length) {
        await this.context.addCookies(state.cookies);
      }
    } catch (e) { /* ignore corrupt seed */ }
  }

  async _persistStorageState() {
    if (!this.context) return null;
    try {
      fs.mkdirSync(path.dirname(this.fallbackStatePath), { recursive: true });
      const state = await this.context.storageState();
      fs.writeFileSync(this.fallbackStatePath, JSON.stringify(state, null, 2), "utf8");
      return state;
    } catch (e) {
      return null;
    }
  }

  _registerPage(page, sessionId) {
    for (const rec of this.pages.values()) {
      if (rec.page === page) return rec;
    }
    const id = this.nextTabId++;
    const sid = sanitizeKey(sessionId, "default");
    const rec = {
      id,
      sessionId: sid,
      page,
      console: [],
      network: [],
      dialogs: [],
      refs: new Map(), // ref -> { handle, frame, tag, role, name, sensitive }
      snapshotId: null,
    };
    this.pages.set(id, rec);

    const sess = this.ensureSession(sid);
    sess.tabIds.add(id);
    if (sess.activeTabId == null) sess.activeTabId = id;

    page.on("console", (msg) => {
      rec.console.push({
        at: Date.now(),
        level: msg.type(),
        text: msg.text().slice(0, 1000),
      });
      if (rec.console.length > MAX_LOG_ENTRIES) rec.console.shift();
    });
    page.on("pageerror", (err) => {
      rec.console.push({
        at: Date.now(),
        level: "error",
        text: String((err && err.message) || err).slice(0, 1000),
      });
      if (rec.console.length > MAX_LOG_ENTRIES) rec.console.shift();
    });
    page.on("requestfailed", (req) => {
      rec.network.push({
        at: Date.now(),
        status: "failed",
        method: req.method(),
        url: req.url().slice(0, 500),
        error: (req.failure() && req.failure().errorText) || "failed",
      });
      if (rec.network.length > MAX_LOG_ENTRIES) rec.network.shift();
    });
    page.on("response", (res) => {
      rec.network.push({
        at: Date.now(),
        status: res.status(),
        method: res.request().method(),
        url: res.url().slice(0, 500),
      });
      if (rec.network.length > MAX_LOG_ENTRIES) rec.network.shift();
    });
    page.on("dialog", async (dialog) => {
      const entry = {
        at: Date.now(),
        type: dialog.type(),
        message: dialog.message().slice(0, 500),
        defaultValue: dialog.defaultValue(),
        handled: "dismiss",
      };
      rec.dialogs.push(entry);
      if (rec.dialogs.length > 50) rec.dialogs.shift();
      try { await dialog.dismiss(); } catch (e) { /* ignore */ }
    });
    page.on("close", () => {
      this._disposeRefs(rec);
      this.pages.delete(id);
      const s = this.sessions.get(rec.sessionId);
      if (s) {
        s.tabIds.delete(id);
        if (s.activeTabId === id) {
          const next = Array.from(s.tabIds)[0];
          s.activeTabId = next != null ? next : null;
        }
      }
    });

    return rec;
  }

  _disposeRefs(rec) {
    if (!rec || !rec.refs) return;
    for (const item of rec.refs.values()) {
      if (item && item.handle && typeof item.handle.dispose === "function") {
        item.handle.dispose().catch(() => {});
      }
    }
    rec.refs.clear();
  }

  async getOrCreatePage(args = {}, opts = {}) {
    await this.ensureLaunched(args);
    const sid = sanitizeKey(args.sessionId, "default");
    const sess = this.ensureSession(sid);

    if (args.tabId != null) {
      const found = this.pages.get(Number(args.tabId));
      if (!found || found.page.isClosed()) {
        throw new Error(`找不到标签页 tabId=${args.tabId}`);
      }
      return found;
    }

    if (!opts.newTab && sess.activeTabId != null) {
      const cur = this.pages.get(sess.activeTabId);
      if (cur && !cur.page.isClosed()) return cur;
    }

    // 复用 default 会话里未打开其他站点的初始 about:blank，避免多开空标签
    if (!opts.newTab && sid !== "default") {
      const p = await this.context.newPage();
      return this._registerPage(p, sid);
    }

    if (!opts.newTab) {
      for (const rec of this.pages.values()) {
        if (!rec.page.isClosed() && rec.sessionId === "default" && rec.page !== this.screenshotHelperPage) {
          sess.activeTabId = rec.id;
          return rec;
        }
      }
    }

    const p = await this.context.newPage();
    const rec = this._registerPage(p, sid);
    sess.activeTabId = rec.id;
    return rec;
  }

  async _detectPendingGate(page, response, requestedUrl) {
    try {
      const status = response && typeof response.status === "function" ? response.status() : 200;
      const finalUrl = page.url();
      const info = await page.evaluate(() => {
        const title = String(document.title || "");
        const bodyText = String((document.body && document.body.innerText) || "").slice(0, 1200);
        const hasCaptchaWidget = !!(
          document.querySelector(
            '[class*="cf-turnstile"], iframe[src*="challenges.cloudflare.com"], .g-recaptcha, iframe[src*="recaptcha"], .h-captcha, iframe[src*="hcaptcha"], .geetest_holder, #nc_1_n1z'
          )
        );
        return { title, bodyText, hasCaptchaWidget };
      }).catch(() => ({ title: "", bodyText: "", hasCaptchaWidget: false }));

      const captchaRe = /just a moment|verify you are human|security check|captcha|请完成安全验证|安全验证|人机验证|滑动验证|拖动滑块/i;
      if (info.hasCaptchaWidget || captchaRe.test(info.title) || captchaRe.test(info.bodyText)) {
        return {
          status: "pending_captcha",
          requiresUserAction: true,
          pendingReason: "captcha_required",
          autoOpenedAuthWindow: false,
          recovery: "检测到验证码/人机校验，已暂停继续操作；请由用户亲自完成验证，切勿尝试自动绕过或求解验证码。",
        };
      }

      const reqPath = normalizeUrlPath(requestedUrl);
      const finalPath = normalizeUrlPath(finalUrl);
      const loginPathRe = /(?:^|\/)(login|signin|sign-in|auth|sso|oauth|passport)(?:\/|$)/i;
      const redirectedToLogin =
        !loginPathRe.test(reqPath) &&
        (loginPathRe.test(finalPath) || /(?:^|\.)(login|signin|passport|sso)\./i.test(finalUrl));
      if (status === 401 || status === 407 || redirectedToLogin) {
        return {
          status: "awaiting_user_login",
          requiresUserAction: true,
          pendingReason: "auth_required",
          autoOpenedAuthWindow: false,
          recovery: "检测到需要登录或登录态已失效（未自动弹窗）；如需登录，可显式调用 browser_open_auth_window(action='open', url=...) 或 browser_auth_sync。",
        };
      }
    } catch (e) { /* ignore gate check error */ }
    return null;
  }

  async _navigateWithGuard(rec, targetUrl, timeoutMs = 30000, opts = {}) {
    let response = null;
    try {
      response = await rec.page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      if (opts.waitLoadMs) {
        await rec.page.waitForLoadState("load", { timeout: opts.waitLoadMs }).catch(() => {});
      }
    } catch (e) {
      return {
        ok: false,
        code: "NAVIGATION_FAILED",
        mode: "isolated",
        headless: this.headless,
        sessionId: rec.sessionId,
        tabId: rec.id,
        url: targetUrl,
        autoOpenedAuthWindow: false,
        switchedEngine: false,
        error: `页面导航失败：${(e && e.message) || e}`,
      };
    }
    const pending = await this._detectPendingGate(rec.page, response, targetUrl);
    return {
      ok: true,
      pending,
    };
  }

  async browser_launch(args = {}) {
    const sid = sanitizeKey(args.sessionId, "default");
    const resolved = this.getBrowserInfo(args);
    if (args.dryRun) {
      const exe = resolved.error ? "" : resolved.exe;
      const wantHeadless = args.headless !== false;
      const argv = [
        "--no-first-run",
        "--no-default-browser-check",
        wantHeadless ? "--headless=new" : "",
        "--user-data-dir=" + this.profileDir,
        args.url || "about:blank",
      ].filter(Boolean);
      const ok = !resolved.error && !!resolved.exists;
      return {
        ok,
        dryRun: true,
        launched: false,
        instanceReused: false,
        stage: "dry-run",
        mode: "isolated",
        headless: wantHeadless,
        sessionId: sid,
        browser: resolved.browser || args.browser || "edge",
        executablePath: exe,
        executableExists: !!resolved.exists,
        profileDir: this.profileDir,
        profileDirectory: args.profileDirectory || null,
        url: args.url || "about:blank",
        waitConnectMs: Number(args.waitConnectMs || 8000),
        commandLine: `"${exe}" ${argv.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ")}`,
        error: ok ? undefined : ((resolved.error && resolved.error.message) || `找不到 ${resolved.browser} 可执行文件：${exe}`),
        message: "dry-run（isolated 无头后台模式）：仅校验参数，未启动浏览器。",
      };
    }

    const launchRes = await this.ensureLaunched(args, { fromLaunch: true });
    const rec = await this.getOrCreatePage(args);
    let pending = null;
    if (args.url && args.url !== "about:blank") {
      const targetUrl = normalizeUrl(args.url, this.searchEngine);
      const nav = await this._navigateWithGuard(rec, targetUrl, 25000);
      if (!nav.ok) {
        return Object.assign(nav, {
          launched: launchRes.launched,
          instanceReused: !!launchRes.instanceReused,
          stage: launchRes.stage,
          browser: this.browserKind,
          executablePath: this.executablePath,
          profileDir: this.profileDir,
        });
      }
      pending = nav.pending;
    }
    return Object.assign({
      ok: true,
      mode: "isolated",
      engine: "playwright-core",
      headless: this.headless,
      launched: launchRes.launched,
      instanceReused: !!launchRes.instanceReused,
      stage: launchRes.stage,
      browser: this.browserKind,
      executablePath: this.executablePath,
      profileDir: this.profileDir,
      sessionId: rec.sessionId,
      tabId: rec.id,
      url: rec.page.url(),
      title: await rec.page.title().catch(() => ""),
      message: this.headless
        ? "独立无头浏览器引擎已就绪：零黄条、零抢焦点、支持多会话并发。"
        : "独立可见 isolated 浏览器已就绪。",
    }, pending ? pending : {});
  }

  async browser_status(args = {}) {
    const sid = sanitizeKey(args.sessionId, "default");
    const sess = this.sessions.get(sid);
    const active = sess && sess.activeTabId != null ? this.pages.get(sess.activeTabId) : null;
    const tabs = Array.from(this.pages.values())
      .filter((r) => r.page !== this.screenshotHelperPage && !r.page.isClosed())
      .map((r) => ({
        id: r.id,
        sessionId: r.sessionId,
        url: r.page.url(),
      }));
    const actualHeadless = this.authWindowContext ? false : this.headless;
    return {
      ok: true,
      mode: "isolated",
      engine: "playwright-core",
      state: this.context ? "running" : (this.authWindowContext ? "awaiting_auth_window" : "standby"),
      browser: this.browserKind,
      headless: actualHeadless,
      instanceReused: !!this.context,
      contextKind: this.contextKind,
      profileDir: this.profileDir,
      sessionId: sid,
      tabs: tabs.length,
      activeTab: active && !active.page.isClosed()
        ? { id: active.id, sessionId: active.sessionId, url: active.page.url(), title: await active.page.title().catch(() => "") }
        : null,
      tabList: tabs,
      authWindow: this.authWindowInfo,
    };
  }

  async browser_tabs(args = {}) {
    const launchRes = await this.ensureLaunched(args);
    const sid = sanitizeKey(args.sessionId, "default");
    const sess = this.ensureSession(sid);
    const action = args.action || "list";

    if (action === "list") {
      const list = [];
      for (const r of this.pages.values()) {
        if (r.page.isClosed() || r.page === this.screenshotHelperPage) continue;
        list.push({
          id: r.id,
          sessionId: r.sessionId,
          active: sess.activeTabId === r.id,
          url: r.page.url(),
          title: await r.page.title().catch(() => ""),
        });
      }
      return { ok: true, mode: "isolated", headless: this.headless, instanceReused: !!launchRes.instanceReused, sessionId: sid, count: list.length, activeTabId: sess.activeTabId, tabs: list };
    }

    if (action === "new") {
      const rec = await this.getOrCreatePage(args, { newTab: true });
      const url = normalizeUrl(args.url || "about:blank", this.searchEngine);
      let pending = null;
      if (url !== "about:blank") {
        const nav = await this._navigateWithGuard(rec, url, 25000);
        if (!nav.ok) {
          return Object.assign(nav, { created: rec.id, instanceReused: !!launchRes.instanceReused });
        }
        pending = nav.pending;
      }
      return Object.assign({
        ok: true,
        mode: "isolated",
        headless: this.headless,
        instanceReused: !!launchRes.instanceReused,
        sessionId: sid,
        created: rec.id,
        tabId: rec.id,
        url: rec.page.url(),
        title: await rec.page.title().catch(() => ""),
      }, pending ? pending : {});
    }

    if (action === "activate") {
      const rec = await this.getOrCreatePage(args);
      sess.activeTabId = rec.id;
      return { ok: true, mode: "isolated", headless: this.headless, instanceReused: !!launchRes.instanceReused, sessionId: sid, activated: rec.id, url: rec.page.url(), title: await rec.page.title().catch(() => "") };
    }

    if (action === "close") {
      const rec = await this.getOrCreatePage(args);
      const closed = { id: rec.id, url: rec.page.url() };
      await rec.page.close();
      return { ok: true, mode: "isolated", headless: this.headless, instanceReused: !!launchRes.instanceReused, sessionId: sid, closed };
    }

    throw new Error("未知 action：" + action + "（可选 list / activate / close / new）");
  }

  async browser_open(args = {}) {
    if (!args.url) throw new Error("browser_open 需要 url 参数");
    const hadContext = !!this.context;
    const rec = await this.getOrCreatePage(args, { newTab: !!args.newTab });
    const sess = this.ensureSession(rec.sessionId);
    sess.activeTabId = rec.id;
    const url = normalizeUrl(args.url, this.searchEngine);
    const nav = await this._navigateWithGuard(rec, url, 30000, { waitLoadMs: 3000 });
    if (!nav.ok) {
      return Object.assign(nav, { instanceReused: hadContext });
    }
    return Object.assign({
      ok: true,
      mode: "isolated",
      headless: this.headless,
      instanceReused: hadContext,
      sessionId: rec.sessionId,
      tabId: rec.id,
      url: rec.page.url(),
      title: await rec.page.title().catch(() => ""),
      interpretedAs: url,
      note: url === String(args.url) ? undefined : "输入不像 URL，已按搜索处理",
    }, nav.pending ? nav.pending : {});
  }

  async browser_history(args = {}) {
    const rec = await this.getOrCreatePage(args);
    const action = args.action || "reload";
    if (action === "back") await rec.page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 });
    else if (action === "forward") await rec.page.goForward({ waitUntil: "domcontentloaded", timeout: 15000 });
    else if (action === "reload") await rec.page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
    else throw new Error("未知 action：" + action + "（可选 back / forward / reload）");
    return {
      ok: true,
      mode: "isolated",
      action,
      sessionId: rec.sessionId,
      tabId: rec.id,
      url: rec.page.url(),
      title: await rec.page.title().catch(() => ""),
    };
  }

  async browser_snapshot(args = {}) {
    const rec = await this.getOrCreatePage(args);
    const compact = args.compact === true || args.mode === "compact";
    const maxChars = Number(args.maxChars || (compact ? 6000 : 12000));
    const maxDepth = Number(args.maxDepth || 40);
    const interactiveOnly = args.interactiveOnly === true;

    this._disposeRefs(rec);
    const outLines = [];
    let nextRef = 1;
    let totalChars = 0;
    let truncated = false;

    const pushLine = (line) => {
      if (truncated) return;
      if (totalChars + line.length + 1 > maxChars) {
        truncated = true;
        return;
      }
      totalChars += line.length + 1;
      outLines.push(line);
    };

    const walkFrame = async (frame, frameIndent) => {
      if (truncated || rec.refs.size >= MAX_SNAPSHOT_REFS) return;
      let res;
      try {
        res = await frame.evaluate(FRAME_WALKER_FN, {
          compact,
          interactiveOnly,
          maxDepth,
          startIndex: nextRef,
          maxRefs: MAX_SNAPSHOT_REFS - rec.refs.size,
          maxLines: 500,
        });
      } catch (e) {
        return; // detached or navigating frame
      }
      if (!res) return;
      nextRef = res.nextRef || nextRef;

      // 提取 ElementHandle 引用以原生支持跨 iframe + Shadow DOM 操作
      let listHandle = null;
      try {
        listHandle = await frame.evaluateHandle(() => globalThis.__agbbLastSnapshot || []);
        for (const m of (res.meta || [])) {
          const itemHandle = await listHandle.getProperty(String(m.idx));
          const elHandle = await itemHandle.getProperty("el");
          await itemHandle.dispose();
          const element = elHandle.asElement();
          if (element) {
            rec.refs.set(m.ref, {
              handle: element,
              frame,
              tag: m.tag,
              role: m.role,
              name: m.name,
              sensitive: m.sensitive,
            });
          } else {
            await elHandle.dispose();
          }
        }
      } catch (e) {
        /* ignore transient frame detach */
      } finally {
        if (listHandle) await listHandle.dispose().catch(() => {});
      }

      for (const l of (res.lines || [])) {
        pushLine(frameIndent + l);
      }

      const children = frame.childFrames();
      for (const child of children) {
        if (truncated) break;
        const cUrl = child.url();
        if (cUrl && cUrl !== "about:blank") {
          pushLine(`${frameIndent}  [frame src="${cUrl.slice(0, 100)}"]`);
        }
        await walkFrame(child, frameIndent + "  ");
      }
    };

    await walkFrame(rec.page.mainFrame(), "");
    rec.snapshotId = "s" + Date.now().toString(36);

    return {
      ok: true,
      mode: "isolated",
      sessionId: rec.sessionId,
      tabId: rec.id,
      title: await rec.page.title().catch(() => ""),
      url: rec.page.url(),
      snapshotId: rec.snapshotId,
      refs: rec.refs.size,
      compact,
      truncated,
      dialogs: rec.dialogs.splice(0),
      snapshot: outLines.join("\n"),
    };
  }

  async _resizeImageIfNeeded(buf, mimeType, maxWidth = 1280, maxHeight = 4096) {
    if (!this.context || !buf || !buf.length) return { data: buf.toString("base64"), mimeType };
    try {
      if (!this.screenshotHelperPage || this.screenshotHelperPage.isClosed()) {
        this.screenshotHelperPage = await this.context.newPage();
      }
      const b64 = buf.toString("base64");
      const out = await this.screenshotHelperPage.evaluate(async ({ b64, mimeType, maxWidth, maxHeight }) => {
        const resp = await fetch(`data:${mimeType};base64,${b64}`);
        const blob = await resp.blob();
        const bmp = await createImageBitmap(blob);
        if (bmp.width <= maxWidth && bmp.height <= maxHeight) {
          bmp.close();
          return { resized: false, width: bmp.width, height: bmp.height };
        }
        const scale = Math.min(maxWidth / bmp.width, maxHeight / bmp.height, 1);
        const w = Math.max(1, Math.round(bmp.width * scale));
        const h = Math.max(1, Math.round(bmp.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bmp, 0, 0, w, h);
        bmp.close();
        const outUrl = canvas.toDataURL(mimeType, mimeType === "image/jpeg" ? 0.82 : undefined);
        return { resized: true, width: w, height: h, data: outUrl.split(",")[1] };
      }, { b64, mimeType, maxWidth, maxHeight });

      if (out && out.resized && out.data) {
        return { data: out.data, mimeType, width: out.width, height: out.height };
      }
    } catch (e) { /* 回退原图 */ }
    return { data: buf.toString("base64"), mimeType };
  }

  async browser_screenshot(args = {}) {
    const rec = await this.getOrCreatePage(args);
    const format = args.format === "png" ? "png" : "jpeg";
    const shotOpts = {
      type: format,
      fullPage: !!args.fullPage,
      animations: "disabled",
    };
    if (format === "jpeg") shotOpts.quality = Number(args.quality || 82);

    const raw = await rec.page.screenshot(shotOpts);
    const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
    const image = await this._resizeImageIfNeeded(raw, mimeType, 1280, 4096);
    return {
      ok: true,
      mode: "isolated",
      engine: "playwright-cdp",
      sessionId: rec.sessionId,
      tabId: rec.id,
      url: rec.page.url(),
      image,
      text: `已无头截图 ${rec.page.url()}（${args.fullPage ? "整页" : "可视区"} · ${format}）`,
    };
  }

  async _resolveTarget(rec, args = {}) {
    if (args.ref != null && args.ref !== "") {
      const entry = rec.refs.get(String(args.ref));
      if (!entry || !entry.handle) return null;
      const connected = await entry.handle.evaluate((el) => !!el.isConnected).catch(() => false);
      if (!connected) return null;
      return entry;
    }

    const frames = [rec.page.mainFrame(), ...rec.page.frames().filter((f) => f !== rec.page.mainFrame())];
    const trySelector = async (sel) => {
      for (const frame of frames) {
        try {
          const handle = await frame.$(sel);
          if (handle) {
            const meta = await handle.evaluate((el) => {
              const type = String(el.getAttribute("type") || "").toLowerCase();
              const ac = String(el.getAttribute("autocomplete") || "").toLowerCase();
              const metaStr = [el.getAttribute("name") || "", el.id || "", el.getAttribute("aria-label") || "", el.getAttribute("placeholder") || ""].join(" ");
              return { tag: el.tagName.toLowerCase(), type, ac, metaStr };
            });
            const sensitive = this._checkSensitiveMeta(meta);
            return { handle, frame, tag: meta.tag, sensitive };
          }
        } catch (e) { /* continue */ }
      }
      return null;
    };

    if (args.selector) {
      const hit = await trySelector(args.selector);
      if (hit) return hit;
    }
    if (Array.isArray(args.fallbacks)) {
      for (const fb of args.fallbacks) {
        if (!fb) continue;
        const hit = await trySelector(fb);
        if (hit) return hit;
      }
    }
    if (args.text) {
      const nth = Math.max(0, Number(args.nth || 0));
      const pattern = new RegExp(escapeRegExp(args.text), "i");
      const candidates = [];
      for (const frame of frames) {
        try {
          const loc = frame.locator("a,button,input,select,textarea,summary,[role],h1,h2,h3,h4,li,td,span,div,p")
            .filter({ hasText: pattern });
          const count = await loc.count();
          for (let i = 0; i < Math.min(count, 20); i++) {
            const handle = await loc.nth(i).elementHandle();
            if (!handle) continue;
            const visible = await handle.isVisible().catch(() => false);
            if (!visible) { await handle.dispose().catch(() => {}); continue; }
            const len = await handle.evaluate((el) => (el.innerText || el.textContent || "").length).catch(() => 9999);
            candidates.push({ handle, frame, len });
          }
          if (candidates.length) break;
        } catch (e) { /* continue */ }
      }
      if (candidates.length) {
        candidates.sort((a, b) => a.len - b.len);
        const picked = candidates[Math.min(nth, candidates.length - 1)];
        for (const c of candidates) {
          if (c !== picked) await c.handle.dispose().catch(() => {});
        }
        const meta = await picked.handle.evaluate((el) => ({
          tag: el.tagName.toLowerCase(),
          type: String(el.getAttribute("type") || "").toLowerCase(),
          ac: String(el.getAttribute("autocomplete") || "").toLowerCase(),
          metaStr: [el.getAttribute("name") || "", el.id || "", el.getAttribute("aria-label") || "", el.getAttribute("placeholder") || ""].join(" "),
        }));
        return { handle: picked.handle, frame: picked.frame, tag: meta.tag, sensitive: this._checkSensitiveMeta(meta) };
      }
    }
    return null;
  }

  _checkSensitiveMeta(meta) {
    if (!meta || (meta.tag !== "input" && meta.tag !== "textarea")) return false;
    if (meta.type === "password") return "password";
    if (meta.ac.includes("current-password") || meta.ac.includes("new-password")) return "password";
    if (meta.ac.includes("one-time-code") || meta.ac.includes("cc-number") || meta.ac.includes("cc-csc") || meta.ac.includes("cc-exp")) return "sensitive";
    if (SENSITIVE_NAME_RE.test(meta.metaStr || "")) return "sensitive";
    return false;
  }

  async _isFocusedSensitive(page) {
    return await page.evaluate(() => {
      let el = document.activeElement;
      while (el) {
        if (el.shadowRoot && el.shadowRoot.activeElement) {
          el = el.shadowRoot.activeElement;
          continue;
        }
        if (el.tagName === "IFRAME") {
          try {
            if (el.contentDocument && el.contentDocument.activeElement) {
              el = el.contentDocument.activeElement;
              continue;
            }
          } catch (e) { break; }
        }
        break;
      }
      if (!el || !el.tagName) return false;
      const tag = el.tagName.toLowerCase();
      if (tag !== "input" && tag !== "textarea") return false;
      const type = String(el.getAttribute("type") || "").toLowerCase();
      if (type === "password") return "password";
      const ac = String(el.getAttribute("autocomplete") || "").toLowerCase();
      if (ac.includes("current-password") || ac.includes("new-password")) return "password";
      if (ac.includes("one-time-code") || ac.includes("cc-number") || ac.includes("cc-csc")) return "sensitive";
      const meta = [el.getAttribute("name") || "", el.id || "", el.getAttribute("aria-label") || "", el.getAttribute("placeholder") || ""].join(" ");
      return /(?:password|passwd|pwd|passcode|otp|one.?time.?code|pin.?code|cvv|cvc|card.?num|credit.?card|cc.?num|cc.?csc|银行卡|密码|支付密码|交易密码|验证码|口令)/i.test(meta)
        ? "sensitive" : false;
    }).catch(() => false);
  }

  async browser_click(args = {}) {
    const rec = await this.getOrCreatePage(args);
    const beforeDialogs = rec.dialogs.length;
    if (args.x != null && args.y != null) {
      await rec.page.mouse.click(Number(args.x), Number(args.y), {
        button: args.button || "left",
        clickCount: Number(args.clickCount || 1),
      });
      return {
        ok: true,
        mode: "isolated",
        engine: "playwright-cdp",
        sessionId: rec.sessionId,
        tabId: rec.id,
        x: Number(args.x),
        y: Number(args.y),
        dialogs: rec.dialogs.slice(beforeDialogs),
      };
    }

    const target = await this._resolveTarget(rec, args);
    if (!target) {
      return { ok: false, tabId: rec.id, error: `未找到目标元素：${args.ref || args.selector || args.text || "(未指定)"}` };
    }
    await target.handle.scrollIntoViewIfNeeded().catch(() => {});
    const box = await target.handle.boundingBox().catch(() => null);
    await target.handle.click({
      button: args.button || "left",
      clickCount: Number(args.clickCount || 1),
      timeout: 15000,
    });
    return {
      ok: true,
      mode: "isolated",
      engine: "playwright-cdp",
      sessionId: rec.sessionId,
      tabId: rec.id,
      x: box ? Math.round(box.x + box.width / 2) : null,
      y: box ? Math.round(box.y + box.height / 2) : null,
      dialogs: rec.dialogs.slice(beforeDialogs),
    };
  }

  async browser_type(args = {}) {
    if (args.text == null) throw new Error("browser_type 需要 text 参数");
    const rec = await this.getOrCreatePage(args);
    const target = await this._resolveTarget(rec, {
      ref: args.ref,
      selector: args.selector,
      fallbacks: args.fallbacks,
      text: args.textTarget,
      nth: args.nth,
    });
    if (!target) {
      return { ok: false, tabId: rec.id, error: `未找到目标元素：${args.ref || args.selector || args.textTarget || "(未指定)"}` };
    }
    if (target.sensitive && !args.allowSensitive) {
      return {
        ok: false,
        blocked: target.sensitive === "password" ? "password-field" : "sensitive-field",
        tabId: rec.id,
        error: "安全策略拒绝向敏感字段（密码/验证码/银行卡）写入内容；如需用户登录请使用 browser_open_auth_window",
      };
    }

    await target.handle.scrollIntoViewIfNeeded().catch(() => {});
    await target.handle.focus();
    const clear = args.clear !== false;
    const text = String(args.text);

    if (args.realKeys) {
      if (clear) {
        await rec.page.keyboard.press("Control+a");
        await rec.page.keyboard.press("Backspace");
      }
      await rec.page.keyboard.type(text, { delay: 12 });
    } else if (clear) {
      const canFill = await target.handle.evaluate((el) => {
        const tag = el.tagName.toLowerCase();
        return tag === "input" || tag === "textarea" || !!el.isContentEditable;
      }).catch(() => true);
      if (canFill) {
        await target.handle.fill(text);
      } else {
        await rec.page.keyboard.insertText(text);
      }
    } else {
      await target.handle.evaluate((el) => {
        if (typeof el.setSelectionRange === "function" && typeof el.value === "string") {
          el.setSelectionRange(el.value.length, el.value.length);
        }
      }).catch(() => {});
      await rec.page.keyboard.insertText(text);
    }

    if (args.submit) {
      await rec.page.keyboard.press("Enter");
    }

    const afterVal = await target.handle.evaluate((el) => {
      if (el.tagName && el.tagName.toLowerCase() === "input" || el.tagName.toLowerCase() === "textarea") return String(el.value || "");
      return String(el.textContent || "");
    }).catch(() => "");

    return {
      ok: true,
      mode: "isolated",
      sessionId: rec.sessionId,
      tabId: rec.id,
      tag: target.tag,
      value: target.sensitive ? "[REDACTED]" : afterVal.slice(0, 200),
      changed: true,
    };
  }

  async browser_press(args = {}) {
    if (!args.key) throw new Error("browser_press 需要 key 参数");
    const rec = await this.getOrCreatePage(args);
    if (args.ref || args.selector) {
      const target = await this._resolveTarget(rec, args);
      if (!target) return { ok: false, tabId: rec.id, error: `未找到目标元素：${args.ref || args.selector}` };
      await target.handle.focus();
    }
    const sens = await this._isFocusedSensitive(rec.page);
    const key = String(args.key) === "Space" ? " " : String(args.key);
    if (sens && !args.allowSensitive && (key.length === 1 || ["Backspace", "Delete", " ", "Space"].includes(key))) {
      return {
        ok: false,
        blocked: sens === "password" ? "password-field" : "sensitive-field",
        tabId: rec.id,
        error: "安全策略拒绝向敏感字段发送字符输入",
      };
    }
    await rec.page.keyboard.press(key);
    return { ok: true, mode: "isolated", engine: "playwright-cdp", sessionId: rec.sessionId, tabId: rec.id, key: args.key };
  }

  async browser_hover(args = {}) {
    const rec = await this.getOrCreatePage(args);
    const target = await this._resolveTarget(rec, args);
    if (!target) return { ok: false, tabId: rec.id, error: `未找到目标元素：${args.ref || args.selector || args.text}` };
    await target.handle.scrollIntoViewIfNeeded().catch(() => {});
    const box = await target.handle.boundingBox().catch(() => null);
    await target.handle.hover();
    return {
      ok: true,
      mode: "isolated",
      engine: "playwright-cdp",
      sessionId: rec.sessionId,
      tabId: rec.id,
      x: box ? Math.round(box.x + box.width / 2) : null,
      y: box ? Math.round(box.y + box.height / 2) : null,
    };
  }

  async browser_scroll(args = {}) {
    const rec = await this.getOrCreatePage(args);
    let dx = args.deltaX != null ? Number(args.deltaX) : null;
    let dy = args.deltaY != null ? Number(args.deltaY) : null;
    const hasExplicitScroll = dx != null || dy != null || args.direction != null || args.amount != null;
    if (dx == null && dy == null) {
      const amount = Number(args.amount || 800);
      const dir = args.direction || "down";
      dy = dir === "up" ? -amount : dir === "down" ? amount : 0;
      dx = dir === "left" ? -amount : dir === "right" ? amount : 0;
    }
    dx = dx || 0;
    dy = dy || 0;

    if (args.ref || args.selector || args.text) {
      const target = await this._resolveTarget(rec, args);
      if (!target) return { ok: false, tabId: rec.id, error: `未找到目标元素：${args.ref || args.selector || args.text}` };
      await target.handle.scrollIntoViewIfNeeded().catch(() => {});
      if (hasExplicitScroll) {
        const scrolledContainer = await target.handle.evaluate((el, d) => {
          const canY = el.scrollHeight > el.clientHeight + 2;
          const canX = el.scrollWidth > el.clientWidth + 2;
          if (canY || canX) {
            el.scrollBy(d.dx, d.dy);
            return { container: true, scrollTop: Math.round(el.scrollTop), scrollLeft: Math.round(el.scrollLeft), scrollHeight: el.scrollHeight };
          }
          return { container: false };
        }, { dx, dy });
        if (!scrolledContainer.container) {
          const box = await target.handle.boundingBox().catch(() => null);
          if (box) {
            await rec.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await rec.page.mouse.wheel(dx, dy);
          }
        } else {
          return Object.assign({ ok: true, mode: "isolated", sessionId: rec.sessionId, tabId: rec.id, deltaX: dx, deltaY: dy }, scrolledContainer);
        }
      }
      const after = await rec.page.evaluate(() => ({ scrollY: Math.round(window.scrollY), scrollHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight }));
      return Object.assign({ ok: true, mode: "isolated", sessionId: rec.sessionId, tabId: rec.id, deltaX: dx, deltaY: dy }, after);
    }

    await rec.page.mouse.move(DEFAULT_VIEWPORT.width / 2, DEFAULT_VIEWPORT.height / 2);
    await rec.page.mouse.wheel(dx, dy);
    await new Promise((r) => setTimeout(r, 80));
    const after = await rec.page.evaluate(() => ({
      scrollY: Math.round(window.scrollY),
      scrollX: Math.round(window.scrollX),
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
    }));
    return Object.assign({ ok: true, mode: "isolated", sessionId: rec.sessionId, tabId: rec.id, deltaX: dx, deltaY: dy }, after);
  }

  async browser_select_option(args = {}) {
    const rec = await this.getOrCreatePage(args);
    const target = await this._resolveTarget(rec, args);
    if (!target) return { ok: false, tabId: rec.id, error: `未找到目标元素：${args.ref || args.selector}` };
    const opt = args.value != null ? { value: String(args.value) } : (args.label != null ? { label: String(args.label) } : null);
    if (!opt) return { ok: false, tabId: rec.id, error: "需要提供 value 或 label" };
    const selected = await target.handle.selectOption(opt);
    return { ok: true, mode: "isolated", sessionId: rec.sessionId, tabId: rec.id, selected };
  }

  async browser_get_text(args = {}) {
    const rec = await this.getOrCreatePage(args);
    const maxChars = Number(args.maxChars || 8000);
    let rawText = "";
    if (args.ref || args.selector || args.text) {
      const target = await this._resolveTarget(rec, args);
      if (!target) return { ok: false, tabId: rec.id, error: `未找到目标元素：${args.ref || args.selector || args.text}` };
      rawText = await target.handle.evaluate((el) => el.innerText != null ? el.innerText : (el.textContent || ""));
    } else {
      rawText = await rec.page.evaluate(() => (document.body ? (document.body.innerText || document.body.textContent || "") : ""));
    }
    const truncated = rawText.length > maxChars;
    return {
      ok: true,
      mode: "isolated",
      sessionId: rec.sessionId,
      tabId: rec.id,
      url: rec.page.url(),
      length: rawText.length,
      truncated,
      text: truncated ? rawText.slice(0, maxChars) + "…" : rawText,
    };
  }

  async browser_evaluate(args = {}) {
    if (!args.expression) throw new Error("browser_evaluate 需要 expression 参数");
    const rec = await this.getOrCreatePage(args);
    const expr = String(args.expression);
    const awaitPromise = args.awaitPromise !== false;
    const value = await rec.page.evaluate(async ({ expr, awaitPromise }) => {
      // eslint-disable-next-line no-eval
      const res = (0, eval)(expr);
      return awaitPromise && res && typeof res.then === "function" ? await res : res;
    }, { expr, awaitPromise });
    return {
      ok: true,
      mode: "isolated",
      engine: "playwright-cdp",
      sessionId: rec.sessionId,
      tabId: rec.id,
      type: typeof value,
      value,
    };
  }

  async browser_wait_for(args = {}) {
    if (!args.selector && !args.text) throw new Error("browser_wait_for 需要 selector 或 text");
    const rec = await this.getOrCreatePage(args);
    const timeoutMs = Number(args.timeoutMs || 15000);
    const started = Date.now();
    const deadline = started + timeoutMs;
    while (Date.now() < deadline) {
      const target = await this._resolveTarget(rec, { selector: args.selector, text: args.text });
      if (target) {
        const visible = await target.handle.isVisible().catch(() => false);
        if (visible) {
          const text = await target.handle.evaluate((el) => (el.innerText || el.textContent || "").trim().slice(0, 120)).catch(() => "");
          return {
            ok: true,
            mode: "isolated",
            sessionId: rec.sessionId,
            tabId: rec.id,
            kind: args.selector ? "selector" : "text",
            match: text,
            waitedMs: Date.now() - started,
          };
        }
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return { ok: false, tabId: rec.id, error: `等待超时（${timeoutMs}ms）`, waitedMs: Date.now() - started };
  }

  async browser_console(args = {}) {
    const rec = await this.getOrCreatePage(args);
    let list = rec.console.slice();
    if (args.level) list = list.filter((x) => x.level === args.level);
    const tail = list.slice(-Number(args.limit || 50));
    if (args.clear) rec.console = [];
    return { ok: true, mode: "isolated", sessionId: rec.sessionId, tabId: rec.id, count: tail.length, entries: tail };
  }

  async browser_network(args = {}) {
    const rec = await this.getOrCreatePage(args);
    let list = rec.network.slice();
    if (args.filter) {
      const f = String(args.filter).toLowerCase();
      list = list.filter((x) => String(x.url || "").toLowerCase().includes(f));
    }
    const tail = list.slice(-Number(args.limit || 50));
    if (args.clear) rec.network = [];
    return { ok: true, mode: "isolated", sessionId: rec.sessionId, tabId: rec.id, count: tail.length, entries: tail };
  }

  async browser_auth_sync(args = {}) {
    const action = args.action || "status";
    fs.mkdirSync(this.authStatesDir, { recursive: true });

    if (action === "status") {
      await this.ensureLaunched(args);
      const cookies = await this.context.cookies();
      const byDomain = {};
      for (const c of cookies) {
        const d = c.domain || "unknown";
        byDomain[d] = (byDomain[d] || 0) + 1;
      }
      const savedProfiles = fs.existsSync(this.authStatesDir)
        ? fs.readdirSync(this.authStatesDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""))
        : [];
      return {
        ok: true,
        action: "status",
        profileDir: this.profileDir,
        cookieCount: cookies.length,
        domains: byDomain,
        savedProfiles,
      };
    }

    if (action === "export") {
      await this.ensureLaunched(args);
      const name = sanitizeKey(args.name || "default", "default");
      const outPath = path.join(this.authStatesDir, name + ".json");
      const state = await this.context.storageState({ path: outPath });
      await this._persistStorageState();
      return {
        ok: true,
        action: "export",
        name,
        filePath: outPath,
        cookieCount: (state.cookies || []).length,
        originCount: (state.origins || []).length,
      };
    }

    if (action === "import") {
      await this.ensureLaunched(args);
      let imported = 0;
      if (Array.isArray(args.cookies) && args.cookies.length) {
        await this.context.addCookies(args.cookies);
        imported += args.cookies.length;
      }
      if (args.storageState && typeof args.storageState === "object") {
        if (Array.isArray(args.storageState.cookies) && args.storageState.cookies.length) {
          await this.context.addCookies(args.storageState.cookies);
          imported += args.storageState.cookies.length;
        }
      }
      if (args.storageStatePath || args.name) {
        const filePath = args.storageStatePath
          ? path.resolve(args.storageStatePath)
          : path.join(this.authStatesDir, sanitizeKey(args.name, "default") + ".json");
        const allowedBase = path.join(os.homedir(), ".gemini");
        if (!canonicalInside(this.authStatesDir, filePath) && !canonicalInside(allowedBase, filePath)) {
          return { ok: false, error: "安全策略拒绝读取 ~/.gemini 目录之外的 storageState 文件" };
        }
        if (!fs.existsSync(filePath)) {
          return { ok: false, error: "找不到登录态文件：" + filePath };
        }
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (Array.isArray(data.cookies) && data.cookies.length) {
          await this.context.addCookies(data.cookies);
          imported += data.cookies.length;
        }
      }
      await this._persistStorageState();
      return { ok: true, action: "import", importedCookies: imported };
    }

    if (action === "clear") {
      await this.ensureLaunched(args);
      if (args.domain) {
        await this.context.clearCookies({ domain: String(args.domain) });
      } else {
        await this.context.clearCookies();
      }
      await this._persistStorageState();
      return { ok: true, action: "clear", domain: args.domain || "*" };
    }

    throw new Error("未知 action：" + action + "（可选 status / import / export / clear）");
  }

  async browser_open_auth_window(args = {}) {
    const action = args.action || "open";
    if (action === "status") {
      return {
        ok: true,
        mode: "isolated",
        headless: this.authWindowContext ? false : this.headless,
        sessionId: sanitizeKey(args.sessionId, "default"),
        instanceReused: !!this.authWindowContext || !!this.context,
        action: "status",
        authWindowOpen: !!this.authWindowContext,
        authWindow: this.authWindowInfo,
        headlessActive: !!this.context,
      };
    }

    if (action === "complete") {
      const sid = sanitizeKey(args.sessionId, "default");
      if (this.authWindowContext) {
        try {
          const state = await this.authWindowContext.storageState();
          fs.mkdirSync(path.dirname(this.fallbackStatePath), { recursive: true });
          fs.writeFileSync(this.fallbackStatePath, JSON.stringify(state, null, 2), "utf8");
        } catch (e) { /* ignore */ }
        await this.authWindowContext.close().catch(() => {});
        this.authWindowContext = null;
        this.authWindowInfo = null;
      }
      await this.ensureLaunched(Object.assign({}, args, { headless: true }), { fromLaunch: true });
      return { ok: true, mode: "isolated", headless: this.headless, sessionId: sid, instanceReused: false, action: "complete", resumedHeadless: true, profileDir: this.profileDir };
    }

    // action === "open"
    const url = normalizeUrl(args.url || "https://www.bing.com", this.searchEngine);
    const resolved = this.getBrowserInfo(args);
    if (resolved.error || !resolved.exists) {
      return { ok: false, error: (resolved.error && resolved.error.message) || `找不到浏览器：${resolved.exe}` };
    }

    // 关闭无头实例释放 isolated-profile 锁，以便弹出可见窗口使用同一持久化目录
    if (this.context) {
      await this._persistStorageState();
      await this.context.close().catch(() => {});
      this.context = null;
    }

    fs.mkdirSync(this.profileDir, { recursive: true });
    const ctx = await chromium.launchPersistentContext(this.profileDir, {
      executablePath: resolved.exe,
      headless: false,
      args: ["--no-first-run", "--no-default-browser-check"],
      viewport: null,
    });
    this.authWindowContext = ctx;
    this.authWindowInfo = { openedAt: new Date().toISOString(), url, browser: resolved.browser };

    const closeDone = new Promise((resolve) => {
      ctx.once("close", () => {
        this.authWindowContext = null;
        this.authWindowInfo = null;
        resolve();
      });
    });

    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});

    if (args.waitForClose) {
      const timeoutMs = Number(args.timeoutMs || 120000);
      const closedInTime = await Promise.race([
        closeDone.then(() => true),
        new Promise((r) => setTimeout(() => r(false), timeoutMs)),
      ]);
      if (closedInTime) {
        await this.ensureLaunched(args);
        return { ok: true, action: "open", completed: true, resumedHeadless: true, url };
      }
      return {
        ok: true,
        action: "open",
        status: "awaiting_user_login",
        url,
        message: "独立登录窗口仍在打开，用户登录并关闭窗口（或调用 browser_open_auth_window(action='complete')）后即可继续后台静默操作。",
      };
    }

    return {
      ok: true,
      action: "open",
      status: "awaiting_user_login",
      url,
      profileDir: this.profileDir,
      message: "已在独立可见窗口打开登录页（不影响个人日常浏览器）。用户登录完成后关闭该窗口或调用 action='complete' 即可回到后台无头模式。",
    };
  }

  async shutdown() {
    if (this.authWindowContext) {
      await this.authWindowContext.close().catch(() => {});
      this.authWindowContext = null;
    }
    if (this.context) {
      await this._persistStorageState();
      await this.context.close().catch(() => {});
      this.context = null;
    }
  }
}

module.exports = { IsolatedEngine, getDefaultProfileDir, getMemoryBaseDir, normalizeUrl };
