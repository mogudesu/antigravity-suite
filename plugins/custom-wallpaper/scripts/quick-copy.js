/**
 * quick-copy.js
 * 右侧 Artifact 面板与主对话顶栏的 ⋮ 旁一键复制。
 * 优先调用 React Fiber 里原生的复制动作，拿不到时回退到 DOM 文本/官方 Markdown 接口。
 */
(function () {
  if (window.__agQuickCopyInstalledV2) return;
  window.__agQuickCopyInstalledV2 = true;

  const STYLE_ID = "ag-quick-copy-style";
  const ARTIFACT_CLASS = "ag-quick-copy-btn";
  const CHAT_CLASS = "ag-quick-copy-chat";
  const TOAST_ID = "ag-copy-toast";

  const cfg = () => window.__AG_CONFIG || {};
  const isEn = () => String(cfg().language || "zh-CN").toLowerCase() === "en";
  const tr = (zh, en) => (isEn() ? en : zh);

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .${ARTIFACT_CLASS},.${CHAT_CLASS}{display:inline-flex!important;align-items:center!important;gap:4px!important;height:24px!important;padding:0 8px!important;
        border:1px solid rgba(255,255,255,.09)!important;border-radius:7px!important;background:rgba(255,255,255,.035)!important;color:#b9c8da!important;
        font:500 11px/1 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif!important;cursor:pointer!important;white-space:nowrap!important;
        transition:background-color .15s ease,border-color .15s ease,color .15s ease!important;vertical-align:middle!important}
      .${ARTIFACT_CLASS}:hover,.${CHAT_CLASS}:hover{border-color:rgba(246,216,147,.28)!important;background:rgba(246,216,147,.08)!important;color:#f6f1e6!important}
      .${ARTIFACT_CLASS}.is-done,.${CHAT_CLASS}.is-done{border-color:rgba(134,224,192,.28)!important;background:rgba(134,224,192,.07)!important;color:#86e0c0!important}
      .${ARTIFACT_CLASS} svg,.${CHAT_CLASS} svg{width:12px!important;height:12px!important;flex:0 0 12px!important;opacity:.85}
      .${ARTIFACT_CLASS}.hide-label span,.${CHAT_CLASS}.hide-label span{display:none!important}
      #${TOAST_ID}{position:fixed;left:50%;bottom:26px;transform:translate(-50%,8px);z-index:10001;padding:7px 12px;border:1px solid rgba(196,181,253,.2);border-radius:999px;background:rgba(12,14,26,.94);color:#e9eef8;font:500 11px/1.4 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;opacity:0;pointer-events:none;transition:opacity .16s ease,transform .16s ease}
      #${TOAST_ID}.is-visible{opacity:1;transform:translate(-50%,0)}
    `;
    document.head.appendChild(style);
  }

  const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"></path></svg>';

  function toast(message) {
    ensureStyle();
    let node = document.getElementById(TOAST_ID);
    if (!node) {
      node = document.createElement("div");
      node.id = TOAST_ID;
      document.body.appendChild(node);
    }
    node.textContent = message;
    node.classList.add("is-visible");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove("is-visible"), 1700);
  }

  async function copyText(value) {
    const text = String(value == null ? "" : value);
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        area.remove();
        return ok;
      } catch (fallbackError) {
        return false;
      }
    }
  }

  function fiberOf(node) {
    if (!node) return null;
    const key = Object.keys(node).find((name) => name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$"));
    return key ? node[key] : null;
  }

  function findFiberAction(node, matcher) {
    let fiber = fiberOf(node);
    let depth = 0;
    while (fiber && depth < 18) {
      const props = fiber.memoizedProps;
      if (props && Array.isArray(props.overflowActions)) {
        const action = props.overflowActions.find((item) => matcher(item));
        if (action) return action;
      }
      if (props && typeof props.onCopy === "function") return { onClick: props.onCopy };
      fiber = fiber.return;
      depth += 1;
    }
    return null;
  }

  function findFiberContents(node) {
    let fiber = fiberOf(node);
    let depth = 0;
    while (fiber && depth < 18) {
      const props = fiber.memoizedProps;
      if (props) {
        if (typeof props.contents === "string" && props.contents.trim()) return props.contents;
        if (typeof props.markdown === "string" && props.markdown.trim()) return props.markdown;
        if (typeof props.content === "string" && props.content.trim() && props.content.includes("\n")) return props.content;
      }
      fiber = fiber.return;
      depth += 1;
    }
    return "";
  }

  function artifactRoot(button) {
    return button.closest('[data-testid="artifact-view"]') ||
      button.closest('[data-aux-pane-focus-scope="true"]') ||
      document.querySelector('[data-testid="artifact-view"], [data-aux-pane-focus-scope="true"]') ||
      document;
  }

  function artifactMarkdown(button) {
    const root = artifactRoot(button) || document;
    const markdown = root.querySelector("[data-markdown-root]");
    if (markdown) return String(markdown.innerText || "").trim();
    const code = root.querySelector("pre, code");
    if (code) return String(code.innerText || "").trim();
    return String(root.innerText || "").trim();
  }

  async function handleArtifactCopy(button, event) {
    const more = button.nextElementSibling?.matches("[data-testid=more-actions-overflow]")
      ? button.nextElementSibling
      : button.parentElement?.querySelector("[data-testid=more-actions-overflow]");
    const anchor = more || button;
    if (event.shiftKey) {
      const pathAction = findFiberAction(anchor, (item) => /link_2|path|copy_path|Copy Path/i.test(
        [item.iconName, item.icon, item.label, item.tooltip, item.name].filter(Boolean).join(" ")
      ));
      if (pathAction && typeof pathAction.onClick === "function") {
        try { pathAction.onClick({ preventDefault() {}, stopPropagation() {}, shiftKey: true }); } catch (error) {}
        toast(tr("已复制文件路径", "File path copied"));
        return;
      }
      const path = artifactRoot(button)?.getAttribute("data-file-path") || "";
      if (path && await copyText(path)) {
        toast(tr("已复制文件路径", "File path copied"));
      } else {
        toast(tr("未找到可复制的文件路径", "No file path available"));
      }
      return;
    }

    const native = findFiberAction(anchor, (item) => /content_copy|content-copy|copy/i.test(
      [item.iconName, item.icon, item.label, item.tooltip, item.name].filter(Boolean).join(" ")
    ));
    if (native && typeof native.onClick === "function") {
      try {
        native.onClick({ preventDefault() {}, stopPropagation() {}, currentTarget: anchor });
        markDone(button, tr("✓ 已复制", "✓ Copied"));
        toast(tr("已复制到剪贴板", "Copied to clipboard"));
        return;
      } catch (error) {}
    }
    const fiberContents = findFiberContents(anchor);
    const value = fiberContents || artifactMarkdown(button);
    if (!value) {
      toast(tr("没有可复制的内容", "Nothing to copy"));
      return;
    }
    if (await copyText(value)) {
      markDone(button, tr("✓ 已复制", "✓ Copied"));
      toast(tr("已复制到剪贴板", "Copied to clipboard"));
    } else {
      toast(tr("复制失败，请聚焦窗口后重试", "Copy failed; focus the window and retry"));
    }
  }

  function markDone(button, labelText) {
    const label = button.querySelector("span");
    if (!label) return;
    const original = label.textContent;
    label.textContent = labelText;
    button.classList.add("is-done");
    setTimeout(() => {
      label.textContent = original;
      button.classList.remove("is-done");
    }, 1600);
  }

  // Style-only visibility. A getBoundingClientRect() inside this filter forced a full relayout
  // on every animation frame while the page was streaming.
  function isRendered(node) {
    return typeof node.checkVisibility === "function"
      ? node.checkVisibility({ contentVisibilityAuto: false, opacity: true, visibility: true })
      : node.getBoundingClientRect().width > 0;
  }

  function ensureArtifactButtons() {
    if (cfg().quickCopyButton === false) {
      document.querySelectorAll(`.${ARTIFACT_CLASS},.${CHAT_CLASS}`).forEach((node) => node.remove());
      return;
    }
    const moreButtons = Array.from(document.querySelectorAll('[data-testid="more-actions-overflow"]'))
      .filter((node) => !node.closest(".bg-sidebar") && !node.closest(`.${ARTIFACT_CLASS}`) && isRendered(node));
    moreButtons.forEach((more) => {
      const parent = more.parentElement;
      if (!parent || parent.querySelector(`.${ARTIFACT_CLASS}`)) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = ARTIFACT_CLASS;
      button.title = tr("复制当前内容（Shift 复制文件路径）", "Copy content (Shift: copy file path)");
      button.innerHTML = COPY_ICON + `<span>${tr("复制", "Copy")}</span>`;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        handleArtifactCopy(button, event);
      });
      parent.insertBefore(button, more);
    });

    const chatKebab = document.querySelector('[data-testid="titlebar-more-actions"]') ||
      Array.from(document.querySelectorAll('[data-testid="conversation-kebab"]'))
        .find((node) => !node.closest(".bg-sidebar") && !node.closest('[data-testid="conversation-row-sidebar"]'));
    if (!chatKebab) return;
    const parent = chatKebab.parentElement;
    if (!parent || parent.querySelector(`.${CHAT_CLASS}`)) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = CHAT_CLASS;
    button.title = tr("复制当前对话为 Markdown", "Copy conversation as Markdown");
    button.innerHTML = COPY_ICON + `<span>${tr("复制对话", "Copy chat")}</span>`;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      copyConversation(button);
    });
    parent.insertBefore(button, chatKebab);
  }

  function currentCascadeId() {
    const match = String(location.pathname || "").match(/\/c\/([0-9a-f-]{8,})/i);
    return match ? match[1] : "";
  }

  async function fetchOfficialMarkdown(id) {
    const token = window.__APP_CONFIG__?.csrfToken;
    if (!token || !id) throw new Error("missing token");
    const candidates = [{ cascadeId: id }, { conversationId: id }, { trajectoryId: id }];
    for (const payload of candidates) {
      try {
        const json = JSON.stringify(payload);
        const body = new TextEncoder().encode(json);
        const frame = new Uint8Array(5 + body.length);
        frame[4] = body.length;
        frame.set(body, 5);
        const response = await fetch("/exa.language_server_pb.LanguageServerService/ConvertTrajectoryToMarkdown", {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/grpc-web+json",
            "x-grpc-web": "1",
            "x-codeium-csrf-token": token,
            "x-user-agent": "CONNECT_ES_USER_AGENT",
          },
          body: frame,
        });
        if (!response.ok) continue;
        const buffer = new Uint8Array(await response.arrayBuffer());
        let offset = 0;
        while (offset + 5 <= buffer.length) {
          const length = (buffer[offset + 1] << 24) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 8) | buffer[offset + 4];
          const start = offset + 5;
          const end = start + length;
          offset = end;
          if (length <= 0 || end > buffer.length) break;
          let parsed = null;
          try { parsed = JSON.parse(new TextDecoder().decode(buffer.slice(start, end))); } catch (error) {}
          const markdown = parsed?.markdown || parsed?.response?.markdown || parsed?.content || parsed?.response?.content;
          if (typeof markdown === "string" && markdown.trim()) return markdown;
        }
      } catch (error) {}
    }
    return "";
  }

  function collectConversationMarkdown() {
    const parts = [];
    const roots = Array.from(document.querySelectorAll('[aria-label="User message"], [aria-label="Agent response"], [data-testid*="turn-card"]'));
    roots.forEach((node) => {
      const text = String(node.innerText || "").trim();
      if (!text) return;
      const role = node.getAttribute("aria-label") === "User message" ? "User" : node.getAttribute("aria-label") === "Agent response" ? "Assistant" : "Turn";
      parts.push(`## ${role}\n\n${text}`);
    });
    return parts.join("\n\n---\n\n");
  }

  async function copyConversation(button) {
    const id = currentCascadeId();
    button.disabled = true;
    try {
      let value = "";
      try { value = await fetchOfficialMarkdown(id); } catch (error) {}
      if (!value) value = collectConversationMarkdown();
      if (!value) {
        toast(tr("没有可复制的对话内容", "Nothing to copy"));
        return;
      }
      if (await copyText(value)) {
        markDone(button, tr("✓ 已复制", "✓ Copied"));
        toast(tr("对话已复制为 Markdown", "Conversation copied as Markdown"));
      } else {
        toast(tr("复制失败，请聚焦窗口后重试", "Copy failed; focus the window and retry"));
      }
    } finally {
      button.disabled = false;
    }
  }

  function syncLabels() {
    const artLabel = tr("复制", "Copy");
    const artTitle = tr("复制当前内容（Shift 复制文件路径）", "Copy content (Shift: copy file path)");
    document.querySelectorAll(`.${ARTIFACT_CLASS}`).forEach((button) => {
      const label = button.querySelector("span");
      if (label) label.textContent = artLabel;
      button.title = artTitle;
    });
    const chatLabel = tr("复制对话", "Copy chat");
    const chatTitle = tr("复制当前对话为 Markdown", "Copy conversation as Markdown");
    document.querySelectorAll(`.${CHAT_CLASS}`).forEach((button) => {
      const label = button.querySelector("span");
      if (label) label.textContent = chatLabel;
      button.title = chatTitle;
    });
  }

  function tick() {
    ensureStyle();
    ensureArtifactButtons();
    syncLabels();
  }

  // Streaming mutates the DOM every frame; a copy button landing 300ms late is invisible,
  // re-measuring the document 60 times a second is not.
  let scheduled = 0;
  const schedule = () => {
    if (scheduled) return;
    scheduled = window.setTimeout(() => {
      scheduled = 0;
      tick();
    }, 300);
  };

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("ag-config-updated", schedule);
  setInterval(tick, 1500);
  tick();})();
