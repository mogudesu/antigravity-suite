/**
 * running-radar.js
 * v3.0 运行中 / 待确认 / 未读对话雷达。
 *
 * 数据双源：GetAllCascadeTrajectories 官方同源接口 + 当前对话 DOM 信号。
 * 未读判定复用官方 annotations：markedAsUnread 或 lastModifiedTime > lastUserViewTime。
 * UI 全在侧栏虚拟列表之外的 #ag-running-radar，以及折叠项目头右侧的角标。
 * 不展开项目文件夹即可跳转；Alt+R 轮巡。
 */
(function () {
  if (window.__agRunningRadarInstalled) return;
  window.__agRunningRadarInstalled = true;

  const RUNNING = new Set([
    "CASCADE_RUN_STATUS_RUNNING",
    "CASCADE_RUN_STATUS_BUSY",
    "CASCADE_RUN_STATUS_CANCELING",
  ]);
  const WAITING_RE = /WAIT|AWAIT|USER_ACTION|CONFIRM|APPROVAL/i;
  const STYLE_ID = "ag-running-radar-style";
  const HOST_ID = "ag-running-radar";
  const BADGE_CLASS = "ag-project-running-badge";
  const POPOVER_ID = "ag-running-radar-popover";
  const SEND_HINT = /send|submit/i;
  const STOP_HINT = /stop|cancel|abort/i;

  const state = {
    entries: [],
    filter: "active",
    collapsed: false,
    loading: false,
    lastFetch: 0,
    transient: null,
    currentId: "",
    error: "",
    timer: 0,
    lastPath: location.pathname,
  };

  const cfg = () => window.__AG_CONFIG || {};
  const isEn = () => String(cfg().language || "zh-CN").toLowerCase() === "en";
  const text = (zh, en) => (isEn() ? en : zh);
  try {
    if (localStorage.getItem("ag-radar-filter") === "unread") state.filter = "unread";
  } catch (error) {}
  const esc = (value) => String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  function currentCascadeId() {
    const match = String(location.pathname || "").match(/\/c\/([0-9a-f-]{8,})/i);
    return match ? match[1] : "";
  }

  function parseFrame(buffer) {
    let offset = 0;
    let last = null;
    while (offset + 5 <= buffer.length) {
      const length = (buffer[offset + 1] << 24) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 8) | buffer[offset + 4];
      const start = offset + 5;
      const end = start + length;
      offset = end;
      if (length <= 0 || end > buffer.length) break;
      try { last = JSON.parse(new TextDecoder().decode(buffer.slice(start, end))); } catch (error) {}
    }
    return last;
  }

  function projectName(summary) {
    const workspace = Array.isArray(summary.workspaces) ? summary.workspaces[0] : null;
    if (!workspace) return "";
    let uri = workspace.workspaceFolderAbsoluteUri || workspace.workspaceUri || workspace.path || "";
    if (workspace.workspaceFolder) uri = workspace.workspaceFolder.uri || workspace.workspaceFolder.path || uri;
    if (!uri) return "";
    try {
      const parsed = new URL(uri);
      return decodeURIComponent(parsed.pathname).replace(/\/+$/, "").split("/").filter(Boolean).pop() || "";
    } catch (error) {
      return decodeURIComponent(String(uri)).split(/[\\/]/).filter(Boolean).pop() || "";
    }
  }

  function titleOf(summary) {
    const raw = summary.summary;
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    if (raw && typeof raw === "object") {
      const candidate = raw.title || raw.name || raw.text || raw.summary;
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
    return summary.title || summary.name || summary.trajectoryId || "Untitled";
  }

  function timeMs(value) {
    if (value == null || value === "") return 0;
    if (typeof value === "number") return value > 1e12 ? value : value * 1000;
    if (typeof value === "string") {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && value.trim()) return numeric > 1e12 ? numeric : numeric * 1000;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    if (typeof value === "object") {
      if (typeof value.seconds === "number") return value.seconds * 1000 + Math.round((Number(value.nanos) || 0) / 1e6);
      if (typeof value.milliseconds === "number") return value.milliseconds;
    }
    return 0;
  }

  function unreadOf(summary) {
    const annotations = summary.annotations || {};
    if (annotations.archived === true) return false;
    if (annotations.markedAsUnread === true) return true;
    const modified = timeMs(summary.lastModifiedTime);
    if (!modified) return false;
    const viewed = timeMs(annotations.lastUserViewTime != null ? annotations.lastUserViewTime : summary.lastUserViewTime);
    return modified > viewed;
  }

  function waitingOf(summary) {
    const status = String(summary.status || "");
    if (!status || status === "CASCADE_RUN_STATUS_IDLE") return false;
    if (Array.isArray(summary.waitingSteps) && summary.waitingSteps.length) return true;
    const meta = summary.trajectoryMetadata || {};
    if (meta.waitingForUser || meta.requiresUserAction || meta.pendingUserAction) return true;
    if (summary.waitingForUser || summary.requiresUserAction) return true;
    return WAITING_RE.test(status);
  }

  function normalize(id, summary) {
    const status = String(summary.status || "");
    const running = RUNNING.has(status);
    const waiting = waitingOf(summary);
    const unread = !running && !waiting && unreadOf(summary);
    if (!running && !waiting && !unread) return null;
    return {
      id,
      title: titleOf(summary),
      project: projectName(summary),
      status,
      waiting,
      unread,
      kind: waiting ? "waiting" : running ? "running" : "unread",
      updated: timeMs(summary.lastModifiedTime) || 0,
      stepCount: Number(summary.stepCount || 0),
      transient: false,
    };
  }

  async function fetchTrajectories() {
    const token = window.__APP_CONFIG__?.csrfToken;
    if (!token) throw new Error("missing csrf");
    const json = JSON.stringify({ excludeSubtrajectories: true });
    const body = new TextEncoder().encode(json);
    const frame = new Uint8Array(5 + body.length);
    frame[4] = body.length;
    frame.set(body, 5);
    const response = await fetch("/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories", {
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
    if (!response.ok) throw new Error("HTTP " + response.status);
    const payload = parseFrame(new Uint8Array(await response.arrayBuffer()));
    const summaries = payload?.trajectorySummaries || payload?.response?.trajectorySummaries || {};
    return Object.entries(summaries).map(([id, summary]) => normalize(id, summary)).filter(Boolean);
  }

  function domSignals() {
    const id = currentCascadeId();
    if (!id) return null;
    const stop = document.querySelector('[aria-label="Stop execution"], [aria-label*="Stop"], [data-testid="status-task-running"]');
    if (!stop) return null;
    return {
      id,
      title: text("当前对话", "Current conversation"),
      project: "",
      status: "CASCADE_RUN_STATUS_RUNNING",
      waiting: false,
      unread: false,
      kind: "running",
      updated: Date.now(),
      stepCount: 0,
      transient: true,
    };
  }

  function mergeEntries(list) {
    const byId = new Map();
    list.forEach((entry) => byId.set(entry.id, entry));
    const dom = domSignals();
    if (dom && !byId.has(dom.id)) byId.set(dom.id, dom);
    if (state.transient && Date.now() - state.transient.at < 12000 && !byId.has(state.transient.entry.id)) {
      byId.set(state.transient.entry.id, state.transient.entry);
    }
    return Array.from(byId.values()).sort((a, b) => {
      const rank = (entry) => entry.waiting ? 0 : entry.unread ? 2 : 1;
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return Number(b.updated || 0) - Number(a.updated || 0);
    });
  }

  function projectHeader(label) {
    if (!label) return null;
    const wanted = String(label).trim().toLowerCase();
    return Array.from(document.querySelectorAll('[data-testid="project-header"]'))
      .find((node) => {
        const value = String(node.getAttribute("data-project-label") || node.textContent || "").trim().toLowerCase();
        return value === wanted;
      }) || null;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${HOST_ID}{margin:6px 0 2px;padding:7px 8px;border:1px solid rgba(255,255,255,.075);border-radius:10px;
        background:radial-gradient(120% 160% at 0% 0%,rgba(139,92,246,.09),transparent 60%),rgba(12,15,28,.55);
        box-shadow:inset 0 1px 0 rgba(255,255,255,.035);font-family:inherit;color:#c8d4e4;overflow:hidden}
      #${HOST_ID}.is-hidden{display:none!important}
      .ag-radar-head{display:flex;align-items:center;gap:6px;min-height:18px}
      .ag-radar-title{display:flex;align-items:center;gap:5px;flex:1;min-width:0;font-size:11px;font-weight:600;color:#dce6f2;letter-spacing:.01em}
      .ag-radar-pulse{width:6px;height:6px;border-radius:50%;background:#22e3ff;box-shadow:0 0 8px rgba(34,227,255,.8);animation:ag-radar-pulse 1.8s ease-in-out infinite}
      .ag-radar-pulse.waiting{background:#f6d893;box-shadow:0 0 8px rgba(246,216,147,.8)}
      .ag-radar-pulse.unread{background:#c4b5fd;box-shadow:0 0 8px rgba(196,181,253,.8)}
      .ag-radar-meta{font-size:10px;color:#8da0b8;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .ag-radar-toggle{border:0;background:transparent;color:#7f93ab;cursor:pointer;font-size:11px;line-height:1;padding:2px 3px;border-radius:4px}
      .ag-radar-toggle:hover{color:#f1e9ff;background:rgba(255,255,255,.05)}
      .ag-radar-filters{display:flex;gap:4px;margin-top:6px}
      #${HOST_ID} .ag-radar-filter{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border:1px solid rgba(255,255,255,.08)!important;border-radius:999px;background:rgba(255,255,255,.025)!important;color:#8094ab!important;font-family:inherit;font-size:9.5px;font-weight:500;line-height:1;cursor:pointer;white-space:nowrap}
      #${HOST_ID} .ag-radar-filter:hover{color:#dce6f2!important;border-color:rgba(255,255,255,.16)!important;background:rgba(255,255,255,.05)!important}
      #${HOST_ID} .ag-radar-filter b{font-weight:600;color:#c8d4e4}
      #${HOST_ID} .ag-radar-filter[data-radar-filter="active"].is-active{border-color:rgba(34,227,255,.3)!important;background:rgba(34,227,255,.08)!important;color:#bdefff!important}
      #${HOST_ID} .ag-radar-filter[data-radar-filter="unread"].is-active{border-color:rgba(196,181,253,.34)!important;background:rgba(196,181,253,.1)!important;color:#e0d9ff!important}
      #${HOST_ID} .ag-radar-filter.is-active b{color:inherit}
      .ag-radar-list{display:flex;flex-direction:column;gap:2px;margin-top:5px;max-height:170px;overflow:auto}
      .ag-radar-row{display:flex;align-items:center;gap:6px;width:100%;padding:4px 5px;border:0;border-radius:6px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}
      #${HOST_ID} .ag-radar-row:hover{background:rgba(255,255,255,.05)!important}
      #${HOST_ID} .ag-radar-row.is-current{background:rgba(165,180,252,.10)!important;box-shadow:inset 0 0 0 1px rgba(196,181,253,.12)!important}
      .ag-radar-dot{flex:0 0 6px;width:6px;height:6px;border-radius:50%;background:#22e3ff;box-shadow:0 0 6px rgba(34,227,255,.7)}
      .ag-radar-row.is-waiting .ag-radar-dot{background:#f6d893;box-shadow:0 0 6px rgba(246,216,147,.7);animation:ag-radar-pulse 1.6s ease-in-out infinite}
      .ag-radar-row.is-unread .ag-radar-dot{background:#c4b5fd;box-shadow:0 0 6px rgba(196,181,253,.72)}
      .ag-radar-row.is-unread .ag-radar-name{color:#d8d1f2}
      .ag-radar-project{flex:0 1 auto;max-width:88px;padding:1px 5px;border-radius:999px;background:rgba(165,180,252,.08);color:#c4b5fd;font-size:9px;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .ag-radar-name{flex:1;min-width:0;font-size:10.5px;line-height:1.35;color:#b9c8da;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .ag-radar-age{flex:0 0 auto;color:#8a7fb0;font:9px/1 ui-monospace,Consolas,monospace}
      .ag-radar-empty{display:flex;align-items:center;gap:5px;padding:5px 3px 2px;color:#788aa1;font-size:10.5px}
      .ag-radar-empty strong{color:#f6d893;font-weight:500}
      .ag-radar-error{color:#fca5a5;font-size:10px;padding:4px 2px}
      .ag-radar-collapsed .ag-radar-list,.ag-radar-collapsed .ag-radar-filters{display:none}
      .${BADGE_CLASS}{position:absolute;top:6px;right:39px;z-index:6;display:inline-flex;align-items:center;gap:3px;height:18px;padding:0 6px;border:1px solid rgba(246,216,147,.28);border-radius:999px;background:rgba(20,18,36,.88);color:#f6d893;font:600 9px/1 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;cursor:pointer;box-shadow:0 0 10px rgba(246,216,147,.10)}
      .${BADGE_CLASS}:hover{border-color:rgba(246,216,147,.55);background:rgba(35,28,46,.95)}
      .${BADGE_CLASS}.is-waiting{border-color:rgba(246,216,147,.4);color:#ffe2a3}
      #${POPOVER_ID}{position:fixed;z-index:9999;width:280px;max-width:calc(100vw - 24px);padding:8px;border:1px solid rgba(196,181,253,.18);border-radius:10px;background:rgba(12,14,26,.96);box-shadow:0 14px 40px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.05);color:#c8d4e4;font-family:inherit;backdrop-filter:blur(16px)}
      .ag-radar-pop-head{font-size:10px;color:#8da0b8;padding:2px 4px 6px;display:flex;align-items:center;justify-content:space-between}
      .ag-radar-pop-head strong{color:#f6d893;font-weight:600}
      .ag-radar-pop-row{display:flex;align-items:center;gap:6px;padding:6px;border-radius:7px;cursor:pointer}
      .ag-radar-pop-row:hover{background:rgba(255,255,255,.05)}
      .ag-radar-pop-row .ag-radar-name{font-size:11px}
      .ag-radar-toast{position:fixed;left:50%;bottom:26px;transform:translate(-50%,8px);z-index:10000;padding:7px 12px;border:1px solid rgba(196,181,253,.2);border-radius:999px;background:rgba(12,14,26,.94);color:#e9eef8;font:500 11px/1.4 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;opacity:0;pointer-events:none;transition:opacity .16s ease,transform .16s ease}
      .ag-radar-toast.is-visible{opacity:1;transform:translate(-50%,0)}
      @keyframes ag-radar-pulse{0%,100%{opacity:.5;transform:scale(.9)}50%{opacity:1;transform:scale(1.15)}}
      @media (prefers-reduced-motion:reduce){.ag-radar-pulse,.${BADGE_CLASS}{animation:none!important}}
    `;
    document.head.appendChild(style);
  }

  function ensureHost() {
    const navLink = document.querySelector('.bg-sidebar a[href="/customizations"]');
    const group = navLink?.parentElement;
    const rail = group?.parentElement;
    if (!rail) return null;
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement("section");
      host.id = HOST_ID;
      host.setAttribute("aria-label", text("对话雷达", "Conversation radar"));
    }
    if (host.parentElement !== rail || host.previousElementSibling !== group) {
      rail.insertBefore(host, group.nextSibling);
    }
    return host;
  }

  function activeEntries() {
    return state.entries.filter((entry) => !entry.unread);
  }

  function unreadEntries() {
    return state.entries.filter((entry) => entry.unread);
  }

  function visibleEntries() {
    return state.filter === "unread" ? unreadEntries() : activeEntries();
  }

  function ageLabel(updated) {
    if (!updated) return "";
    const diff = Math.max(0, Date.now() - updated);
    if (diff < 60000) return text("刚刚", "now");
    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return minutes + "m";
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + "h";
    return Math.floor(hours / 24) + "d";
  }

  function rowHtml(entry) {
    const current = entry.id === state.currentId ? " is-current" : "";
    const waiting = entry.waiting ? " is-waiting" : "";
    const unread = entry.unread ? " is-unread" : "";
    const age = entry.unread ? `<span class="ag-radar-age">${esc(ageLabel(entry.updated))}</span>` : "";
    return `<button type="button" class="ag-radar-row${waiting}${unread}${current}" data-radar-id="${esc(entry.id)}" title="${esc(entry.title)}">` +
      `<span class="ag-radar-dot"></span>` +
      (entry.project ? `<span class="ag-radar-project">${esc(entry.project)}</span>` : "") +
      `<span class="ag-radar-name">${esc(entry.title)}</span>` +
      age +
      `</button>`;
  }

  function render() {
    ensureStyle();
    const host = ensureHost();
    if (!host) return;
    const enabled = cfg().runningRadar !== false;
    if (!enabled) {
      host.classList.add("is-hidden");
      document.querySelectorAll(`.${BADGE_CLASS}`).forEach((node) => node.remove());
      return;
    }
    host.classList.remove("is-hidden");
    state.currentId = currentCascadeId();
    const active = activeEntries();
    const unread = unreadEntries();
    const waiting = active.filter((entry) => entry.waiting);
    const running = active.length - waiting.length;
    const idle = state.entries.length === 0;
    const unreadView = state.filter === "unread";
    const visible = unreadView ? unread : active;
    if (idle && cfg().hideRadarWhenIdle === true) {
      host.classList.add("is-hidden");
    } else {
      host.classList.remove("is-hidden");
    }
    host.classList.toggle("ag-radar-collapsed", state.collapsed);
    const countLabel = unreadView
      ? `${unread.length} ${text("条已生成未读", "finished & unread")}`
      : `${running} ${text("运行", "Running")}${waiting.length ? " · " + waiting.length + " " + text("待确认", "Waiting") : ""}${unread.length ? " · " + unread.length + " " + text("未读", "Unread") : ""}`;
    const pulseClass = waiting.length && !running ? " waiting" : (!active.length && unread.length ? " unread" : "");
    const title = unreadView
      ? text("未读对话", "Unread")
      : active.length ? text("运行中对话", "Running") : unread.length ? text("对话雷达", "Radar") : text("运行中对话", "Running");
    const idleLabel = unreadView
      ? text("没有未读对话", "No unread conversations")
      : text("当前无后台运行对话", "No running conversations");
    const filters = idle ? "" : `<div class="ag-radar-filters">` +
      `<button type="button" class="ag-radar-filter${unreadView ? "" : " is-active"}" data-radar-filter="active">⚡ ${esc(text("运行中", "Running"))} <b>${active.length}</b></button>` +
      `<button type="button" class="ag-radar-filter${unreadView ? " is-active" : ""}" data-radar-filter="unread">● ${esc(text("未读", "Unread"))} <b>${unread.length}</b></button>` +
      `</div>`;
    let list = "";
    if (!idle) {
      if (visible.length) {
        list = `<div class="ag-radar-list">${visible.map(rowHtml).join("")}</div>`;
      } else if (unreadView) {
        list = `<div class="ag-radar-empty">${esc(text("没有未读对话", "No unread conversations"))}</div>`;
      } else {
        list = `<div class="ag-radar-empty"><strong>${esc(text("当前无运行中对话", "No running conversations"))}</strong>` +
          (unread.length ? ` · ${unread.length} ${esc(text("条未读可查看", "unread available"))}` : "") + `</div>`;
      }
    }
    host.innerHTML = `<div class="ag-radar-head">` +
      `<div class="ag-radar-title">${idle ? "✦" : `<span class="ag-radar-pulse${pulseClass}"></span>`}` +
      `<span>${idle || unreadView ? "" : active.length ? "⚡ " : "✦ "}${esc(title)}</span>` +
      `<span class="ag-radar-meta">${esc(idle ? idleLabel : countLabel)}</span></div>` +
      `<button type="button" class="ag-radar-toggle" data-radar-toggle title="${esc(text("折叠/展开", "Collapse/Expand"))}">${state.collapsed ? "▸" : "▾"}</button>` +
      `</div>` + filters +
      (state.error ? `<div class="ag-radar-error">${esc(state.error)}</div>` : "") + list;
    host.querySelectorAll("[data-radar-filter]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const next = button.getAttribute("data-radar-filter");
        state.filter = next === "unread" ? "unread" : "active";
        try { localStorage.setItem("ag-radar-filter", state.filter); } catch (error) {}
        render();
      });
    });
    host.querySelectorAll("[data-radar-id]").forEach((row) => {
      row.addEventListener("click", () => navigate(row.getAttribute("data-radar-id")));
    });
    host.querySelector("[data-radar-toggle]")?.addEventListener("click", (event) => {
      event.stopPropagation();
      state.collapsed = !state.collapsed;
      render();
    });
    renderBadges();
  }

  function renderBadges() {
    const groups = new Map();
    state.entries.filter((entry) => !entry.unread).forEach((entry) => {
      if (!entry.project) return;
      const key = entry.project.toLowerCase();
      if (!groups.has(key)) groups.set(key, { project: entry.project, entries: [] });
      groups.get(key).entries.push(entry);
    });
    document.querySelectorAll(`.${BADGE_CLASS}`).forEach((badge) => {
      const label = String(badge.dataset.project || "").toLowerCase();
      if (!groups.has(label)) badge.remove();
    });
    groups.forEach((group) => {
      const header = projectHeader(group.project);
      if (!header) return;
      const holder = header.closest(".relative.w-full.group\\/header") || header.parentElement;
      if (!holder) return;
      let badge = holder.querySelector(`:scope > .${BADGE_CLASS}`);
      if (!badge) {
        badge = document.createElement("button");
        badge.type = "button";
        badge.className = BADGE_CLASS;
        badge.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          showPopover(badge, group.project);
        });
        holder.appendChild(badge);
      }
      const waiting = group.entries.filter((entry) => entry.waiting).length;
      const running = group.entries.length - waiting;
      badge.dataset.project = group.project;
      badge.classList.toggle("is-waiting", !running && waiting > 0);
      badge.innerHTML = `${waiting && !running ? "⏳" : "⚡"} ${running || waiting}` +
        (waiting && running ? ` · ⏳${waiting}` : "");
      badge.title = `${group.project} · ${text("运行中", "Running")} ${running} · ${text("待确认", "Waiting")} ${waiting}`;
    });
  }

  function closePopover() {
    document.getElementById(POPOVER_ID)?.remove();
  }

  function showPopover(anchor, project) {
    closePopover();
    const entries = state.entries.filter((entry) => !entry.unread && String(entry.project || "").toLowerCase() === String(project).toLowerCase());
    if (!entries.length) return;
    ensureStyle();
    const pop = document.createElement("div");
    pop.id = POPOVER_ID;
    pop.innerHTML = `<div class="ag-radar-pop-head"><strong>${esc(project)}</strong><span>${entries.length} ${esc(text("个对话", "conversations"))}</span></div>` +
      entries.map((entry) => `<div class="ag-radar-pop-row" data-radar-id="${esc(entry.id)}"><span class="ag-radar-dot${entry.waiting ? " is-waiting" : ""}" style="${entry.waiting ? "background:#f6d893" : ""}"></span><span class="ag-radar-name">${esc(entry.title)}</span></div>`).join("");
    document.body.appendChild(pop);
    const rect = anchor.getBoundingClientRect();
    const width = 280;
    pop.style.left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left - 20)) + "px";
    pop.style.top = Math.min(window.innerHeight - 80, rect.bottom + 6) + "px";
    pop.querySelectorAll("[data-radar-id]").forEach((row) => {
      row.addEventListener("click", () => {
        const id = row.getAttribute("data-radar-id");
        closePopover();
        navigate(id);
      });
    });
    setTimeout(() => {
      const close = (event) => {
        if (pop.contains(event.target)) return;
        closePopover();
        document.removeEventListener("mousedown", close, true);
      };
      document.addEventListener("mousedown", close, true);
    }, 0);
  }

  function toast(message) {
    ensureStyle();
    let node = document.querySelector(".ag-radar-toast");
    if (!node) {
      node = document.createElement("div");
      node.className = "ag-radar-toast";
      document.body.appendChild(node);
    }
    node.textContent = message;
    node.classList.add("is-visible");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove("is-visible"), 1600);
  }

  function navigate(id) {
    if (!id) return;
    const target = state.entries.find((entry) => entry.id === id);
    if (target?.unread) {
      state.entries = state.entries.filter((entry) => entry.id !== id);
      render();
    }
    const path = "/c/" + id;
    if (location.pathname === path) return;
    const existing = document.querySelector(`a[href="${path}"]`);
    if (existing) {
      existing.click();
      return;
    }
    const link = document.createElement("a");
    link.href = path;
    link.style.display = "none";
    document.body.appendChild(link);
    try {
      link.click();
      if (location.pathname !== path) {
        history.pushState({}, "", path);
        window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
      }
    } finally {
      link.remove();
    }
    setTimeout(() => {
      if (location.pathname !== path) {
        history.pushState({}, "", path);
        window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
      }
    }, 30);
    state.currentId = id;
    render();
  }

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    try {
      const entries = await fetchTrajectories();
      state.entries = mergeEntries(entries);
      state.error = "";
    } catch (error) {
      state.entries = mergeEntries([]);
      state.error = text("雷达暂时无法读取运行状态", "Radar temporarily unavailable");
    } finally {
      state.loading = false;
      state.lastFetch = Date.now();
      render();
    }
  }

  function markTransient(running) {
    const id = currentCascadeId();
    if (!id) return;
    if (running) {
      state.transient = {
        at: Date.now(),
        entry: {
          id,
          title: text("当前对话", "Current conversation"),
          project: "",
          status: "CASCADE_RUN_STATUS_RUNNING",
          waiting: false,
          unread: false,
          kind: "running",
          updated: Date.now(),
          stepCount: 0,
          transient: true,
        },
      };
      state.entries = mergeEntries(state.entries);
      render();
      setTimeout(refresh, 900);
    } else {
      state.transient = null;
      refresh();
    }
  }

  function cycle() {
    const entries = visibleEntries();
    if (!entries.length) {
      toast(state.filter === "unread"
        ? text("当前没有未读对话", "No unread conversations")
        : text("当前没有运行中的对话", "No running conversations"));
      return;
    }
    const index = entries.findIndex((entry) => entry.id === state.currentId);
    const next = entries[(index + 1) % entries.length];
    const label = [next.project, next.title].filter(Boolean).join(" · ");
    navigate(next.id);
    toast((next.waiting ? "⏳ " : next.unread ? "● " : "⚡ ") + label);
  }

  function bind() {
    document.addEventListener("click", (event) => {
      const button = event.target.closest?.("button, [role=button]");
      if (!button) return;
      const label = [button.getAttribute("aria-label"), button.getAttribute("title"), button.textContent].filter(Boolean).join(" ");
      if (STOP_HINT.test(label)) {
        markTransient(false);
        return;
      }
      if (SEND_HINT.test(label) && button.closest(".no-focus-agent-input, [data-testid=composer], form")) {
        markTransient(true);
      }
    }, true);
    document.addEventListener("keydown", (event) => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && String(event.key).toLowerCase() === "r") {
        event.preventDefault();
        event.stopPropagation();
        cycle();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
        const editor = event.target.closest?.('[contenteditable="true"], textarea');
        if (editor) markTransient(true);
      }
    }, true);
    window.addEventListener("popstate", refresh);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refresh();
    });
    document.addEventListener("ag-config-updated", (event) => {
      const patch = event.detail || {};
      if (Object.prototype.hasOwnProperty.call(patch, "runningRadar") || Object.prototype.hasOwnProperty.call(patch, "hideRadarWhenIdle")) {
        render();
      }
      if (patch.language) render();
    });
    window.addEventListener("resize", () => {
      closePopover();
      render();
    }, { passive: true });
    state.timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      if (location.pathname !== state.lastPath) {
        state.lastPath = location.pathname;
        state.currentId = currentCascadeId();
        refresh();
        return;
      }
      if (Date.now() - state.lastFetch > 2400) refresh();
    }, 500);
    refresh();
  }

  window.__agRadarPreview = (entries) => {
    const list = (Array.isArray(entries) ? entries : []).map((entry, index) => {
      const unread = !!entry.unread;
      return {
        id: entry.id || ("preview-" + index),
        title: entry.title || "Preview conversation",
        project: entry.project || "",
        status: unread ? "CASCADE_RUN_STATUS_IDLE" : entry.waiting ? "CASCADE_RUN_STATUS_WAITING" : "CASCADE_RUN_STATUS_RUNNING",
        waiting: !!entry.waiting && !unread,
        unread,
        kind: unread ? "unread" : entry.waiting ? "waiting" : "running",
        updated: Number(entry.updated) || (Date.now() - index * 60000),
        stepCount: 0,
        transient: true,
      };
    });
    state.entries = mergeEntries(list);
    render();
    return state.entries.length;
  };
  window.__agRadarState = () => ({
    filter: state.filter,
    entries: state.entries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      project: entry.project,
      unread: !!entry.unread,
      waiting: !!entry.waiting,
      kind: entry.kind,
      updated: entry.updated,
    })),
  });
  window.__agRadarClearPreview = () => {
    state.entries = [];
    refresh();
    return true;
  };

  if (document.body) bind();
  else document.addEventListener("DOMContentLoaded", bind, { once: true });
})();
