/**
 * banner-page.js
 * 注入到扩展隔离世界的浏览器控制顶栏：「谷谷嘎嘎正在控制你的浏览器」。
 *
 * 约定：
 * - 固定全宽顶栏，Shadow DOM 隔离站点 CSS，pointer-events:none 不挡交互。
 * - show() 续期控制会话；默认 60 秒无新动作后淡出，避免短暂操作后提示立刻消失。
 * - 只维护自己的宿主，旧版本宿主会自动替换。
 */
(function () {
  var VERSION = "1.2.0";
  var HOST_ID = "agbb-control-banner-host";
  var HOST_TAG = "agbb-control-banner";
  var TEXT = "谷谷嘎嘎正在控制你的浏览器";
  var DEFAULT_HIDE_MS = 60000;
  var FADE_MS = 220;
  var STATE_KEY = "__AGBB_BANNER_STATE__";

  function styleText(el, decls) {
    el.style.cssText = decls.join(";");
  }

  function pulseDot(dot) {
    try {
      if (globalThis.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      if (!dot.animate) return;
      dot.animate(
        [
          { opacity: 0.55, transform: "scale(.9)", boxShadow: "0 0 0 3px rgba(56,209,106,.14)" },
          { opacity: 1, transform: "scale(1)", boxShadow: "0 0 0 5px rgba(56,209,106,.08)" },
          { opacity: 0.55, transform: "scale(.9)", boxShadow: "0 0 0 3px rgba(56,209,106,.14)" }
        ],
        { duration: 1600, iterations: Infinity, easing: "ease-in-out" }
      );
    } catch (e) { /* 不支持 WAAPI 时保持静态圆点 */ }
  }

  function clearTimers() {
    var s = globalThis[STATE_KEY];
    if (!s) return;
    if (s.hideTimer) clearTimeout(s.hideTimer);
    if (s.removeTimer) clearTimeout(s.removeTimer);
    s.hideTimer = 0;
    s.removeTimer = 0;
  }

  function hostStyle() {
    return [
      "all: initial",
      "position: fixed",
      "top: 0",
      "left: 0",
      "right: 0",
      "width: 100%",
      "height: auto",
      "z-index: 2147483647",
      "pointer-events: none",
      "display: block",
      "margin: 0",
      "padding: 0",
      "border: 0",
      "opacity: 1",
      "transition: opacity " + FADE_MS + "ms ease",
      "contain: layout style",
      "isolation: isolate"
    ].join(";");
  }

  function makeBrowserChip(browser) {
    var name = String(browser || "").toLowerCase();
    var label = name === "edge" ? "EDGE" : name === "chrome" ? "CHROME" : "BROWSER";
    return label + " · LIVE";
  }

  function ensureHost() {
    var host = document.getElementById(HOST_ID);
    if (host && host.getAttribute("data-agbb-control-banner") === "1" &&
        host.getAttribute("data-agbb-banner-version") === VERSION &&
        host.shadowRoot && host.shadowRoot.querySelector(".label")) {
      host.style.cssText = hostStyle();
      return { host: host, created: false };
    }
    if (host && host.parentNode) host.parentNode.removeChild(host);

    host = document.createElement(HOST_TAG);
    host.id = HOST_ID;
    host.setAttribute("data-agbb-control-banner", "1");
    host.setAttribute("data-agbb-banner-version", VERSION);
    host.style.cssText = hostStyle();
    if (!host.attachShadow) return null;

    var root = host.attachShadow({ mode: "open" });

    var bar = document.createElement("div");
    bar.className = "pill";
    bar.setAttribute("role", "status");
    bar.setAttribute("aria-live", "polite");
    styleText(bar, [
      "display:flex", "align-items:center", "justify-content:center", "gap:9px",
      "position:relative", "width:100%", "height:40px", "padding:0 18px", "box-sizing:border-box",
      "background:linear-gradient(180deg,rgba(7,9,16,.95) 0%,rgba(9,12,22,.88) 68%,rgba(9,12,22,0) 100%)",
      "border-bottom:1px solid rgba(34,227,255,.10)",
      "box-shadow:0 10px 30px rgba(0,0,0,.22)",
      "color:#edf7ff",
      "font:600 12.5px/1.2 -apple-system,\"Segoe UI\",\"Microsoft YaHei\",\"PingFang SC\",sans-serif",
      "letter-spacing:.01em", "white-space:nowrap", "pointer-events:none", "user-select:none",
      "-webkit-backdrop-filter:blur(10px) saturate(150%)", "backdrop-filter:blur(10px) saturate(150%)"
    ]);

    var star = document.createElement("span");
    star.className = "star";
    star.setAttribute("aria-hidden", "true");
    star.textContent = "✦";
    styleText(star, ["color:#f6d893", "font-size:14px", "line-height:1", "text-shadow:0 0 12px rgba(246,216,147,.55)"]);

    var dot = document.createElement("span");
    dot.className = "dot";
    dot.setAttribute("aria-hidden", "true");
    styleText(dot, [
      "width:7px", "height:7px", "border-radius:50%", "flex:0 0 auto",
      "background:#38d16a", "box-shadow:0 0 0 3px rgba(56,209,106,.18),0 0 12px rgba(56,209,106,.55)", "display:block"
    ]);
    pulseDot(dot);

    var label = document.createElement("span");
    label.className = "label";
    label.textContent = TEXT;
    styleText(label, ["color:inherit", "font:inherit", "text-shadow:0 1px 8px rgba(34,227,255,.16)"]);

    var chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = "EDGE · LIVE";
    styleText(chip, [
      "margin-left:4px", "padding:2px 8px", "border:1px solid rgba(34,227,255,.22)",
      "border-radius:999px", "background:rgba(34,227,255,.075)", "color:#9fe9ff",
      "font:600 9px/1.4 ui-monospace,Consolas,monospace", "letter-spacing:.08em"
    ]);

    var edge = document.createElement("span");
    edge.className = "edge";
    edge.setAttribute("aria-hidden", "true");
    styleText(edge, [
      "position:absolute", "left:0", "right:0", "bottom:0", "height:1px",
      "background:linear-gradient(90deg,transparent,rgba(246,216,147,.42),rgba(34,227,255,.72),transparent)",
      "opacity:.9"
    ]);

    bar.appendChild(star);
    bar.appendChild(dot);
    bar.appendChild(label);
    bar.appendChild(chip);
    bar.appendChild(edge);
    root.appendChild(bar);

    var parent = document.documentElement || document.body;
    if (!parent) return null;
    parent.appendChild(host);
    return { host: host, created: true };
  }

  function show(opts) {
    opts = opts || {};
    var hideMs = Number(opts.hideMs);
    if (!isFinite(hideMs) || hideMs <= 0) hideMs = DEFAULT_HIDE_MS;

    var made = ensureHost();
    if (!made) return { ok: false, error: "无法创建控制顶栏" };
    var host = made.host;

    if (!host.isConnected) {
      var parent = document.documentElement || document.body;
      if (parent) parent.appendChild(host);
    }
    host.style.opacity = "1";
    var label = host.shadowRoot && host.shadowRoot.querySelector(".label");
    if (label) label.textContent = TEXT;
    var chip = host.shadowRoot && host.shadowRoot.querySelector(".chip");
    if (chip) chip.textContent = makeBrowserChip(opts.browser);

    clearTimers();
    var state = { host: host, hideMs: hideMs };
    globalThis[STATE_KEY] = state;

    state.hideTimer = setTimeout(function () {
      state.hideTimer = 0;
      if (globalThis[STATE_KEY] !== state) return;
      host.style.opacity = "0";
      state.removeTimer = setTimeout(function () {
        state.removeTimer = 0;
        if (globalThis[STATE_KEY] !== state) return;
        if (host.parentNode) host.parentNode.removeChild(host);
        globalThis[STATE_KEY] = null;
      }, FADE_MS);
    }, hideMs);

    return { ok: true, created: made.created, id: HOST_ID, text: TEXT, hideMs: hideMs };
  }

  function hide() {
    clearTimers();
    var host = document.getElementById(HOST_ID);
    if (!host) {
      globalThis[STATE_KEY] = null;
      return { ok: true, removed: false };
    }
    host.style.opacity = "0";
    var state = { host: host };
    globalThis[STATE_KEY] = state;
    state.removeTimer = setTimeout(function () {
      state.removeTimer = 0;
      if (globalThis[STATE_KEY] !== state) return;
      if (host.parentNode) host.parentNode.removeChild(host);
      globalThis[STATE_KEY] = null;
    }, FADE_MS);
    return { ok: true, removed: true };
  }

  globalThis.__AGBB_BANNER = {
    version: VERSION,
    text: TEXT,
    hideMs: DEFAULT_HIDE_MS,
    hostId: HOST_ID,
    show: show,
    hide: hide
  };
})();
