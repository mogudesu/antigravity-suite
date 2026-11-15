/**
 * media-preview.js
 * Stage 3: 本地大视频右侧按需预览、系统播放器打开与安全句柄管理。
 *
 * - 拦截聊天与文件树中的本地视频点击（单次左键）直接右侧预览。
 * - 在“文件超过 20MB 显示限制”错误页补充「预览视频」与「选择本地视频」入口。
 * - 通过 sidecar 分块 Range (/media/{id}) 流式播放，禁止 Base64/Blob 全量加载。
 * - 支持系统播放器打开、资源管理器显示、复制路径、关闭/卸载时失效句柄。
 */
(function () {
  const VERSION = "1.2.0";
  if (window.__agMediaPreviewInstalled === VERSION) {
    try { window.__agMediaPreview?.refresh?.(); } catch (_) {}
    return;
  }
  if (typeof window.__agMediaPreviewDispose === "function") {
    try { window.__agMediaPreviewDispose(); } catch (_) {}
  }
  window.__agMediaPreviewInstalled = VERSION;

  const STYLE_ID = "ag-media-preview-style";
  const ROOT_ID = "ag-media-preview-root";
  const TOAST_ID = "ag-media-preview-toast";
  const PICKER_BTN_ATTR = "data-ag-media-picker";
  const OVERSIZE_BAR_ATTR = "data-ag-media-oversize-bar";
  const VIDEO_EXT_RE = /\.(mp4|m4v|webm|mov|mkv|avi|ogv)(?:[?#].*)?$/i;

  const bus = window.__agStarlightBus;
  let disposed = false;
  let activeHandle = null; // { id, path, name, mime, size, streamUrl, sourceTabId }
  let isSeeking = false;
  let hiddenFileInput = null;
  let unsubMutation = null;
  let unsubTick = null;
  let scanScheduled = false;
  let toastTimer = 0;
  let frameChannel = "";
  let frameReady = false;
  let pendingFrameCmd = null;

  function defaultPlaybackState() {
    return {
      paused: true,
      autoplay: false,
      ended: false,
      seeking: false,
      muted: false,
      volume: 1,
      playbackRate: 1,
      currentTime: 0,
      duration: 0,
      videoWidth: 0,
      videoHeight: 0,
      readyState: 0,
      networkState: 0,
      errorCode: 0,
    };
  }

  let playbackState = defaultPlaybackState();

  function isEnabled() {
    if (document.documentElement.classList.contains("ag-video-preview-disabled")) return false;
    return window.__AG_CONFIG?.videoPreviewEnabled !== false;
  }

  function resolveSidecarPort() {
    return Number(window.__AG_SIDECAR_PORT || window.__agConfig?.sidecarPort || 39290) || 39290;
  }

  function sidecarBase() {
    return "http://127.0.0.1:" + resolveSidecarPort();
  }

  function sidecarToken() {
    return String(window.__AG_STARLIGHT_TOKEN__ || window.__agConfig?.sidecarToken || "").trim();
  }

  function nextFrameChannel() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function playerFrameUrl(channel) {
    const qs = new URLSearchParams();
    qs.set("channel", channel);
    if (window.location?.origin && window.location.origin !== "null") {
      qs.set("po", window.location.origin);
    }
    return `${sidecarBase()}/media-player.html?${qs.toString()}`;
  }

  function ensurePlayerFrameSrc(root) {
    const frame = root?.querySelector("[data-mp-frame]");
    if (!frame) return null;
    const port = String(resolveSidecarPort());
    if (!frameChannel || frame.getAttribute("data-port") !== port || !String(frame.getAttribute("src") || "").startsWith(sidecarBase())) {
      frameChannel = nextFrameChannel();
      frameReady = false;
      frame.setAttribute("data-port", port);
      frame.setAttribute("data-channel", frameChannel);
      frame.src = playerFrameUrl(frameChannel);
    }
    return frame;
  }

  function sendPlayerCommand(type, payload) {
    const root = document.getElementById(ROOT_ID);
    const frame = root?.querySelector("[data-mp-frame]");
    if (!frame || !frameChannel) return false;
    const msg = Object.assign({ type, channel: frameChannel }, payload || {});
    if (!frameReady || !frame.contentWindow) {
      if (type === "load" || type === "clear") {
        pendingFrameCmd = msg;
      }
      return false;
    }
    try {
      frame.contentWindow.postMessage(msg, sidecarBase());
      return true;
    } catch (_) {
      return false;
    }
  }

  function authHeaders(extra) {
    const token = sidecarToken();
    return Object.assign(
      { "Content-Type": "application/json" },
      token ? { "X-Starlight-Token": token } : {},
      extra || {}
    );
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return "--";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function formatTime(sec) {
    const n = Number(sec);
    if (!Number.isFinite(n) || n < 0) return "00:00";
    const total = Math.floor(n);
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const pad = (v) => String(v).padStart(2, "0");
    return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
  }

  function safeDecode(text) {
    try { return decodeURIComponent(text); } catch (_) { return text; }
  }

  function decodeUriToLocalPath(raw) {
    const text = String(raw || "").trim().replace(/^["']|["']$/g, "");
    if (!text) return "";
    if (/^https?:|^blob:|^data:/i.test(text)) return "";
    if (/^file:\/\//i.test(text)) {
      try {
        const parsed = new URL(text);
        let pathname = safeDecode(parsed.pathname || "");
        const host = safeDecode(parsed.hostname || "");
        if (host && host.toLowerCase() !== "localhost") {
          return ("//" + host + pathname).replace(/\//g, "\\");
        }
        if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1);
        return pathname.replace(/\//g, "\\");
      } catch (_) {
        let stripped = safeDecode(text.replace(/^file:\/\//i, ""));
        if (/^\/[A-Za-z]:/.test(stripped)) stripped = stripped.slice(1);
        return stripped.replace(/\//g, "\\");
      }
    }
    if (/^[A-Za-z]:[\\/]/.test(text) || /^\\\\/.test(text) || text.startsWith("/")) {
      return text;
    }
    return "";
  }

  function isLocalVideoTarget(raw) {
    const decoded = decodeUriToLocalPath(raw);
    if (!decoded) return "";
    return VIDEO_EXT_RE.test(decoded) ? decoded : "";
  }

  function readFiberFilePath(node) {
    if (!node || typeof node !== "object") return "";
    const fiberKey = Object.keys(node).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactProps$"));
    if (!fiberKey) return "";
    let cur = node[fiberKey];
    for (let depth = 0; depth < 10 && cur; depth += 1) {
      const props = cur.memoizedProps || cur;
      const candidates = [
        props?.entry?.uri,
        props?.node?.uri,
        props?.item?.uri,
        props?.resource?.uri,
        props?.fileUri,
        props?.uri,
        props?.entry?.path,
        props?.node?.path,
        props?.item?.path,
        props?.filePath,
        props?.path,
      ];
      for (const c of candidates) {
        if (typeof c === "string") {
          const hit = isLocalVideoTarget(c);
          if (hit) return hit;
        }
      }
      cur = cur.return;
    }
    return "";
  }

  function extractVideoPathFromEventTarget(target) {
    if (!(target instanceof Element)) return "";
    if (target.closest(`#${ROOT_ID}, [${OVERSIZE_BAR_ATTR}], [${PICKER_BTN_ATTR}]`)) return "";

    const pill = target.closest("button.inline-pill[data-uri], a[href]");
    if (pill) {
      const candidates = [
        pill.getAttribute("data-uri"),
        pill.getAttribute("title"),
        pill.getAttribute("href"),
      ];
      for (const c of candidates) {
        const hit = isLocalVideoTarget(c);
        if (hit) return hit;
      }
    }

    const treeItem = target.closest('[data-testid="tab-file-tree-sidebar"] [role="treeitem"]');
    if (treeItem) {
      const fiberHit = readFiberFilePath(treeItem);
      if (fiberHit) return fiberHit;
      const domHit = isLocalVideoTarget(treeItem.getAttribute("data-uri") || treeItem.getAttribute("title") || "");
      if (domHit) return domHit;
    }

    return "";
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      html.ag-video-preview-disabled [${PICKER_BTN_ATTR}],
      html.ag-video-preview-disabled [${OVERSIZE_BAR_ATTR}],
      html.ag-video-preview-disabled #${ROOT_ID} {
        display: none !important;
      }
      .ag-media-host {
        position: relative !important;
      }
      [${PICKER_BTN_ATTR}] {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: 24px;
        padding: 0 9px;
        margin-left: auto;
        border-radius: 7px;
        border: 1px solid rgba(196, 181, 253, 0.24);
        background: rgba(139, 92, 246, 0.16);
        color: #f3efff;
        font: 500 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        cursor: pointer;
        white-space: nowrap;
        flex-shrink: 0;
        transition: background-color 140ms ease, border-color 140ms ease;
        -webkit-app-region: no-drag;
      }
      [${PICKER_BTN_ATTR}]:hover {
        background: rgba(139, 92, 246, 0.30);
        border-color: rgba(246, 216, 147, 0.45);
      }
      [${OVERSIZE_BAR_ATTR}] {
        display: inline-flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin-left: 8px;
        vertical-align: middle;
      }
      .ag-media-cta-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 30px;
        padding: 0 12px;
        border-radius: 8px;
        border: 1px solid rgba(246, 216, 147, 0.42);
        background: linear-gradient(180deg, rgba(139, 92, 246, 0.34) 0%, rgba(91, 56, 179, 0.30) 100%);
        color: #fff6df;
        font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        cursor: pointer;
        transition: filter 140ms ease, transform 120ms ease;
      }
      .ag-media-cta-btn:hover {
        filter: brightness(1.12);
      }
      .ag-media-cta-btn.is-secondary {
        border-color: rgba(196, 181, 253, 0.28);
        background: rgba(24, 19, 48, 0.78);
        color: #e4defc;
        font-weight: 500;
      }
      #${ROOT_ID} {
        position: absolute;
        inset: 0;
        z-index: 65;
        display: flex;
        flex-direction: column;
        background: #0b0917;
        color: #f4f2ff;
        border-left: 1px solid rgba(196, 181, 253, 0.16);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        overflow: hidden;
      }
      #${ROOT_ID}.is-floating-dock {
        position: fixed;
        top: 40px;
        right: 12px;
        bottom: 14px;
        left: auto;
        width: min(52vw, 760px);
        min-width: 380px;
        border-radius: 12px;
        border: 1px solid rgba(196, 181, 253, 0.24);
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.65);
        z-index: 9990;
      }
      #${ROOT_ID} .ag-mp-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 9px 12px;
        background: rgba(18, 14, 38, 0.96);
        border-bottom: 1px solid rgba(196, 181, 253, 0.16);
        flex-shrink: 0;
      }
      #${ROOT_ID} .ag-mp-meta {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      #${ROOT_ID} .ag-mp-title {
        font-size: 13px;
        font-weight: 600;
        color: #fff8e7;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #${ROOT_ID} .ag-mp-sub {
        font-size: 11px;
        color: #b2aad6;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #${ROOT_ID} .ag-mp-toolbar {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
        flex-shrink: 0;
      }
      #${ROOT_ID} .ag-mp-btn {
        height: 26px;
        padding: 0 9px;
        border-radius: 6px;
        border: 1px solid rgba(196, 181, 253, 0.22);
        background: rgba(34, 27, 66, 0.86);
        color: #ebe6ff;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        white-space: nowrap;
        transition: background-color 140ms ease, border-color 140ms ease;
      }
      #${ROOT_ID} .ag-mp-btn:hover {
        background: rgba(139, 92, 246, 0.28);
        border-color: rgba(246, 216, 147, 0.42);
      }
      #${ROOT_ID} .ag-mp-btn.is-close {
        border-color: rgba(248, 113, 113, 0.30);
        color: #fecaca;
      }
      #${ROOT_ID} .ag-mp-btn.is-close:hover {
        background: rgba(239, 68, 68, 0.22);
      }
      #${ROOT_ID} .ag-mp-stage {
        position: relative;
        flex: 1;
        min-height: 180px;
        background: #06050d;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
      }
      #${ROOT_ID} iframe.ag-mp-frame {
        width: 100%;
        height: 100%;
        border: 0;
        display: block;
        background: #06050d;
      }
      #${ROOT_ID} .ag-mp-status-overlay {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 10px;
        padding: 20px;
        text-align: center;
        background: rgba(8, 6, 18, 0.88);
        color: #efeaff;
      }
      #${ROOT_ID} .ag-mp-status-overlay[hidden] {
        display: none;
      }
      #${ROOT_ID} .ag-mp-status-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 8px;
        margin-top: 4px;
      }
      #${ROOT_ID} .ag-mp-controls {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        background: rgba(16, 12, 34, 0.96);
        border-top: 1px solid rgba(196, 181, 253, 0.16);
        flex-shrink: 0;
      }
      #${ROOT_ID} .ag-mp-seek {
        flex: 1;
        min-width: 80px;
        accent-color: #f6d893;
        cursor: pointer;
      }
      #${ROOT_ID} .ag-mp-vol {
        width: 68px;
        accent-color: #c4b5fd;
        cursor: pointer;
      }
      #${ROOT_ID} .ag-mp-time {
        font-family: "Cascadia Code", Consolas, monospace;
        font-size: 11px;
        color: #d6cff4;
        white-space: nowrap;
      }
      #${ROOT_ID} .ag-mp-rate {
        height: 24px;
        padding: 0 6px;
        border-radius: 6px;
        border: 1px solid rgba(196, 181, 253, 0.24);
        background: rgba(34, 27, 66, 0.90);
        color: #f3efff;
        font-size: 11px;
        cursor: pointer;
      }
      #${TOAST_ID} {
        position: fixed;
        left: 50%;
        bottom: 38px;
        transform: translate(-50%, 8px);
        z-index: 10020;
        max-width: min(82vw, 520px);
        padding: 8px 14px;
        border-radius: 999px;
        border: 1px solid rgba(196, 181, 253, 0.28);
        background: rgba(14, 12, 28, 0.96);
        color: #f8f5ff;
        font: 500 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        opacity: 0;
        pointer-events: none;
        transition: opacity 150ms ease, transform 150ms ease;
      }
      #${TOAST_ID}.is-visible {
        opacity: 1;
        transform: translate(-50%, 0);
      }
    `;
    document.head.appendChild(style);
  }

  function showToast(msg, durationMs) {
    ensureStyle();
    let node = document.getElementById(TOAST_ID);
    if (!node) {
      node = document.createElement("div");
      node.id = TOAST_ID;
      document.body.appendChild(node);
    }
    node.textContent = String(msg || "");
    node.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("is-visible"), durationMs || 2600);
  }

  async function apiJson(path, body, opts) {
    const url = sidecarBase() + path;
    const response = await fetch(url, Object.assign({
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body || {}),
    }, opts || {}));
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || ("HTTP " + response.status));
    }
    return data;
  }

  function closeHandle(handle, useKeepalive) {
    if (!handle || !handle.id) return Promise.resolve();
    const id = encodeURIComponent(handle.id);
    const url = sidecarBase() + `/api/media/${id}/close`;
    try {
      return fetch(url, {
        method: "POST",
        headers: authHeaders(),
        body: "{}",
        keepalive: Boolean(useKeepalive),
      }).catch(() => {});
    } catch (_) {
      return Promise.resolve();
    }
  }

  function findSidePanelHost() {
    const fileViewer = document.querySelector('[data-side-panel-open="true"] [aria-label="File Viewer"]');
    if (fileViewer instanceof HTMLElement && fileViewer.getBoundingClientRect().width >= 160) {
      return { host: fileViewer, floating: false };
    }
    const sideBody = document.querySelector('[data-side-panel-open="true"] [data-side-panel-body="true"]');
    if (sideBody instanceof HTMLElement && sideBody.getBoundingClientRect().width >= 160) {
      const firstViewer = Array.from(sideBody.children).find(
        (c) => c instanceof HTMLElement && !c.matches('[data-testid="tab-file-tree-sidebar"]') && c.getBoundingClientRect().width >= 120
      );
      if (firstViewer) return { host: firstViewer, floating: false };
      return { host: sideBody, floating: false };
    }
    return { host: document.body, floating: true };
  }

  function clearHostMarkers() {
    document.querySelectorAll(".ag-media-host").forEach((el) => {
      if (!el.querySelector(`#${ROOT_ID}`)) el.classList.remove("ag-media-host");
    });
  }

  function unmountOverlay(keepalive) {
    const handle = activeHandle;
    activeHandle = null;
    pendingFrameCmd = null;
    playbackState = defaultPlaybackState();
    const root = document.getElementById(ROOT_ID);
    if (root) {
      const frame = root.querySelector("iframe.ag-mp-frame");
      if (frame) {
        try {
          if (frameReady && frame.contentWindow) {
            frame.contentWindow.postMessage({ type: "clear", channel: frameChannel }, sidecarBase());
          }
          frame.src = "about:blank";
        } catch (_) {}
      }
      root.remove();
    }
    frameReady = false;
    frameChannel = "";
    clearHostMarkers();
    if (handle) void closeHandle(handle, keepalive);
    try { window.__agUpdateReadingMask?.(); } catch (_) {}
  }

  function createOrMountPlayerRoot() {
    ensureStyle();
    let root = document.getElementById(ROOT_ID);
    const { host, floating } = findSidePanelHost();
    if (!root) {
      root = document.createElement("section");
      root.id = ROOT_ID;
      root.setAttribute("role", "region");
      root.setAttribute("aria-label", "本地视频预览");
      root.innerHTML = `
        <div class="ag-mp-header">
          <div class="ag-mp-meta">
            <div class="ag-mp-title" data-mp-title>准备加载视频...</div>
            <div class="ag-mp-sub" data-mp-sub>--</div>
          </div>
          <div class="ag-mp-toolbar">
            <button type="button" class="ag-mp-btn" data-mp-action="pick">选择本地视频</button>
            <button type="button" class="ag-mp-btn" data-mp-action="open">系统播放器打开</button>
            <button type="button" class="ag-mp-btn" data-mp-action="reveal">在资源管理器显示</button>
            <button type="button" class="ag-mp-btn" data-mp-action="copy">复制路径</button>
            <button type="button" class="ag-mp-btn is-close" data-mp-action="close" aria-label="关闭视频预览">关闭</button>
          </div>
        </div>
        <div class="ag-mp-stage" data-mp-stage>
          <iframe class="ag-mp-frame" data-mp-frame title="本地视频播放器" allow="fullscreen"></iframe>
          <div class="ag-mp-status-overlay" data-mp-status hidden>
            <div data-mp-status-text></div>
            <div class="ag-mp-status-actions" data-mp-status-actions></div>
          </div>
        </div>
        <div class="ag-mp-controls">
          <button type="button" class="ag-mp-btn" data-mp-play>播放</button>
          <span class="ag-mp-time" data-mp-time>00:00 / 00:00</span>
          <input type="range" class="ag-mp-seek" data-mp-seek min="0" max="1000" step="1" value="0" aria-label="播放进度">
          <button type="button" class="ag-mp-btn" data-mp-mute>静音</button>
          <input type="range" class="ag-mp-vol" data-mp-vol min="0" max="1" step="0.05" value="1" aria-label="音量">
          <select class="ag-mp-rate" data-mp-rate aria-label="倍速">
            <option value="0.5">0.5x</option>
            <option value="0.75">0.75x</option>
            <option value="1" selected>1.0x</option>
            <option value="1.25">1.25x</option>
            <option value="1.5">1.5x</option>
            <option value="2">2.0x</option>
          </select>
          <button type="button" class="ag-mp-btn" data-mp-fullscreen>全屏</button>
        </div>
      `;
      wirePlayerDom(root);
    }

    root.classList.toggle("is-floating-dock", floating);
    if (!floating && host instanceof HTMLElement) {
      host.classList.add("ag-media-host");
      if (root.parentElement !== host) host.appendChild(root);
    } else if (root.parentElement !== document.body) {
      document.body.appendChild(root);
    }
    return root;
  }

  function syncControlsFromState(root) {
    if (!root) return;
    const playBtn = root.querySelector("[data-mp-play]");
    const timeLabel = root.querySelector("[data-mp-time]");
    const seekInput = root.querySelector("[data-mp-seek]");
    const muteBtn = root.querySelector("[data-mp-mute]");
    const volInput = root.querySelector("[data-mp-vol]");
    const rateSelect = root.querySelector("[data-mp-rate]");

    if (playBtn) {
      playBtn.textContent = playbackState.paused || playbackState.ended ? "播放" : "暂停";
    }
    const dur = Number.isFinite(playbackState.duration) && playbackState.duration > 0 ? playbackState.duration : 0;
    const cur = Number.isFinite(playbackState.currentTime) && playbackState.currentTime >= 0 ? playbackState.currentTime : 0;
    if (timeLabel) {
      timeLabel.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
    }
    if (seekInput && !isSeeking) {
      seekInput.value = dur > 0 ? String(Math.round((cur / dur) * 1000)) : "0";
    }
    if (muteBtn) {
      muteBtn.textContent = playbackState.muted || playbackState.volume === 0 ? "取消静音" : "静音";
    }
    if (volInput && document.activeElement !== volInput && Number.isFinite(playbackState.volume)) {
      volInput.value = String(playbackState.volume);
    }
    if (rateSelect && document.activeElement !== rateSelect && Number.isFinite(playbackState.playbackRate)) {
      const target = String(playbackState.playbackRate);
      if (Array.from(rateSelect.options).some((o) => o.value === target)) {
        rateSelect.value = target;
      }
    }
  }

  function onPlayerMessage(event) {
    const root = document.getElementById(ROOT_ID);
    const frame = root?.querySelector("[data-mp-frame]");
    if (!frame || event.source !== frame.contentWindow) return;
    if (event.origin !== sidecarBase()) return;
    const data = event.data;
    if (!data || typeof data !== "object" || String(data.channel || "") !== frameChannel) return;

    if (data.type === "ag-mp-ready") {
      frameReady = true;
      if (pendingFrameCmd) {
        const queued = pendingFrameCmd;
        pendingFrameCmd = null;
        try {
          frame.contentWindow.postMessage(queued, sidecarBase());
        } catch (_) {}
      }
      return;
    }

    if (data.type === "ag-mp-state") {
      playbackState = Object.assign(defaultPlaybackState(), playbackState, {
        paused: Boolean(data.paused),
        autoplay: Boolean(data.autoplay),
        ended: Boolean(data.ended),
        seeking: Boolean(data.seeking),
        muted: Boolean(data.muted),
        volume: Number.isFinite(data.volume) ? data.volume : playbackState.volume,
        playbackRate: Number.isFinite(data.playbackRate) ? data.playbackRate : playbackState.playbackRate,
        currentTime: Number.isFinite(data.currentTime) ? data.currentTime : 0,
        duration: Number.isFinite(data.duration) ? data.duration : 0,
        videoWidth: Number(data.videoWidth || 0),
        videoHeight: Number(data.videoHeight || 0),
        readyState: Number(data.readyState || 0),
        networkState: Number(data.networkState || 0),
      });
      syncControlsFromState(root);
      if (data.event === "loadedmetadata" || data.readyState >= 1) {
        updateSubMeta(root);
        const box = root.querySelector("[data-mp-status]");
        if (box?.getAttribute("data-mp-status-state") === "loading") {
          hideStatus(root);
        }
      }
      return;
    }

    if (data.type === "ag-mp-error") {
      if (!activeHandle) return;
      const code = Number(data.code || 0);
      playbackState.errorCode = code;
      const msgMap = {
        1: "视频加载被中断",
        2: "读取本地流时发生网络或句柄错误",
        3: "视频解码失败（可能是不受支持的编码格式）",
        4: "当前内核不支持该视频封装/编码格式，或本地句柄已失效",
      };
      showStatus(root, msgMap[code] || (data.message ? `播放失败：${data.message}` : `视频无法播放 (错误码 ${code || "未知"})`), true);
    }
  }

  function wirePlayerDom(root) {
    const frame = root.querySelector("[data-mp-frame]");
    const playBtn = root.querySelector("[data-mp-play]");
    const timeLabel = root.querySelector("[data-mp-time]");
    const seekInput = root.querySelector("[data-mp-seek]");
    const muteBtn = root.querySelector("[data-mp-mute]");
    const volInput = root.querySelector("[data-mp-vol]");
    const rateSelect = root.querySelector("[data-mp-rate]");
    const fsBtn = root.querySelector("[data-mp-fullscreen]");
    const stage = root.querySelector("[data-mp-stage]");

    frame.addEventListener("load", () => {
      if (disposed || !frameReady && frame.contentWindow && frameChannel) {
        try {
          frame.contentWindow.postMessage({ type: "ping", channel: frameChannel }, sidecarBase());
        } catch (_) {}
      }
    });

    playBtn.addEventListener("click", () => {
      if (!activeHandle) return;
      sendPlayerCommand("togglePlay");
    });

    seekInput.addEventListener("pointerdown", () => { isSeeking = true; });
    seekInput.addEventListener("pointerup", () => { isSeeking = false; });
    seekInput.addEventListener("input", () => {
      const dur = Number.isFinite(playbackState.duration) && playbackState.duration > 0 ? playbackState.duration : 0;
      if (dur > 0) {
        const targetTime = (Number(seekInput.value) / 1000) * dur;
        sendPlayerCommand("seek", { time: targetTime });
        if (timeLabel) timeLabel.textContent = `${formatTime(targetTime)} / ${formatTime(dur)}`;
      }
    });
    seekInput.addEventListener("change", () => { isSeeking = false; });

    muteBtn.addEventListener("click", () => {
      const nextMuted = !playbackState.muted;
      playbackState.muted = nextMuted;
      muteBtn.textContent = nextMuted ? "取消静音" : "静音";
      sendPlayerCommand("setMuted", { muted: nextMuted });
    });

    volInput.addEventListener("input", () => {
      const v = Math.max(0, Math.min(1, Number(volInput.value)));
      playbackState.volume = v;
      if (v > 0 && playbackState.muted) playbackState.muted = false;
      muteBtn.textContent = playbackState.muted || v === 0 ? "取消静音" : "静音";
      sendPlayerCommand("setVolume", { volume: v });
    });

    rateSelect.addEventListener("change", () => {
      const r = Number(rateSelect.value);
      if (Number.isFinite(r) && r > 0) {
        playbackState.playbackRate = r;
        sendPlayerCommand("setRate", { playbackRate: r });
      }
    });

    fsBtn.addEventListener("click", async () => {
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        } else if (typeof stage.requestFullscreen === "function") {
          await stage.requestFullscreen();
        }
      } catch (err) {
        showToast("全屏切换受限：" + (err?.message || err));
      }
    });

    root.addEventListener("click", (event) => {
      const btn = event.target instanceof Element ? event.target.closest("[data-mp-action]") : null;
      if (!btn) return;
      const action = btn.getAttribute("data-mp-action");
      if (action === "close") {
        unmountOverlay(false);
      } else if (action === "pick") {
        triggerLocalFilePicker();
      } else if (action === "open") {
        void handleOpenExternal();
      } else if (action === "reveal") {
        void handleRevealInExplorer();
      } else if (action === "copy") {
        void handleCopyPath();
      }
    });
  }

  function updateSubMeta(root) {
    const sub = root.querySelector("[data-mp-sub]");
    if (!sub || !activeHandle) return;
    const parts = [formatBytes(activeHandle.size)];
    const ext = String(activeHandle.ext || "").replace(/^\./, "").toUpperCase();
    if (ext) parts.push(ext);
    if (playbackState.videoWidth > 0 && playbackState.videoHeight > 0) {
      parts.push(`${playbackState.videoWidth}×${playbackState.videoHeight}`);
    }
    if (Number.isFinite(playbackState.duration) && playbackState.duration > 0) {
      parts.push(formatTime(playbackState.duration));
    }
    parts.push(activeHandle.path);
    sub.textContent = parts.join(" · ");
    sub.title = activeHandle.path;
  }

  function showStatus(root, message, offerFallback) {
    const box = root.querySelector("[data-mp-status]");
    const txt = root.querySelector("[data-mp-status-text]");
    const actions = root.querySelector("[data-mp-status-actions]");
    if (!box || !txt || !actions) return;
    box.setAttribute("data-mp-status-state", offerFallback ? "error" : "loading");
    txt.textContent = String(message || "");
    actions.innerHTML = "";
    if (offerFallback && activeHandle) {
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "ag-mp-btn";
      openBtn.textContent = "用系统播放器打开";
      openBtn.addEventListener("click", () => { void handleOpenExternal(); });
      const revBtn = document.createElement("button");
      revBtn.type = "button";
      revBtn.className = "ag-mp-btn";
      revBtn.textContent = "在资源管理器显示";
      revBtn.addEventListener("click", () => { void handleRevealInExplorer(); });
      actions.appendChild(openBtn);
      actions.appendChild(revBtn);
    }
    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.className = "ag-mp-btn";
    pickBtn.textContent = "重新选择本地视频";
    pickBtn.addEventListener("click", () => triggerLocalFilePicker());
    actions.appendChild(pickBtn);
    box.hidden = false;
  }

  function hideStatus(root) {
    const box = root.querySelector("[data-mp-status]");
    if (box) {
      box.setAttribute("data-mp-status-state", "ready");
      box.hidden = true;
    }
  }

  async function handleOpenExternal() {
    if (!activeHandle?.id) return;
    try {
      await apiJson(`/api/media/${encodeURIComponent(activeHandle.id)}/open`, {});
      showToast("已使用系统默认播放器打开");
    } catch (err) {
      showToast("打开系统播放器失败：" + (err?.message || err));
    }
  }

  async function handleRevealInExplorer() {
    if (!activeHandle?.id) return;
    try {
      await apiJson(`/api/media/${encodeURIComponent(activeHandle.id)}/reveal`, {});
      showToast("已在资源管理器中选中文件");
    } catch (err) {
      showToast("打开资源管理器失败：" + (err?.message || err));
    }
  }

  async function handleCopyPath() {
    const targetPath = activeHandle?.path || "";
    if (!targetPath) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(targetPath);
        showToast("已复制本地视频路径");
        return;
      }
    } catch (_) {}
    try {
      const ta = document.createElement("textarea");
      ta.value = targetPath;
      ta.style.cssText = "position:fixed;left:-9999px;opacity:0;";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      showToast("已复制本地视频路径");
    } catch (err) {
      showToast("复制失败：" + (err?.message || err));
    }
  }

  function currentActiveTabId() {
    return document.querySelector('[data-side-panel-strip="true"]')?.getAttribute("data-active-tab-id") || "";
  }

  async function openPreviewForPath(rawPath, sourceTabId) {
    if (!isEnabled()) return false;
    const localPath = decodeUriToLocalPath(rawPath) || String(rawPath || "").trim();
    if (!localPath) {
      showToast("未识别到有效本地视频路径");
      return false;
    }

    // Ensure side panel opens when triggered from chat while collapsed
    if (!document.querySelector('[data-side-panel-open="true"]')) {
      const toggleBtn = document.querySelector('button[data-testid="toggle-aux-sidebar"]');
      if (toggleBtn instanceof HTMLElement) {
        toggleBtn.click();
        await new Promise((r) => setTimeout(r, 140));
      }
    }

    const prev = activeHandle;
    activeHandle = null;
    if (prev) void closeHandle(prev, false);

    const root = createOrMountPlayerRoot();
    const titleEl = root.querySelector("[data-mp-title]");
    const subEl = root.querySelector("[data-mp-sub]");
    const volInput = root.querySelector("[data-mp-vol]");
    const rateSelect = root.querySelector("[data-mp-rate]");

    if (titleEl) titleEl.textContent = localPath.split(/[\\/]/).pop() || "本地视频";
    if (subEl) subEl.textContent = "正在通过本地流注册预览...";
    playbackState = Object.assign(defaultPlaybackState(), {
      muted: playbackState.muted,
      volume: volInput ? Number(volInput.value) : 1,
      playbackRate: rateSelect ? Number(rateSelect.value) || 1 : 1,
    });
    syncControlsFromState(root);
    ensurePlayerFrameSrc(root);
    sendPlayerCommand("clear");
    showStatus(root, "正在准备本地流式预览...", false);

    try {
      const registered = await apiJson("/api/media/register", { path: localPath });
      if (disposed || !isEnabled()) {
        if (registered?.id) void closeHandle({ id: registered.id }, false);
        return false;
      }
      const streamUrl = sidecarBase() + (registered.streamUrl || registered.url || "");
      activeHandle = {
        id: registered.id,
        path: registered.path,
        name: registered.name,
        ext: registered.ext,
        mime: registered.mime,
        size: registered.size,
        streamUrl,
        sourceTabId: sourceTabId !== undefined ? sourceTabId : currentActiveTabId(),
      };
      if (titleEl) titleEl.textContent = activeHandle.name || titleEl.textContent;
      updateSubMeta(root);
      showStatus(root, "正在加载视频元数据...", false);
      ensurePlayerFrameSrc(root);
      sendPlayerCommand("load", {
        src: activeHandle.streamUrl,
        muted: playbackState.muted,
        volume: playbackState.volume,
        playbackRate: playbackState.playbackRate,
      });
      try { window.__agUpdateReadingMask?.(); } catch (_) {}
      return true;
    } catch (err) {
      activeHandle = null;
      if (subEl) subEl.textContent = localPath;
      showStatus(root, "无法注册本地视频预览：" + (err?.message || err), true);
      return false;
    }
  }

  function resolvePickedFilePath(file) {
    if (!file) return "";
    try {
      if (typeof window.electronNative?.getPathForFile === "function") {
        const bridged = String(window.electronNative.getPathForFile(file) || "").trim();
        if (bridged) return bridged;
      }
    } catch (_) {}
    if (typeof file.path === "string" && file.path.trim()) {
      return file.path.trim();
    }
    return "";
  }

  function triggerLocalFilePicker() {
    if (!isEnabled()) return;
    if (!hiddenFileInput || !document.body.contains(hiddenFileInput)) {
      hiddenFileInput = document.createElement("input");
      hiddenFileInput.type = "file";
      hiddenFileInput.accept = "video/*,.mp4,.webm,.mov,.m4v,.mkv,.avi,.ogv";
      hiddenFileInput.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
      hiddenFileInput.setAttribute("data-ag-media-file-input", "true");
      hiddenFileInput.addEventListener("change", () => {
        const file = hiddenFileInput.files && hiddenFileInput.files[0];
        hiddenFileInput.value = "";
        if (!file) return;
        const resolved = resolvePickedFilePath(file);
        if (!resolved) {
          const root = createOrMountPlayerRoot();
          const titleEl = root.querySelector("[data-mp-title]");
          const subEl = root.querySelector("[data-mp-sub]");
          if (titleEl) titleEl.textContent = file.name || "未解析到本地路径";
          if (subEl) subEl.textContent = "宿主桥接未返回磁盘路径";
          showStatus(root, "无法可靠解析所选文件的本地路径，请点击「重新选择本地视频」重试，或直接从聊天/文件树打开。", true);
          const box = root.querySelector("[data-mp-status]");
          if (box) box.setAttribute("data-mp-status-state", "error");
          showToast("无法可靠解析文件路径，请重新选择", 3400);
          return;
        }
        void openPreviewForPath(resolved, currentActiveTabId());
      });
      document.body.appendChild(hiddenFileInput);
    }
    hiddenFileInput.click();
  }

  function findOversizeTargetPath(viewerEl) {
    const tabStrip = document.querySelector('[data-side-panel-strip="true"]');
    const activeTabId = tabStrip?.getAttribute("data-active-tab-id") || "";
    const fromTab = isLocalVideoTarget(activeTabId) || decodeUriToLocalPath(activeTabId);
    if (fromTab && VIDEO_EXT_RE.test(fromTab)) return fromTab;

    const header = document.querySelector('[aria-label="File Viewer header"]');
    if (header) {
      const crumbs = Array.from(header.querySelectorAll('nav[aria-label="File path breadcrumbs"] button, [data-uri], [title]'));
      for (const el of crumbs) {
        const hit = isLocalVideoTarget(el.getAttribute("data-uri") || el.getAttribute("title") || "");
        if (hit) return hit;
      }
      const crumbTexts = Array.from(header.querySelectorAll('nav[aria-label="File path breadcrumbs"] button'))
        .map((b) => String(b.textContent || "").trim())
        .filter(Boolean);
      const last = crumbTexts[crumbTexts.length - 1] || "";
      if (VIDEO_EXT_RE.test(last)) {
        const matchingPill = Array.from(document.querySelectorAll("button.inline-pill[data-uri]")).find((p) => {
          const d = isLocalVideoTarget(p.getAttribute("data-uri") || "");
          return d && d.toLowerCase().endsWith(last.toLowerCase());
        });
        if (matchingPill) {
          return isLocalVideoTarget(matchingPill.getAttribute("data-uri") || "");
        }
      }
    }

    const fiberPath = readFiberFilePath(viewerEl);
    if (fiberPath) return fiberPath;

    return "";
  }

  function decorateRightPaneControls() {
    if (disposed || !isEnabled()) return;

    // 1. Always provide "选择本地视频" button in right panel strip when side panel is open
    const strip = document.querySelector('[data-side-panel-open="true"] [data-side-panel-strip="true"]');
    if (strip && !strip.querySelector(`[${PICKER_BTN_ATTR}]`)) {
      ensureStyle();
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute(PICKER_BTN_ATTR, "true");
      btn.textContent = "选择本地视频";
      btn.title = "从本机直接选择视频文件进行右侧流式预览";
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        triggerLocalFilePicker();
      });
      strip.appendChild(btn);
    }

    // 2. Inject "预览视频" button inside >20MB size limit error view
    const viewer = document.querySelector('[data-side-panel-open="true"] [aria-label="File Viewer"]');
    if (!viewer || viewer.querySelector(`[${OVERSIZE_BAR_ATTR}]`)) return;
    const text = String(viewer.textContent || "");
    if (!/File exceeds the 20MB display limit|超过.*20\s*MB|Failed to read file content/i.test(text)) return;

    const targetPath = findOversizeTargetPath(viewer);
    const activeTabText = String(document.querySelector('[data-side-panel-strip="true"] button[data-tab-id]')?.textContent || "").trim();
    const crumbLast = String(
      Array.from(viewer.querySelectorAll('nav[aria-label="File path breadcrumbs"] button')).pop()?.textContent || ""
    ).trim();
    const labelHint = targetPath || crumbLast || activeTabText;
    if (!targetPath && labelHint && /\.(json|ts|tsx|js|jsx|py|md|txt|log|csv|sql|html|css|yml|yaml|xml)$/i.test(labelHint)) {
      return;
    }
    const buttons = Array.from(viewer.querySelectorAll("button"));
    const revealBtn = buttons.find((b) => /资源管理器|Reveal in File Explorer|Show in Explorer/i.test(String(b.textContent || "")));
    const hostContainer = revealBtn?.parentElement || viewer.querySelector(".file-viewer-root") || viewer;

    ensureStyle();
    const bar = document.createElement("span");
    bar.setAttribute(OVERSIZE_BAR_ATTR, "true");

    const previewBtn = document.createElement("button");
    previewBtn.type = "button";
    previewBtn.className = "ag-media-cta-btn";
    previewBtn.textContent = "预览视频";
    previewBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const latestPath = findOversizeTargetPath(viewer) || targetPath;
      if (latestPath) {
        void openPreviewForPath(latestPath, currentActiveTabId());
      } else {
        triggerLocalFilePicker();
      }
    });
    bar.appendChild(previewBtn);

    if (!strip?.querySelector(`[${PICKER_BTN_ATTR}]`)) {
      const pickBtn = document.createElement("button");
      pickBtn.type = "button";
      pickBtn.className = "ag-media-cta-btn is-secondary";
      pickBtn.textContent = "选择本地视频";
      pickBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        triggerLocalFilePicker();
      });
      bar.appendChild(pickBtn);
    }

    if (revealBtn && revealBtn.nextSibling) {
      hostContainer.insertBefore(bar, revealBtn.nextSibling);
    } else {
      hostContainer.appendChild(bar);
    }
  }

  function scheduleScan() {
    if (scanScheduled || disposed) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      decorateRightPaneControls();
    });
  }

  function onDocumentClickCapture(event) {
    if (disposed || !isEnabled()) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;

    // Close preview overlay if user switches away to another tab in right strip
    const tabBtn = event.target instanceof Element ? event.target.closest('[data-side-panel-strip="true"] button[data-tab-id]') : null;
    if (tabBtn && activeHandle) {
      const nextId = tabBtn.getAttribute("data-tab-id") || "";
      if (nextId && activeHandle.sourceTabId && nextId !== activeHandle.sourceTabId) {
        unmountOverlay(false);
        return;
      }
    }

    const videoPath = extractVideoPathFromEventTarget(event.target);
    if (!videoPath) return;

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    void openPreviewForPath(videoPath, currentActiveTabId());
  }

  function onConfigUpdated(event) {
    const patch = event?.detail || {};
    if (patch.videoPreviewEnabled === false || document.documentElement.classList.contains("ag-video-preview-disabled")) {
      unmountOverlay(false);
      document.querySelectorAll(`[${PICKER_BTN_ATTR}], [${OVERSIZE_BAR_ATTR}]`).forEach((n) => n.remove());
    } else if (patch.videoPreviewEnabled === true) {
      scheduleScan();
    }
  }

  function onBeforeUnload() {
    unmountOverlay(true);
  }

  function onKeyDown(event) {
    if (event.key === "Escape" && document.getElementById(ROOT_ID)) {
      unmountOverlay(false);
    }
  }

  document.addEventListener("click", onDocumentClickCapture, true);
  document.addEventListener("ag-config-updated", onConfigUpdated);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("message", onPlayerMessage);

  if (bus && typeof bus.onMutation === "function") {
    unsubMutation = bus.onMutation("media-preview", scheduleScan);
  }
  if (bus && typeof bus.onTick === "function") {
    unsubTick = bus.onTick("media-preview", 1200, decorateRightPaneControls);
  }
  const fallbackObserver = bus ? null : new MutationObserver(scheduleScan);
  if (fallbackObserver && document.body) {
    fallbackObserver.observe(document.body, { childList: true, subtree: true });
  }

  function dispose() {
    disposed = true;
    unmountOverlay(true);
    document.removeEventListener("click", onDocumentClickCapture, true);
    document.removeEventListener("ag-config-updated", onConfigUpdated);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("beforeunload", onBeforeUnload);
    window.removeEventListener("message", onPlayerMessage);
    if (typeof unsubMutation === "function") unsubMutation();
    if (typeof unsubTick === "function") unsubTick();
    if (fallbackObserver) fallbackObserver.disconnect();
    document.querySelectorAll(`[${PICKER_BTN_ATTR}], [${OVERSIZE_BAR_ATTR}]`).forEach((n) => n.remove());
    if (hiddenFileInput) {
      hiddenFileInput.remove();
      hiddenFileInput = null;
    }
    clearTimeout(toastTimer);
    document.getElementById(TOAST_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
    delete window.__agMediaPreviewInstalled;
    delete window.__agMediaPreviewDispose;
    delete window.__agMediaPreview;
  }

  window.__agMediaPreviewDispose = dispose;
  window.__agMediaPreview = {
    version: VERSION,
    openPath: openPreviewForPath,
    pickFile: triggerLocalFilePicker,
    close: () => unmountOverlay(false),
    refresh: scheduleScan,
    getActiveHandle: () => (activeHandle ? Object.assign({}, activeHandle) : null),
    getPlaybackState: () => Object.assign({}, playbackState),
    sendCommand: (type, payload) => sendPlayerCommand(type, payload),
  };

  ensureStyle();
  decorateRightPaneControls();
})();
