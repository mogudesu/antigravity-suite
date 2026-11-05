/**
 * recorder-page.js
 * 注入到页面的隔离世界（ISOLATED world），负责：
 * 1. 渲染 Shadow DOM 悬浮录制胶囊 HUD（支持显示步数、添加业务规则备注、圈选标记采集元素、暂停/完成录制）。
 * 2. 在捕获阶段（capture=true）无感采集用户的真实 DOM 交互（click / input防抖合并 / select / press / scroll节流）。
 * 3. 为每个目标元素生成与 page-actions.js 100% 兼容的四维多重定位锚点（semantic + selector + fallbacks + bbox）。
 */
(function () {
  var VERSION = "1.0.0";
  var HOST_ID = "agbb-recorder-hud-host";
  var HOST_TAG = "agbb-recorder-hud";

  if (globalThis.__AGBB_RECORDER && globalThis.__AGBB_RECORDER.version === VERSION) {
    return;
  }

  var ROLE_BY_TAG = {
    a: "link", button: "button", select: "combobox", textarea: "textbox",
    summary: "button", option: "option", label: "label"
  };
  var ROLE_BY_INPUT = {
    text: "textbox", search: "searchbox", email: "textbox", password: "textbox",
    tel: "textbox", url: "textbox", number: "spinbutton", checkbox: "checkbox",
    radio: "radio", submit: "button", button: "button", reset: "button",
    file: "file", range: "slider", color: "color", date: "date", "datetime-local": "date",
    month: "date", time: "time", week: "date", hidden: ""
  };
  var TEXT_INPUT_TYPES = {
    text: 1, search: 1, email: 1, password: 1, tel: 1, url: 1, number: 1,
    date: 1, "datetime-local": 1, month: 1, time: 1, week: 1
  };

  var state = {
    active: false,
    paused: false,
    pickMode: false,
    sessionId: "",
    stepCount: 0,
    lastSummary: "等待操作…",
    composing: false,
    pendingInput: null,
    scrollTimer: 0,
    lastScrollY: typeof window !== "undefined" ? Math.round(window.scrollY || 0) : 0,
    host: null,
    root: null,
    els: {},
    hoverBox: null
  };

  function trunc(s, n) {
    s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function isPasswordField(el) {
    if (!el || !el.tagName || el.tagName.toLowerCase() !== "input") return false;
    var type = String(el.getAttribute("type") || "").toLowerCase();
    if (type === "password") return true;
    var autocomplete = String(el.getAttribute("autocomplete") || "").toLowerCase();
    return autocomplete.indexOf("current-password") !== -1 || autocomplete.indexOf("new-password") !== -1;
  }

  function isTextLikeInput(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toLowerCase();
    if (tag === "textarea") return true;
    if (el.isContentEditable) return true;
    if (tag === "input") {
      var type = String(el.getAttribute("type") || "text").toLowerCase();
      return !!TEXT_INPUT_TYPES[type];
    }
    return false;
  }

  function isOwnUi(target, ev) {
    try {
      if (ev && typeof ev.composedPath === "function") {
        var path = ev.composedPath();
        for (var i = 0; i < path.length; i++) {
          var n = path[i];
          if (n && n.id && (
            n.id === HOST_ID ||
            n.id.indexOf("agbb-control-") === 0 ||
            n.id.indexOf("agbb-recorder-") === 0
          )) return true;
        }
      }
      var el = target && target.nodeType === 1 ? target : (target && target.parentElement);
      if (!el) return false;
      if (el.id && (el.id === HOST_ID || el.id.indexOf("agbb-") === 0)) return true;
      if (el.closest && el.closest("#" + HOST_ID + ",#agbb-control-cursor-host,#agbb-control-banner-host")) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  function textOf(el) {
    if (!el) return "";
    var t = el.innerText || el.textContent || "";
    return String(t).replace(/\s+/g, " ").trim();
  }

  function roleOf(el) {
    if (!el || !el.tagName) return "";
    var explicit = el.getAttribute && el.getAttribute("role");
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === "input") {
      var type = (el.getAttribute("type") || "text").toLowerCase();
      return ROLE_BY_INPUT[type] != null ? ROLE_BY_INPUT[type] : "textbox";
    }
    if (tag === "a") return el.hasAttribute("href") ? "link" : "";
    return ROLE_BY_TAG[tag] || "";
  }

  function nameOf(el) {
    if (!el || !el.tagName) return "";
    var aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria) return trunc(aria, 100);
    var labelled = el.getAttribute && el.getAttribute("aria-labelledby");
    if (labelled) {
      var parts = labelled.split(/\s+/).map(function (id) {
        var t = document.getElementById(id);
        return t ? textOf(t) : "";
      }).filter(Boolean);
      if (parts.length) return trunc(parts.join(" "), 100);
    }
    if (el.id) {
      try {
        var lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lab) return trunc(textOf(lab), 100);
      } catch (e) { /* ignore */ }
    }
    var closestLabel = el.closest && el.closest("label");
    if (closestLabel) {
      var lt = trunc(textOf(closestLabel), 100);
      if (lt) return lt;
    }
    var ph = el.getAttribute && el.getAttribute("placeholder");
    if (ph) return trunc(ph, 100);
    var alt = el.getAttribute && el.getAttribute("alt");
    if (alt) return trunc(alt, 100);
    var title = el.getAttribute && el.getAttribute("title");
    if (title) return trunc(title, 100);
    var tag = el.tagName.toLowerCase();
    if (tag === "input" && isPasswordField(el)) return "[REDACTED]";
    if (tag === "input" && el.value) return trunc(el.value, 100);
    return trunc(textOf(el), 100);
  }

  /** 判断 id 是否像动态生成的随机哈希（如 :r1:, ember123, input-9876543） */
  function isStableId(id) {
    if (!id || typeof id !== "string") return false;
    if (id.length > 48 || /^[:_]/.test(id)) return false;
    if (/\d{5,}/.test(id)) return false;
    if (/^[a-f0-9]{8,}$/i.test(id)) return false;
    return true;
  }

  function isUniqueSelector(sel) {
    if (!sel) return false;
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch (e) {
      return false;
    }
  }

  function cssEscape(v) {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(String(v));
    return String(v).replace(/([!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g, "\\$1");
  }

  function attrSelector(tag, attr, val) {
    if (!val || String(val).length > 80) return "";
    var escaped = String(val).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return tag + '[' + attr + '="' + escaped + '"]';
  }

  /** 构建元素的多重稳健定位锚点 */
  function buildLocator(el) {
    if (!el || el.nodeType !== 1) return null;
    var tag = el.tagName.toLowerCase();
    var role = roleOf(el);
    var name = nameOf(el);
    var text = trunc(textOf(el), 80);
    var candidates = [];

    // 1. 稳定 ID
    if (isStableId(el.id)) {
      var idSel = "#" + cssEscape(el.id);
      if (isUniqueSelector(idSel)) candidates.push(idSel);
    }

    // 2. 测试专用属性与强语义属性
    var stableAttrs = ["data-testid", "data-test", "data-qa", "data-cy", "name", "aria-label", "placeholder", "title"];
    for (var i = 0; i < stableAttrs.length; i++) {
      var a = stableAttrs[i];
      var v = el.getAttribute && el.getAttribute(a);
      if (v) {
        var sel = attrSelector(tag, a, v);
        if (sel && isUniqueSelector(sel)) candidates.push(sel);
      }
    }

    // 3. 链接 href（去掉过长查询串）
    if (tag === "a" && el.getAttribute("href")) {
      var href = el.getAttribute("href");
      if (href && href.indexOf("javascript:") !== 0 && href.length <= 80) {
        var hrefSel = attrSelector("a", "href", href);
        if (hrefSel && isUniqueSelector(hrefSel)) candidates.push(hrefSel);
      }
    }

    // 4. 层级结构路径（向上最多 4 层）
    var pathSel = buildStructuralPath(el, 4);
    if (pathSel) candidates.push(pathSel);

    var primary = candidates[0] || tag;
    var fallbacks = [];
    for (var j = 1; j < candidates.length && fallbacks.length < 3; j++) {
      if (candidates[j] !== primary && fallbacks.indexOf(candidates[j]) === -1) {
        fallbacks.push(candidates[j]);
      }
    }

    var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    return {
      semantic: {
        role: role || "",
        name: name || "",
        text: text || "",
        tag: tag,
        inputType: tag === "input" ? String(el.getAttribute("type") || "text").toLowerCase() : undefined,
        placeholder: (el.getAttribute && el.getAttribute("placeholder")) || undefined
      },
      selector: primary,
      fallbacks: fallbacks,
      bbox: {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  }

  function buildStructuralPath(el, maxLevels) {
    var parts = [];
    var cur = el;
    var depth = 0;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement && depth < maxLevels) {
      var tag = cur.tagName.toLowerCase();
      if (isStableId(cur.id)) {
        parts.unshift("#" + cssEscape(cur.id));
        break;
      }
      var parent = cur.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      var sameTag = [];
      var children = parent.children;
      for (var i = 0; i < children.length; i++) {
        if (children[i].tagName === cur.tagName) sameTag.push(children[i]);
      }
      if (sameTag.length > 1) {
        var idx = sameTag.indexOf(cur) + 1;
        parts.unshift(tag + ":nth-of-type(" + idx + ")");
      } else {
        parts.unshift(tag);
      }
      cur = parent;
      depth++;
    }
    return parts.join(" > ");
  }

  /** 为「标记提取」推导同类列表选择器（如商品卡片列表、表格行） */
  function detectListSelector(el) {
    var cur = el;
    for (var depth = 0; depth < 5 && cur && cur.parentElement; depth++) {
      var parent = cur.parentElement;
      var tag = cur.tagName.toLowerCase();
      var siblings = [];
      for (var i = 0; i < parent.children.length; i++) {
        if (parent.children[i].tagName === cur.tagName) siblings.push(parent.children[i]);
      }
      if (siblings.length >= 3) {
        var parentPath = buildStructuralPath(parent, 3);
        return {
          isList: true,
          itemCount: siblings.length,
          listSelector: (parentPath ? parentPath + " > " : "") + tag
        };
      }
      cur = parent;
    }
    return { isList: false, itemCount: 1, listSelector: "" };
  }

  /** 向上寻找最近的可交互节点（避免点到 button 内部的 svg/span 导致定位器失真） */
  function findInteractiveAncestor(el) {
    var cur = el;
    for (var i = 0; i < 5 && cur && cur.nodeType === 1; i++) {
      var tag = cur.tagName.toLowerCase();
      if (tag === "a" || tag === "button" || tag === "input" || tag === "select" || tag === "textarea" || tag === "summary" || tag === "label") {
        return cur;
      }
      var role = cur.getAttribute && cur.getAttribute("role");
      if (role && (role === "button" || role === "link" || role === "menuitem" || role === "tab" || role === "checkbox" || role === "switch" || role === "option")) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return el;
  }

  function readInputValue(el) {
    if (!el) return "";
    if (isPasswordField(el)) return "[REDACTED_PASSWORD]";
    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || tag === "select") return String(el.value == null ? "" : el.value);
    if (el.isContentEditable) return String(el.textContent || "");
    return "";
  }

  function emitStep(step) {
    if (!state.active || state.paused) return;
    var payload = Object.assign({
      at: Date.now(),
      url: location.href,
      pageTitle: document.title
    }, step);
    try {
      chrome.runtime.sendMessage({ type: "ag:record:step", step: payload }, function (res) {
        if (chrome.runtime.lastError) return;
        if (res && typeof res.stepCount === "number") {
          state.stepCount = res.stepCount;
        } else {
          state.stepCount += 1;
        }
        state.lastSummary = summarizeStep(payload);
        renderHud();
      });
    } catch (e) { /* ignore */ }
  }

  function summarizeStep(s) {
    if (!s) return "";
    var name = (s.locator && s.locator.semantic && (s.locator.semantic.name || s.locator.semantic.text)) ||
               (s.locator && s.locator.selector) || "";
    name = trunc(name, 18);
    if (s.type === "click") return "点击 " + (name || "元素");
    if (s.type === "type") return "输入 " + (s.sensitive ? "[密码已脱敏]" : trunc(s.value, 14));
    if (s.type === "select") return "选择 " + trunc(s.label || s.value, 14);
    if (s.type === "press") return "按键 " + s.key;
    if (s.type === "scroll") return "滚动至 Y=" + s.scrollY;
    if (s.type === "note") return "备注: " + trunc(s.note, 16);
    if (s.type === "extract") return "采集: " + (name || "目标区域");
    return s.type;
  }

  function flushPendingInput(extra) {
    if (!state.pendingInput) return;
    var p = state.pendingInput;
    if (p.timer) clearTimeout(p.timer);
    state.pendingInput = null;
    var val = readInputValue(p.el);
    if (val === p.initialValue && !(extra && extra.submit)) return;
    var sensitive = isPasswordField(p.el);
    emitStep(Object.assign({
      type: "type",
      value: sensitive ? "[REDACTED_PASSWORD]" : val,
      sensitive: sensitive ? "password" : undefined,
      requiresUserAuth: sensitive ? true : undefined,
      locator: p.locator
    }, extra || {}));
  }

  /* ------------------------------------------------ DOM 事件监听器 */

  function onClick(ev) {
    if (!state.active) return;
    if (isOwnUi(ev.target, ev)) return;

    // 圈选提取模式
    if (state.pickMode) {
      ev.preventDefault();
      ev.stopPropagation();
      var picked = ev.target && ev.target.nodeType === 1 ? ev.target : null;
      if (!picked) return;
      var loc = buildLocator(picked);
      var listInfo = detectListSelector(picked);
      var sample = trunc(textOf(picked), 160);
      setPickMode(false);
      emitStep({
        type: "extract",
        mode: listInfo.isList ? "list" : "single",
        itemCount: listInfo.itemCount,
        listSelector: listInfo.listSelector || undefined,
        sampleText: sample,
        locator: loc
      });
      return;
    }

    if (state.paused) return;
    var rawTarget = ev.target && ev.target.nodeType === 1 ? ev.target : null;
    if (!rawTarget) return;
    var target = findInteractiveAncestor(rawTarget);

    // 如果正在另一个输入框输入，先落盘上一次输入
    if (state.pendingInput && state.pendingInput.el !== target) {
      flushPendingInput();
    }

    // 聚焦到纯文本输入框或下拉框的普通点击不单独记为 click，后续由 type / select 合并记录
    if (isTextLikeInput(target) || (target.tagName && target.tagName.toLowerCase() === "select")) {
      return;
    }

    var locator = buildLocator(target);
    emitStep({
      type: "click",
      locator: locator
    });
  }

  function onMouseMove(ev) {
    if (!state.active || !state.pickMode || !state.hoverBox) return;
    if (isOwnUi(ev.target, ev)) {
      state.hoverBox.style.display = "none";
      return;
    }
    var el = ev.target && ev.target.nodeType === 1 ? ev.target : null;
    if (!el || !el.getBoundingClientRect) return;
    var r = el.getBoundingClientRect();
    state.hoverBox.style.display = "block";
    state.hoverBox.style.left = Math.round(r.left) + "px";
    state.hoverBox.style.top = Math.round(r.top) + "px";
    state.hoverBox.style.width = Math.max(4, Math.round(r.width)) + "px";
    state.hoverBox.style.height = Math.max(4, Math.round(r.height)) + "px";
  }

  function onCompositionStart() {
    state.composing = true;
  }

  function onCompositionEnd(ev) {
    state.composing = false;
    onInput(ev);
  }

  function onInput(ev) {
    if (!state.active || state.paused || state.composing) return;
    if (isOwnUi(ev.target, ev)) return;
    var el = ev.target && ev.target.nodeType === 1 ? ev.target : null;
    if (!el || !isTextLikeInput(el)) return;

    if (state.pendingInput && state.pendingInput.el !== el) {
      flushPendingInput();
    }
    if (!state.pendingInput) {
      state.pendingInput = {
        el: el,
        locator: buildLocator(el),
        initialValue: undefined,
        timer: 0
      };
    }
    if (state.pendingInput.timer) clearTimeout(state.pendingInput.timer);
    state.pendingInput.timer = setTimeout(function () {
      flushPendingInput();
    }, 750);
  }

  function onChange(ev) {
    if (!state.active || state.paused) return;
    if (isOwnUi(ev.target, ev)) return;
    var el = ev.target && ev.target.nodeType === 1 ? ev.target : null;
    if (!el || !el.tagName) return;
    var tag = el.tagName.toLowerCase();
    if (tag === "select") {
      var opt = el.options && el.options[el.selectedIndex];
      emitStep({
        type: "select",
        value: String(el.value || ""),
        label: opt ? trunc(opt.textContent || opt.label || "", 80) : "",
        locator: buildLocator(el)
      });
    }
  }

  function onBlur(ev) {
    if (!state.active || state.paused) return;
    if (state.pendingInput && state.pendingInput.el === ev.target) {
      flushPendingInput();
    }
  }

  function onKeyDown(ev) {
    if (!state.active || state.paused) return;
    if (isOwnUi(ev.target, ev)) return;
    if (ev.key === "Escape" && state.pickMode) {
      ev.preventDefault();
      setPickMode(false);
      return;
    }
    if (ev.key === "Enter" && !state.composing) {
      if (state.pendingInput) {
        flushPendingInput({ submit: true });
        return;
      }
      var el = ev.target && ev.target.nodeType === 1 ? ev.target : document.activeElement;
      emitStep({
        type: "press",
        key: "Enter",
        locator: el ? buildLocator(el) : undefined
      });
    } else if (ev.key === "Escape") {
      emitStep({ type: "press", key: "Escape" });
    }
  }

  function onScroll() {
    if (!state.active || state.paused) return;
    if (state.scrollTimer) clearTimeout(state.scrollTimer);
    state.scrollTimer = setTimeout(function () {
      var curY = Math.round(window.scrollY || 0);
      if (Math.abs(curY - state.lastScrollY) < 260) return;
      var deltaY = curY - state.lastScrollY;
      state.lastScrollY = curY;
      emitStep({
        type: "scroll",
        scrollY: curY,
        deltaY: deltaY,
        direction: deltaY >= 0 ? "down" : "up",
        amount: Math.abs(deltaY)
      });
    }, 650);
  }

  function attachListeners() {
    document.addEventListener("click", onClick, true);
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("compositionstart", onCompositionStart, true);
    document.addEventListener("compositionend", onCompositionEnd, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("change", onChange, true);
    document.addEventListener("blur", onBlur, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  }

  function detachListeners() {
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("compositionstart", onCompositionStart, true);
    document.removeEventListener("compositionend", onCompositionEnd, true);
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("change", onChange, true);
    document.removeEventListener("blur", onBlur, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", onScroll, { capture: true, passive: true });
  }

  /* ------------------------------------------------ Shadow DOM 悬浮胶囊 HUD */

  function setPickMode(on) {
    state.pickMode = !!on;
    if (state.hoverBox) state.hoverBox.style.display = "none";
    renderHud();
  }

  function ensureHud() {
    var existing = document.getElementById(HOST_ID);
    if (existing && state.host === existing && state.root) return existing;
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    var host = document.createElement(HOST_TAG);
    host.id = HOST_ID;
    host.setAttribute("data-agbb-recorder-hud", "1");
    host.style.cssText = [
      "all: initial",
      "position: fixed",
      "right: 20px",
      "bottom: 20px",
      "z-index: 2147483647",
      "font-family: -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif"
    ].join(";");

    var root = host.attachShadow({ mode: "open" });
    var style = document.createElement("style");
    style.textContent = [
      ".hud { background: rgba(11, 15, 27, 0.94); color: #f4f7ff; border: 1px solid rgba(246, 216, 147, 0.38);",
      "  border-radius: 14px; padding: 10px 13px; box-shadow: 0 12px 32px rgba(0,0,0,0.42);",
      "  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); min-width: 280px; max-width: 360px;",
      "  user-select: none; font-size: 12px; line-height: 1.4; }",
      ".top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }",
      ".status { display: flex; align-items: center; gap: 7px; font-weight: 600; }",
      ".dot { width: 8px; height: 8px; border-radius: 50%; background: #ff4d4f; box-shadow: 0 0 0 3px rgba(255,77,79,0.25); }",
      ".dot.paused { background: #f6d893; box-shadow: 0 0 0 3px rgba(246,216,147,0.22); }",
      ".badge { padding: 1px 7px; border-radius: 999px; background: rgba(246,216,147,0.15); color: #f6d893; font-size: 11px; }",
      ".summary { margin-top: 6px; color: #9fb3c8; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
      ".btns { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }",
      "button { all: unset; cursor: pointer; padding: 4px 9px; border-radius: 7px; font-size: 11.5px; font-weight: 500;",
      "  background: rgba(255,255,255,0.08); color: #e6f0ff; border: 1px solid rgba(255,255,255,0.14); transition: background .15s; }",
      "button:hover { background: rgba(255,255,255,0.16); }",
      "button.active { background: rgba(34,227,255,0.2); border-color: #22e3ff; color: #9fe9ff; }",
      "button.stop { background: rgba(255,77,79,0.2); border-color: rgba(255,77,79,0.45); color: #ffccc7; }",
      ".note-box { display: none; margin-top: 8px; gap: 6px; }",
      ".note-box.open { display: flex; }",
      ".note-box input { flex: 1; padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(246,216,147,0.35);",
      "  background: rgba(0,0,0,0.35); color: #fff; font-size: 11.5px; outline: none; }",
      ".hover-box { position: fixed; pointer-events: none; border: 2px dashed #22e3ff; background: rgba(34,227,255,0.12);",
      "  border-radius: 4px; z-index: 2147483646; display: none; }"
    ].join("\n");

    var hoverBox = document.createElement("div");
    hoverBox.className = "hover-box";

    var wrap = document.createElement("div");
    wrap.className = "hud";
    wrap.innerHTML = [
      '<div class="top">',
      '  <div class="status"><span class="dot" id="dot"></span><span id="title">RPA 录制中</span></div>',
      '  <span class="badge" id="count">0 步</span>',
      '</div>',
      '<div class="summary" id="summary">等待操作…</div>',
      '<div class="btns">',
      '  <button id="btn-note" title="补充当前步骤的业务规则或注意事项">💬 备注规则</button>',
      '  <button id="btn-pick" title="在页面上点选需要提取的数据区域">🎯 标记提取</button>',
      '  <button id="btn-pause" title="暂停或恢复录制">⏸ 暂停</button>',
      '  <button id="btn-stop" class="stop" title="结束录制并保存轨迹">⏹ 完成</button>',
      '</div>',
      '<div class="note-box" id="note-box">',
      '  <input id="note-input" type="text" placeholder="交代规则，如：这里只选销量前10（回车保存）" />',
      '  <button id="note-save">添加</button>',
      '</div>'
    ].join("");

    root.appendChild(style);
    root.appendChild(hoverBox);
    root.appendChild(wrap);

    var parent = document.documentElement || document.body;
    if (parent) parent.appendChild(host);

    state.host = host;
    state.root = root;
    state.hoverBox = hoverBox;
    state.els = {
      dot: root.getElementById("dot"),
      title: root.getElementById("title"),
      count: root.getElementById("count"),
      summary: root.getElementById("summary"),
      btnNote: root.getElementById("btn-note"),
      btnPick: root.getElementById("btn-pick"),
      btnPause: root.getElementById("btn-pause"),
      btnStop: root.getElementById("btn-stop"),
      noteBox: root.getElementById("note-box"),
      noteInput: root.getElementById("note-input"),
      noteSave: root.getElementById("note-save")
    };

    state.els.btnNote.onclick = function () {
      var open = state.els.noteBox.classList.toggle("open");
      if (open) state.els.noteInput.focus();
    };

    function submitNote() {
      var val = String(state.els.noteInput.value || "").trim();
      if (!val) return;
      state.els.noteInput.value = "";
      state.els.noteBox.classList.remove("open");
      emitStep({ type: "note", note: val });
    }

    state.els.noteSave.onclick = submitNote;
    state.els.noteInput.onkeydown = function (e) {
      if (e.key === "Enter") { e.preventDefault(); submitNote(); }
      e.stopPropagation();
    };

    state.els.btnPick.onclick = function () {
      setPickMode(!state.pickMode);
    };

    state.els.btnPause.onclick = function () {
      state.paused = !state.paused;
      try {
        chrome.runtime.sendMessage({ type: "ag:record:pause", paused: state.paused });
      } catch (e) { /* ignore */ }
      renderHud();
    };

    state.els.btnStop.onclick = function () {
      flushPendingInput();
      try {
        chrome.runtime.sendMessage({ type: "ag:record:finishFromHud" });
      } catch (e) { /* ignore */ }
      stop();
    };

    return host;
  }

  function renderHud() {
    if (!state.host || !state.els.count) return;
    state.els.dot.className = "dot" + (state.paused ? " paused" : "");
    state.els.title.textContent = state.pickMode
      ? "请点击页面中要提取的元素 (Esc取消)"
      : (state.paused ? "已暂停录制" : "谷谷嘎嘎 · RPA录制中");
    state.els.count.textContent = state.stepCount + " 步";
    state.els.summary.textContent = state.lastSummary || "等待你在页面中操作…";
    state.els.btnPick.className = state.pickMode ? "active" : "";
    state.els.btnPause.textContent = state.paused ? "▶ 继续" : "⏸ 暂停";
  }

  function removeHud() {
    var existing = document.getElementById(HOST_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    state.host = null;
    state.root = null;
    state.els = {};
    state.hoverBox = null;
  }

  /* ------------------------------------------------ 对外接口 */

  function start(opts) {
    opts = opts || {};
    state.active = true;
    state.paused = !!opts.paused;
    state.pickMode = false;
    state.sessionId = opts.sessionId || "";
    state.stepCount = Number(opts.stepCount || 0);
    state.lastSummary = opts.lastSummary || "等待你在页面中操作…";
    state.lastScrollY = Math.round(window.scrollY || 0);
    ensureHud();
    renderHud();
    detachListeners();
    attachListeners();
    return {
      ok: true,
      sessionId: state.sessionId,
      stepCount: state.stepCount,
      url: location.href,
      title: document.title
    };
  }

  function stop() {
    flushPendingInput();
    state.active = false;
    state.paused = false;
    state.pickMode = false;
    detachListeners();
    removeHud();
    return { ok: true, stopped: true };
  }

  function status() {
    return {
      ok: true,
      active: state.active,
      paused: state.paused,
      sessionId: state.sessionId,
      stepCount: state.stepCount,
      lastSummary: state.lastSummary
    };
  }

  globalThis.__AGBB_RECORDER = {
    version: VERSION,
    hostId: HOST_ID,
    start: start,
    stop: stop,
    status: status,
    buildLocator: buildLocator,
    detectListSelector: detectListSelector
  };
})();
