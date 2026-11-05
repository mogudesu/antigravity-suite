/**
 * page-actions.js
 * 以 chrome.scripting.executeScript({files}) 注入到页面的隔离世界，只初始化一次。
 * 所有函数必须自包含（不引用模块作用域变量），因为它们运行在页面里。
 * 元素引用（ref）保存在隔离世界的 Map 中，页面刷新后失效，需要重新 snapshot。
 */
(function () {
  var VERSION = "1.4.0";
  if (globalThis.__AG_PA && globalThis.__AG_PA.version === VERSION) return;

  var REFS = new Map();
  var REVISION = 0;
  var OBSERVER = null;
  var INTERACTIVE_TAGS = { A: 1, BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, OPTION: 1, SUMMARY: 1, DETAILS: 1 };
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

  function trunc(s, n) {
    s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  /** Password fields are never readable or writable through the bridge. */
  function isPasswordField(el) {
    if (!el || !el.tagName || el.tagName.toLowerCase() !== "input") return false;
    var type = String(el.getAttribute("type") || "").toLowerCase();
    if (type === "password") return true;
    var autocomplete = String(el.getAttribute("autocomplete") || "").toLowerCase();
    return autocomplete.indexOf("current-password") !== -1 || autocomplete.indexOf("new-password") !== -1;
  }

  function ignoredNode(node) {
    var el = node && node.nodeType === 1 ? node : null;
    if (!el) return false;
    if (el.id && (el.id.indexOf("agbb-control-") === 0 || el.id.indexOf("agbb-recorder-") === 0)) return true;
    if (!el.closest) return false;
    return !!el.closest("#agbb-control-cursor-host,#agbb-control-banner-host,#agbb-recorder-hud-host");
  }

  function meaningfulRecord(record) {
    if (ignoredNode(record.target)) return false;
    var nodes = [];
    var added = record.addedNodes || [];
    var removed = record.removedNodes || [];
    for (var i = 0; i < added.length; i++) if (!ignoredNode(added[i])) nodes.push(added[i]);
    for (var j = 0; j < removed.length; j++) if (!ignoredNode(removed[j])) nodes.push(removed[j]);
    return nodes.length > 0 || (!added.length && !removed.length);
  }

  function ensureObserver() {
    if (OBSERVER || typeof MutationObserver !== "function" || !document.documentElement) return;
    OBSERVER = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        if (meaningfulRecord(records[i])) { REVISION += 1; return; }
      }
    });
    OBSERVER.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true, characterData: true,
      // 全属性监听会把 style 动画每一帧都算成一次页面变化
      attributeFilter: ['value', 'disabled', 'hidden', 'checked', 'aria-expanded', 'aria-selected', 'class']
    });
  }

  function activeSignature() {
    var active = document.activeElement;
    var focus = active && active !== document.body
      ? active.tagName.toLowerCase() + ":" + (active.id || active.getAttribute("name") || active.getAttribute("aria-label") || "")
      : "";
    return [
      String(REVISION),
      String(Math.round(window.scrollY || 0)),
      location.href,
      document.title,
      focus
    ].join("|");
  }

  function cursorAt(x, y, action, opts) {
    try {
      var cursor = globalThis.__AGBB_CURSOR;
      if (cursor && typeof cursor.show === "function") cursor.show(x, y, action, opts);
    } catch (e) { /* 视觉层不能影响动作 */ }
  }

  function cursorOn(el, action) {
    try {
      if (!el || !el.getBoundingClientRect) return;
      var rect = el.getBoundingClientRect();
      if (!rect || (rect.width <= 0 && rect.height <= 0)) return;
      cursorAt(rect.left + rect.width / 2, rect.top + rect.height / 2, action);
    } catch (e) { /* ignore */ }
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return false;
    var cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
    if (parseFloat(cs.opacity || "1") === 0) return false;
    if (el.hasAttribute && el.hasAttribute("hidden")) return false;
    return true;
  }

  function textOf(el) {
    if (!el) return "";
    var t = el.innerText || el.textContent || "";
    return String(t).replace(/\s+/g, " ").trim();
  }

  function roleOf(el) {
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

  function resolve(o) {
    o = o || {};
    if (o.ref != null && o.ref !== "") {
      var el = REFS.get(String(o.ref));
      if (el && el.isConnected) return el;
      return null;
    }
    if (o.selector) {
      try {
        var direct = document.querySelector(o.selector);
        if (direct) return direct;
      } catch (e) { /* continue to fallbacks */ }
    }
    if (Array.isArray(o.fallbacks)) {
      for (var i = 0; i < o.fallbacks.length; i++) {
        try {
          var fb = o.fallbacks[i] ? document.querySelector(o.fallbacks[i]) : null;
          if (fb) return fb;
        } catch (e) { /* continue */ }
      }
    }
    if (o.text) return findByText(o.text, o.nth || 0);
    return null;
  }

  function findByText(needle, nth) {
    needle = String(needle).toLowerCase();
    var pool = [];
    var all = document.querySelectorAll("a,button,input,select,textarea,summary,[role],h1,h2,h3,h4,li,td,span,div,p");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!isVisible(el)) continue;
      var hay = (textOf(el) + " " + (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("placeholder") || "")).toLowerCase();
      if (hay.indexOf(needle) === -1) continue;
      // 只取最贴近文本的节点：若子元素也命中则跳过父节点
      pool.push(el);
    }
    if (!pool.length) return null;
    pool.sort(function (a, b) {
      var ra = (ROLE_BY_TAG[a.tagName.toLowerCase()] || ROLE_BY_INPUT[(a.getAttribute("type") || "").toLowerCase()] || "") ? 0 : 1;
      var rb = (ROLE_BY_TAG[b.tagName.toLowerCase()] || ROLE_BY_INPUT[(b.getAttribute("type") || "").toLowerCase()] || "") ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return textOf(a).length - textOf(b).length;
    });
    return pool[Math.min(nth, pool.length - 1)];
  }

  function describeTarget(o) {
    o = o || {};
    if (o.ref) return "ref=" + o.ref;
    if (o.selector) return "selector=" + o.selector;
    if (o.text) return "text=" + o.text;
    return "(未指定目标)";
  }

  var state = {
    version: VERSION,
    refs: REFS,
    nextRef: 1,
    snapshotId: null,

    info: function () {
      return {
        title: document.title,
        url: location.href,
        readyState: document.readyState,
        scrollY: Math.round(window.scrollY),
        innerHeight: window.innerHeight,
        scrollHeight: Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement.scrollHeight),
        refs: REFS.size,
        snapshotId: state.snapshotId
      };
    },

    signature: function () {
      ensureObserver();
      return { ok: true, signature: activeSignature() };
    },

    focusIsPassword: function () {
      var el = document.activeElement;
      return { ok: true, sensitive: isPasswordField(el) };
    },

    snapshot: function (o) {
      o = o || {};
      var compact = o.compact === true || o.mode === "compact";
      var maxChars = o.maxChars || (compact ? 6000 : 14000);
      var maxDepth = o.maxDepth || 40;
      REFS.clear();
      state.nextRef = 1;
      var lines = [];
      var used = 0;
      var truncated = false;

      function push(line) {
        if (truncated) return;
        if (used + line.length + 1 > maxChars) { truncated = true; return; }
        used += line.length + 1;
        lines.push(line);
      }

      function walk(el, depth) {
        if (truncated || depth > maxDepth) return;
        if (!el || el.nodeType !== 1) return;
        if (ignoredNode(el)) return;
        var tag = el.tagName.toLowerCase();
        if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template" ||
            tag === "meta" || tag === "link" || tag === "head" || tag === "br" || tag === "hr" ||
            tag === "iframe" && false) return;
        if (!isVisible(el)) return;
        var indent = "  ".repeat(Math.min(depth, 10));
        var role = roleOf(el);
        var interactive = !!INTERACTIVE_TAGS[el.tagName] || (role && role !== "label");

        if (interactive) {
          var ref = "e" + (state.nextRef++);
          REFS.set(ref, el);
          var name = nameOf(el);
          var line = indent + "- " + (role || "element") + ' "' + name + '" [ref=' + ref + "]";
          if (tag === "input") {
            var type = String(el.getAttribute("type") || "text").toLowerCase();
            var value = isPasswordField(el) ? "[REDACTED]" : trunc(el.value, 60);
            line += " type=" + type + ' value="' + value + '"';
            if (isPasswordField(el)) line += " sensitive=password";
            if (el.checked) line += " checked";
            if (el.disabled) line += " disabled";
            if (el.required) line += " required";
          } else if (tag === "select") {
            var opts = [];
            for (var i = 0; i < Math.min(el.options.length, 8); i++) opts.push(el.options[i].value);
            line += ' value="' + trunc(el.value, 40) + '" options=[' + opts.join(", ") + (el.options.length > 8 ? ", …" : "") + "]";
          } else if (tag === "textarea") {
            line += ' value="' + trunc(el.value, 60) + '"';
          } else if (tag === "a" && el.getAttribute("href")) {
            line += ' href="' + trunc(el.getAttribute("href"), 80) + '"';
          }
          if (el.disabled && tag !== "input") line += " disabled";
          push(line);
        } else if (/^h[1-6]$/.test(tag)) {
          var ht = trunc(textOf(el), 120);
          if (ht) push(indent + "- heading[h" + tag.slice(1) + "] " + ht);
        } else if (!compact && !el.children.length) {
          var t = trunc(textOf(el), 160);
          if (t) push(indent + "- text: " + t);
        }

        var kids = el.children;
        for (var k = 0; k < kids.length; k++) walk(kids[k], depth + 1);
      }

      if (document.body) {
        var rootKids = document.body.children;
        for (var i = 0; i < rootKids.length; i++) walk(rootKids[i], 0);
      }
      ensureObserver();
      state.snapshotId = "s" + Date.now().toString(36);
      return {
        ok: true,
        title: document.title,
        url: location.href,
        snapshotId: state.snapshotId,
        refs: REFS.size,
        compact: compact,
        truncated: truncated,
        snapshot: lines.join("\n")
      };
    },

    /** 在视口坐标显示受控鼠标（用于 CDP 坐标点击/滚动） */
    cursorPoint: function (o) {
      o = o || {};
      var x = Number(o.x);
      var y = Number(o.y);
      if (!isFinite(x) || !isFinite(y)) return { ok: false, error: "坐标非法" };
      cursorAt(x, y, o.action || "move", { persistent: o.persistent === true });
      return { ok: true, x: x, y: y, action: o.action || "move", persistent: o.persistent === true };
    },

    /** 在视口中央显示受控鼠标（打开页面 / 读取 / 等待等无坐标动作） */
    cursorCenter: function (o) {
      o = o || {};
      var x = Math.round(window.innerWidth / 2);
      var y = Math.round(Math.max(96, Math.min(window.innerHeight * 0.42, window.innerHeight - 96)));
      var persistent = o.persistent !== false;
      cursorAt(x, y, o.action || "control", { persistent: persistent });
      return { ok: true, x: x, y: y, action: o.action || "control", persistent: persistent };
    },

    cursorState: function () {
      try {
        var cursor = globalThis.__AGBB_CURSOR;
        if (cursor && typeof cursor.state === "function") return cursor.state();
      } catch (e) { /* ignore */ }
      return { ok: false, error: "鼠标层未就绪" };
    },

    /** 移除受控鼠标（断开桥接 / 切换标签时清理） */
    cursorHide: function () {
      try {
        var cursor = globalThis.__AGBB_CURSOR;
        if (cursor && typeof cursor.hide === "function") cursor.hide();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    },

    /** 返回元素在视口中的点击坐标；真正派发鼠标事件由 CDP 完成 */
    locate: function (o) {
      var el = resolve(o);
      if (!el) return { ok: false, error: "未找到目标元素：" + describeTarget(o) };
      try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) { el.scrollIntoView(); }
      cursorOn(el, "move");
      var r = el.getBoundingClientRect();
      return {
        ok: true,
        x: Math.round((r.left + r.width / 2) * 100) / 100,
        y: Math.round((r.top + r.height / 2) * 100) / 100,
        tag: el.tagName.toLowerCase(),
        role: roleOf(el) || "",
        name: nameOf(el),
        inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth,
        ref: o && o.ref ? String(o.ref) : undefined
      };
    },

    /** 无 CDP 时的兜底点击：直接调用元素原生 click() */
    clickJs: function (o) {
      var el = resolve(o);
      if (!el) return { ok: false, error: "未找到目标元素：" + describeTarget(o) };
      try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) { el.scrollIntoView(); }
      cursorOn(el, "click");
      var tag = el.tagName.toLowerCase();
      var info = { ok: true, tag: tag, name: nameOf(el), method: "element.click()" };
      if (tag === "input" && (el.type === "checkbox" || el.type === "radio")) {
        el.click();
      } else if (el.click) {
        el.click();
      } else {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      }
      return info;
    },

    focus: function (o) {
      var el = resolve(o);
      if (!el) return { ok: false, error: "未找到目标元素：" + describeTarget(o) };
      try { el.scrollIntoView({ block: "center" }); } catch (e) { /* ignore */ }
      cursorOn(el, "type");
      if (el.focus) el.focus();
      var result = { ok: true, tag: el.tagName.toLowerCase(), name: nameOf(el) };
      if (isPasswordField(el)) result.sensitive = "password";
      return result;
    },

    /** 用原型上的 value setter 写值，兼容 React / Vue 的受控输入 */
    type: function (o) {
      o = o || {};
      var el = resolve(o);
      if (!el) return { ok: false, error: "未找到目标元素：" + describeTarget(o) };
      if (isPasswordField(el)) {
        return {
          ok: false,
          blocked: "password-field",
          error: "安全策略拒绝向密码框写入或读取内容（browser_type 不处理密码、验证码与支付凭据）"
        };
      }
      var tag = el.tagName.toLowerCase();
      var text = String(o.text == null ? "" : o.text);
      var clear = o.clear !== false;

      try { el.scrollIntoView({ block: "center" }); } catch (e) { /* ignore */ }
      cursorOn(el, "type");
      if (el.focus) el.focus();

      function readValue() {
        if (tag === "input" || tag === "textarea" || tag === "select") return el.value;
        if (el.isContentEditable) return el.textContent;
        return "";
      }
      function writeValue(v) {
        if (tag === "input" || tag === "textarea") {
          var proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          var d = Object.getOwnPropertyDescriptor(proto, "value");
          if (d && d.set) d.set.call(el, v); else el.value = v;
        } else if (el.isContentEditable) {
          el.textContent = v;
        } else {
          el.value = v;
        }
      }

      var before = readValue();
      var next = clear ? text : String(before) + text;
      writeValue(next);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      var after = readValue();
      var result = {
        ok: true,
        tag: tag,
        name: nameOf(el),
        value: trunc(after, 200),
        changed: after !== before
      };
      if (o.submit) result.submit = state.submitForm(el);
      return result;
    },

    submitForm: function (el) {
      var form = el && el.form ? el.form : (el && el.closest ? el.closest("form") : null);
      if (!form) return "未找到所属表单";
      if (form.requestSubmit) { form.requestSubmit(); return "已 requestSubmit()"; }
      form.submit();
      return "已 submit()";
    },

    select: function (o) {
      o = o || {};
      var el = resolve(o);
      if (!el) return { ok: false, error: "未找到目标元素：" + describeTarget(o) };
      if (el.tagName.toLowerCase() !== "select") {
        return { ok: false, error: "目标不是 <select> 元素，而是 <" + el.tagName.toLowerCase() + ">" };
      }
      var value = o.value;
      if (value == null && o.label != null) {
        var target = String(o.label).trim();
        for (var i = 0; i < el.options.length; i++) {
          if (el.options[i].textContent.trim() === target || el.options[i].label.trim() === target) {
            value = el.options[i].value;
            break;
          }
        }
        if (value == null) return { ok: false, error: "没有匹配 label 的选项：" + o.label };
      }
      if (value == null) return { ok: false, error: "需要提供 value 或 label" };
      cursorOn(el, "click");
      var d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
      if (d && d.set) d.set.call(el, String(value)); else el.value = String(value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      var out = [];
      for (var j = 0; j < Math.min(el.options.length, 50); j++) out.push(el.options[j].value);
      return { ok: true, value: el.value, options: out };
    },

    getText: function (o) {
      o = o || {};
      var maxChars = o.maxChars || 8000;
      var el = (o.ref || o.selector || o.text) ? resolve(o) : (document.body || document.documentElement);
      if (!el) return { ok: false, error: "未找到目标元素：" + describeTarget(o) };
      var t = textOf(el);
      return {
        ok: true,
        url: location.href,
        length: t.length,
        truncated: t.length > maxChars,
        text: t.length > maxChars ? t.slice(0, maxChars) + "…" : t
      };
    },

    extractData: function (o) {
      o = o || {};
      var maxItems = o.maxItems || 50;
      if (o.listSelector) {
        try {
          var nodes = document.querySelectorAll(o.listSelector);
          if (nodes && nodes.length) {
            var items = [];
            for (var i = 0; i < Math.min(nodes.length, maxItems); i++) {
              var txt = trunc(textOf(nodes[i]), 300);
              if (txt) items.push(txt);
            }
            return { ok: true, mode: "list", count: items.length, items: items, url: location.href };
          }
        } catch (e) { /* fallback to single resolve */ }
      }
      var el = resolve(o);
      if (!el) return { ok: false, error: "未找到要提取的目标元素：" + describeTarget(o) };
      cursorOn(el, "control");
      return { ok: true, mode: "single", text: trunc(textOf(el), 2000), url: location.href };
    },

    scrollJs: function (o) {
      o = o || {};
      var before = window.scrollY;
      if (o.ref || o.selector || o.text) {
        var el = resolve(o);
        if (!el) return { ok: false, error: "未找到目标元素：" + describeTarget(o) };
        try { el.scrollIntoView({ block: o.block || "center" }); } catch (e) { el.scrollIntoView(); }
        cursorOn(el, "scroll");
      } else {
        window.scrollBy(o.deltaX || 0, o.deltaY || 0);
        cursorAt(window.innerWidth / 2, window.innerHeight / 2, "scroll");
      }
      return {
        ok: true,
        scrollY: Math.round(window.scrollY),
        moved: Math.round(window.scrollY - before),
        innerHeight: window.innerHeight,
        scrollHeight: Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement.scrollHeight)
      };
    },

    /** 无 CDP 时的按键兜底：只覆盖有默认行为可模拟的少量按键 */
    pressJs: function (o) {
      o = o || {};
      var key = o.key;
      var el = document.activeElement || document.body;
      if (isPasswordField(el) && (String(key).length === 1 || key === "Backspace" || key === "Delete" || key === "Space")) {
        return { ok: false, blocked: "password-field", error: "安全策略拒绝向密码框发送字符输入" };
      }
      cursorOn(el, "type");
      if (key === "Enter") {
        var form = el && el.form ? el.form : (el && el.closest ? el.closest("form") : null);
        if (form) return { ok: true, key: key, effect: state.submitForm(el) };
      }
      if (key === "Tab") {
        var focusables = Array.prototype.slice.call(document.querySelectorAll(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
        )).filter(isVisible);
        var idx = focusables.indexOf(el);
        var next = focusables[idx + 1] || focusables[0];
        if (next) next.focus();
        return { ok: true, key: key, effect: "已把焦点移到下一个可聚焦元素（兜底模式）" };
      }
      if (key === "Escape" && el && el.blur) { el.blur(); return { ok: true, key: key, effect: "已 blur（兜底模式）" }; }
      if (el && el.dispatchEvent) {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: key, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: key, bubbles: true }));
        return { ok: true, key: key, effect: "仅派发了合成 keydown/keyup，站点默认行为可能不触发" };
      }
      return { ok: false, error: "兜底模式无法处理按键：" + key };
    },

    waitFor: function (o) {
      o = o || {};
      var timeout = o.timeoutMs || 15000;
      var started = Date.now();
      return new Promise(function (resolve) {
        function check() {
          var found = null;
          if (o.selector) {
            try {
              var el = document.querySelector(o.selector);
              if (el && isVisible(el)) found = { kind: "selector", selector: o.selector, tag: el.tagName.toLowerCase(), text: trunc(textOf(el), 120) };
            } catch (e) { return resolve({ ok: false, error: "选择器非法：" + o.selector }); }
          } else if (o.text) {
            var t = findByText(o.text, 0);
            if (t) found = { kind: "text", text: o.text, tag: t.tagName.toLowerCase(), match: trunc(textOf(t), 120) };
          } else {
            return resolve({ ok: false, error: "需要提供 selector 或 text" });
          }
          if (found) {
            found.ok = true;
            found.waitedMs = Date.now() - started;
            return resolve(found);
          }
          if (Date.now() - started >= timeout) {
            return resolve({ ok: false, error: "等待超时（" + timeout + "ms）", waitedMs: Date.now() - started });
          }
          setTimeout(check, 200);
        }
        check();
      });
    }
  };

  globalThis.__AG_PA = state;
})();
