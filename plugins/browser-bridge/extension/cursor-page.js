/**
 * cursor-page.js
 * 注入到页面隔离世界的「受控鼠标」：显示一个跟随动作点的指针 + 点击/输入/滚动反馈。
 *
 * 约定：
 * - Shadow DOM + 固定定位，pointer-events:none，不改变页面布局，不挡点击。
 * - 只在本模块自己的宿主里绘制，重复注入不会产生第二个鼠标。
 * - show() 会在动作点之间平滑移动指针；persistent=true 时控制会话内常驻，
 *   不会因空闲自动淡出。
 * - 页面脚本看不到 __AGBB_CURSOR（隔离世界），受保护页面注入失败是预期行为。
 */
(function () {
  var VERSION = "1.3.0";
  var HOST_ID = "agbb-control-cursor-host";
  var STATE_KEY = "__AGBB_CURSOR_STATE__";
  var HIDE_MS = 45000;
  var FADE_MS = 180;
  var REDUCED = false;
  try {
    REDUCED = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (error) {}

  var CSS = [
    ".layer{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none}",
    ".spot{position:absolute;left:0;top:0;width:132px;height:132px;margin:-66px 0 0 -66px;border-radius:50%;",
    "background:radial-gradient(circle,rgba(34,227,255,.14) 0%,rgba(34,227,255,.06) 35%,transparent 70%);",
    "transform:translate3d(-200px,-200px,0);transition:transform 180ms cubic-bezier(.2,.8,.2,1);opacity:.9}",
    ".pointer{position:absolute;left:0;top:0;width:26px;height:30px;",
    "transform:translate3d(-100px,-100px,0);transition:transform 150ms cubic-bezier(.2,.8,.2,1);",
    "filter:drop-shadow(0 0 7px rgba(34,227,255,.55)) drop-shadow(0 2px 3px rgba(0,0,0,.55))}",
    ".pointer svg{display:block;width:26px;height:30px;overflow:visible}",
    ".ring{position:absolute;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;",
    "border:1.5px solid rgba(34,227,255,.72);border-radius:50%;",
    "box-shadow:0 0 14px rgba(34,227,255,.24),inset 0 0 10px rgba(34,227,255,.10);",
    "opacity:0;transform:translate3d(-100px,-100px,0);",
    "transition:transform 150ms cubic-bezier(.2,.8,.2,1),opacity 140ms ease}",
    ".ring.on{opacity:1}",
    ".ripple{position:absolute;left:0;top:0;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;",
    "border:2px solid rgba(34,227,255,.9);opacity:0;",
    "animation:agbb-ripple 520ms cubic-bezier(.2,.8,.2,1) both}",
    ".label{position:absolute;left:0;top:0;transform:translate3d(-100px,-100px,0);",
    "margin:22px 0 0 18px;padding:3px 8px;border-radius:999px;",
    "background:rgba(8,12,20,.94);color:#9fe9ff;border:1px solid rgba(34,227,255,.38);",
    "box-shadow:0 6px 18px rgba(0,0,0,.3),0 0 12px rgba(34,227,255,.1);",
    "font:600 11px/1.4 -apple-system,'Segoe UI','Microsoft YaHei','PingFang SC',sans-serif;",
    "white-space:nowrap;opacity:0;transition:opacity 120ms ease;letter-spacing:.02em}",
    ".label.on{opacity:1}",
    "@keyframes agbb-ripple{0%{opacity:.95;transform:scale(.35)}",
    "70%{opacity:.4}100%{opacity:0;transform:scale(2.5)}}",
    "@media (prefers-reduced-motion:reduce){.pointer,.ring,.spot{transition:none}.ripple{animation-duration:1ms}}"
  ].join("");

  function ensure() {
    var host = document.getElementById(HOST_ID);
    if (host && host.getAttribute("data-agbb-control-cursor") === "1" &&
        host.getAttribute("data-agbb-cursor-version") === VERSION && host.shadowRoot) {
      return host;
    }
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = document.createElement("agbb-control-cursor");
    host.id = HOST_ID;
    host.setAttribute("data-agbb-control-cursor", "1");
    host.setAttribute("data-agbb-cursor-version", VERSION);
    host.style.cssText = [
      "all: initial",
      "position: fixed",
      "inset: 0",
      "z-index: 2147483647",
      "pointer-events: none",
      "display: block",
      "margin: 0",
      "padding: 0",
      "border: 0",
      "overflow: hidden",
      "contain: layout style",
      "isolation: isolate",
      "opacity: 1",
      "transition: opacity " + FADE_MS + "ms ease"
    ].join(";");
    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : null;
    if (!root) return null;
    var style = document.createElement("style");
    style.textContent = CSS;
    var layer = document.createElement("div");
    layer.className = "layer";

    var spot = document.createElement("div");
    spot.className = "spot";

    var ring = document.createElement("div");
    ring.className = "ring";

    var pointer = document.createElement("div");
    pointer.className = "pointer";
    pointer.innerHTML = [
      '<svg viewBox="0 0 26 30" aria-hidden="true">',
      '<path d="M3 2.5 L23 13.2 L13.7 15.4 L18.1 25.4 L13.8 27.3 L9.5 17.3 L3 23.2 Z" ',
      'fill="#F4FBFF" stroke="#0B0E14" stroke-width="2.2" stroke-linejoin="round"/>',
      '<path d="M3 2.5 L23 13.2 L13.7 15.4 L18.1 25.4" fill="none" stroke="rgba(34,227,255,.85)" stroke-width="1.1" stroke-linejoin="round"/>',
      '</svg>'
    ].join("");

    var label = document.createElement("div");
    label.className = "label";

    layer.appendChild(spot);
    layer.appendChild(ring);
    layer.appendChild(pointer);
    layer.appendChild(label);
    root.appendChild(style);
    root.appendChild(layer);
    (document.documentElement || document.body).appendChild(host);
    return host;
  }

  function resetTimer(state) {
    if (state.hideTimer) clearTimeout(state.hideTimer);
    state.hideTimer = 0;
    if (state.persistent) return;
    state.hideTimer = setTimeout(function () {
      state.hideTimer = 0;
      if (!state.host || !state.host.isConnected) return;
      state.host.style.opacity = "0";
      state.ring.classList.remove("on");
      state.label.classList.remove("on");
      state.removeTimer = setTimeout(function () {
        if (state.host && state.host.parentNode) state.host.parentNode.removeChild(state.host);
        if (globalThis[STATE_KEY] === state) globalThis[STATE_KEY] = null;
      }, FADE_MS);
    }, HIDE_MS);
  }

  function show(x, y, action, opts) {
    var host = ensure();
    if (!host || !host.shadowRoot) return { ok: false, error: "无法创建鼠标层" };
    var layer = host.shadowRoot.querySelector(".layer");
    var spot = host.shadowRoot.querySelector(".spot");
    var pointer = host.shadowRoot.querySelector(".pointer");
    var ring = host.shadowRoot.querySelector(".ring");
    var label = host.shadowRoot.querySelector(".label");
    if (!layer || !spot || !pointer || !ring || !label) return { ok: false, error: "鼠标层未就绪" };
    var px = Number(x);
    var py = Number(y);
    if (!isFinite(px) || !isFinite(py)) return { ok: false, error: "坐标非法" };

    host.style.opacity = "1";
    if (spot) spot.style.transform = "translate3d(" + px + "px," + py + "px,0)";
    pointer.style.transform = "translate3d(" + (px - 2) + "px," + (py - 2) + "px,0)";
    ring.style.transform = "translate3d(" + px + "px," + py + "px,0)";
    ring.classList.add("on");

    var name = String(action || "move").toLowerCase();
    var labels = {
      click: "点击", type: "输入", scroll: "滚动", drag: "拖动",
      open: "打开", read: "查看", look: "查看", run: "执行", ready: "就绪", move: "正在控制", control: "正在控制"
    };
    var text = labels[name] || "";
    if (text) {
      label.textContent = text;
      label.style.transform = "translate3d(" + px + "px," + py + "px,0)";
      label.classList.add("on");
    } else {
      label.classList.remove("on");
    }

    if (name === "click" || name === "drag") {
      var ripple = document.createElement("div");
      ripple.className = "ripple";
      ripple.style.left = px + "px";
      ripple.style.top = py + "px";
      layer.appendChild(ripple);
      setTimeout(function () { if (ripple.parentNode) ripple.parentNode.removeChild(ripple); }, 560);
    }

    var state = globalThis[STATE_KEY];
    if (!state || state.host !== host) {
      state = { host: host, ring: ring, label: label, hideTimer: 0, removeTimer: 0, persistent: false };
      globalThis[STATE_KEY] = state;
    }
    if (opts && opts.persistent === true) state.persistent = true;
    if (opts && opts.persistent === false) state.persistent = false;
    clearTimeout(state.removeTimer);
    resetTimer(state);
    return { ok: true, x: px, y: py, action: name, persistent: !!state.persistent };
  }

  function hide() {
    var state = globalThis[STATE_KEY];
    if (state && state.hideTimer) clearTimeout(state.hideTimer);
    if (state && state.host && state.host.parentNode) state.host.parentNode.removeChild(state.host);
    globalThis[STATE_KEY] = null;
    return { ok: true };
  }

  function stateInfo() {
    var state = globalThis[STATE_KEY];
    if (!state || !state.host || !state.host.isConnected) return { ok: true, visible: false, persistent: false };
    var rect = state.host.getBoundingClientRect();
    var pointer = state.host.shadowRoot && state.host.shadowRoot.querySelector(".pointer");
    var transform = pointer ? pointer.style.transform : "";
    var match = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(transform || "");
    return {
      ok: true,
      visible: state.host.style.opacity !== "0",
      persistent: !!state.persistent,
      x: match ? Number(match[1]) + 2 : null,
      y: match ? Number(match[2]) + 2 : null,
      pointerEvents: state.host.style.pointerEvents || "",
      rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)]
    };
  }

  globalThis.__AGBB_CURSOR = { version: VERSION, show: show, hide: hide, state: stateInfo };
})();
