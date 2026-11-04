/**
 * telemetry-panels.js
 * v4.0 底部实时遥测三面板 + 任务进度条 + 背景时钟。
 *
 * 主数据源：LanguageServerService 的 GeneratorMetadata（TTFT、流式时长、
 * Token/缓存、上下文 tokenBreakdown）与 TrajectorySteps（轮/步、工具耗时）。
 * 回退/任务源：sidecar /api/telemetry/session（transcript.jsonl + task.md）。
 */
(function () {
  if (window.__agTelemetryPanelsInstalled) return;
  window.__agTelemetryPanelsInstalled = true;

  const VERSION = "4.0.0";
  const STYLE_ID = "ag-telemetry-style";
  const BAR_ID = "ag-telemetry-bar";
  const TASK_ID = "ag-task-bar";
  const GOAL_ID = "ag-quick-goal";
  const CLOCK_ID = "ag-ambient-clock";
  const POP_ID = "ag-telemetry-popover";
  const TOAST_ID = "ag-telemetry-toast";
  const EMPTY_TASKS = { exists: false, doing: 0, todo: 0, done: 0, total: 0, items: [] };
  const CONTEXT_COLORS = { system: "#94A3B8", tools: "#A78BFA", messages: "#38BDF8" };

  const state = {
    cascadeId: "",
    session: null,
    popoverPanel: "",
    popoverAnchor: null,
    popoverPinned: false,
    popoverHover: false,
    showTimer: 0,
    hideTimer: 0,
    taskExpanded: false,
    timer: 0,
    clockTimer: 0,
    lastPath: location.pathname,
    lastSignature: "",
  };
  const sessions = new Map();

  const cfg = () => window.__AG_CONFIG || {};
  const isEn = () => String(cfg().language || "zh-CN").toLowerCase() === "en";
  const text = (zh, en) => (isEn() ? en : zh);
  const sidecarBase = () => "http://127.0.0.1:" + (window.__AG_SIDECAR_PORT || 39290);

  function currentId() {
    const match = String(location.pathname || "").match(/\/c\/([0-9a-f-]{8,})/i);
    return match ? match[1] : "";
  }

  function int(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
  }

  function fmtInt(value) {
    return int(value).toLocaleString("en-US");
  }

  const esc = (value) => String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function compact(value) {
    const number = int(value);
    if (number >= 1e9) return (number / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
    if (number >= 1e6) return (number / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (number >= 1e3) return (number / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return String(number);
  }

  function parseSeconds(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (typeof value !== "string") return 0;
    const match = value.trim().match(/^(-?[\d.]+)\s*s$/i);
    if (match) return Number(match[1]) || 0;
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function duration(ms) {
    const total = Math.max(0, Math.round(Number(ms) || 0));
    if (!total) return "—";
    if (total < 1000) return "<1" + text("秒", "s");
    const seconds = Math.round(total / 1000);
    if (seconds < 60) return seconds + text("秒", "s");
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    if (minutes < 60) return minutes + text("分", "m") + (isEn() ? " " : "") + String(rest).padStart(2, "0") + text("秒", "s");
    const hours = Math.floor(minutes / 60);
    return hours + text("小时", "h") + String(minutes % 60).padStart(2, "0") + text("分", "m");
  }

  function shortDuration(ms) {
    const seconds = Math.max(0, Number(ms) || 0) / 1000;
    if (!seconds) return "—";
    if (seconds < 60) return (seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)) + "s";
    return duration(ms);
  }

  function parseContext(ctx, chatModel) {
    if (!ctx) return null;
    const groups = Array.isArray(ctx.tokenBreakdown?.groups) ? ctx.tokenBreakdown.groups : [];
    let system = 0;
    let tools = 0;
    let messages = 0;
    groups.forEach((group) => {
      const count = int(group.numTokens);
      const name = String(group.name || "").toLowerCase();
      const type = String(group.type || "").toUpperCase();
      if (type.includes("SYSTEM_PROMPT") || name.includes("system prompt")) system += count;
      else if (type.includes("TOOLS") || name === "tools") tools += count;
      else if (type.includes("CHAT_MESSAGES") || name.includes("chat messages")) messages += count;
      else messages += count;
    });
    let used = int(ctx.estimatedTokensUsed) || system + tools + messages;
    if (!groups.length && chatModel) {
      const fallbackSystem = Math.round(String(chatModel.systemPrompt || "").length / 4);
      const fallbackTools = Math.round(JSON.stringify(chatModel.tools || []).length / 4);
      if (!used) used = fallbackSystem + fallbackTools;
      system = fallbackSystem;
      tools = fallbackTools;
      messages = Math.max(0, used - system - tools);
    }
    const max = int(ctx.maxContextTokens) || 256000;
    return {
      used,
      max,
      percent: max ? Math.min(100, (used / max) * 100) : 0,
      system,
      tools,
      messages,
    };
  }

  function ratesFor(model) {
    const name = String(model || "").toLowerCase();
    if (name.includes("claude")) return { input: 3, cache: 0.3, output: 15 };
    if (name.includes("gpt") || name.includes("openai")) return { input: 2.5, cache: 1.25, output: 10 };
    return { input: 1.25, cache: 0.31, output: 10 };
  }

  function costFor(tokens, model) {
    const rates = ratesFor(model);
    const saved = (tokens.cacheRead / 1e6) * Math.max(0, rates.input - rates.cache);
    const total = (tokens.input * rates.input + tokens.cacheRead * rates.cache + tokens.output * rates.output) / 1e6;
    return { estimated: true, cacheSaved: saved, total, currency: "USD" };
  }

  function newSession(id) {
    return {
      id,
      metaOffset: 0,
      stepOffset: 0,
      metaLoaded: false,
      stepsLoaded: false,
      loading: false,
      pending: false,
      lastFetch: 0,
      sidecar: null,
      tasks: null,
      previewTasks: null,
      metaError: "",
      stepError: "",
      stats: {
        turns: 0,
        steps: 0,
        input: 0,
        cacheRead: 0,
        output: 0,
        ttftSum: 0,
        ttftCount: 0,
        modelMs: 0,
        toolMs: 0,
        generators: 0,
        context: null,
        model: "",
      },
    };
  }

  function ensureSession(id) {
    if (!id) return null;
    if (!sessions.has(id)) sessions.set(id, newSession(id));
    return sessions.get(id);
  }

  function buildView(session) {
    if (!session) return null;
    const stats = session.stats;
    const side = session.sidecar && session.sidecar.ok ? session.sidecar : null;
    const metaReady = session.metaLoaded;
    const tokens = metaReady
      ? { input: stats.input, cacheRead: stats.cacheRead, output: stats.output, total: stats.input + stats.cacheRead + stats.output }
      : side?.tokens
        ? { input: int(side.tokens.input), cacheRead: int(side.tokens.cacheRead), output: int(side.tokens.output), total: int(side.tokens.total) }
        : { input: 0, cacheRead: 0, output: 0, total: 0 };
    const cached = tokens.cacheRead + tokens.input;
    const cacheHit = cached ? (tokens.cacheRead / cached) * 100 : (side?.tokens?.cacheHitRate || 0);
    const steps = session.stepsLoaded ? stats.steps : (int(side?.steps) || 0);
    const turns = stats.turns || (int(side?.turns) || 0);
    const modelMs = stats.modelMs;
    const toolMs = session.stepsLoaded ? stats.toolMs : 0;
    const ttft = stats.ttftCount ? stats.ttftSum / stats.ttftCount : 0;
    const tps = modelMs > 0 ? tokens.output / (modelMs / 1000) : 0;
    let context = stats.context;
    if (!context && side?.context) {
      const used = int(side.context.used);
      const max = int(side.context.max) || 256000;
      context = { used, max, percent: max ? (used / max) * 100 : 0, system: 0, tools: 0, messages: used };
    }
    const tasks = session.previewTasks || session.tasks || side?.tasks || EMPTY_TASKS;
    const cost = side?.cost && side.cost.cacheSaved != null ? side.cost : costFor(tokens, stats.model);
    const running = isRunning();
    const generating = running && !metaReady && tokens.total === 0;
    return {
      session,
      ready: metaReady || session.stepsLoaded || !!side,
      generating,
      running,
      tokens,
      cacheHit,
      steps,
      turns,
      modelMs,
      toolMs,
      ttft,
      tps,
      context,
      tasks,
      cost,
      model: stats.model || "",
      updating: session.loading,
    };
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${BAR_ID}{display:flex;align-items:center;justify-content:center;gap:14px;width:100%;height:24px;margin-top:3px;
        color:#8ea1b8;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:11px;line-height:1;
        font-variant-numeric:tabular-nums;white-space:nowrap;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}
      #${BAR_ID}::-webkit-scrollbar{display:none}
      #${BAR_ID}.is-hidden{display:none!important}
      #${BAR_ID} .ag-tele-pill{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 7px;border:1px solid transparent;border-radius:999px;
        background:transparent;color:#92a5bb;font:inherit;cursor:pointer;white-space:nowrap;transition:background-color .14s,border-color .14s,color .14s}
      #${BAR_ID} .ag-tele-pill:hover,#${BAR_ID} .ag-tele-pill.is-active{background:rgba(246,216,147,.095);border-color:rgba(246,216,147,.20);color:#f2e7c9}
      #${BAR_ID} .ag-tele-pill.is-live svg{animation:ag-tele-breathe 1.8s ease-in-out infinite}
      #${BAR_ID} .ag-tele-pill.is-live span{color:#b9c8da}
      #${BAR_ID} .ag-tele-pill svg{width:13px;height:13px;flex:0 0 13px;opacity:.82}
      #${BAR_ID} .ag-tele-pill strong{color:#dbe7f4;font-weight:600}
      #${BAR_ID} .ag-tele-unit{color:#7f93ab}
      #${BAR_ID} .ag-tele-ring{flex:0 0 14px}
      #${BAR_ID} .ag-tele-dot{width:3px;height:3px;border-radius:50%;background:rgba(255,255,255,.18)}
      #${TASK_ID}{position:relative;width:100%;display:flex;flex-direction:column;margin-bottom:5px;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
      #${TASK_ID}.is-hidden{display:none!important}
      #${TASK_ID} .ag-task-summary{display:flex;align-items:center;gap:7px;width:100%;height:27px;padding:0 10px;border:1px solid rgba(246,216,147,.14);border-radius:9px;
        background:linear-gradient(90deg,rgba(246,216,147,.07),rgba(196,181,253,.045));color:#b9c8da;font:500 11px/1 inherit;cursor:pointer;text-align:left}
      #${TASK_ID} .ag-task-summary:hover{border-color:rgba(246,216,147,.3);background:linear-gradient(90deg,rgba(246,216,147,.11),rgba(196,181,253,.07));color:#f0e7d4}
      #${TASK_ID} .ag-task-ico{color:#f6d893;font-size:12px}
      #${TASK_ID} .ag-task-summary strong{color:#f6d893;font-weight:600}
      #${TASK_ID} .ag-task-expand{margin-left:auto;color:#7f93ab;transition:transform .16s}
      #${TASK_ID}.is-open .ag-task-expand{transform:rotate(180deg)}
      #${TASK_ID} .ag-task-list{position:absolute;left:0;right:0;bottom:calc(100% + 6px);z-index:80;display:none;max-height:190px;overflow-y:auto;padding:7px;
        border:1px solid rgba(196,181,253,.18);border-radius:11px;background:rgba(15,17,32,.95);backdrop-filter:blur(20px) saturate(160%);
        box-shadow:0 18px 44px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.05);scrollbar-width:thin}
      #${TASK_ID}.is-open .ag-task-list{display:block}
      #${TASK_ID} .ag-task-item{display:flex;align-items:flex-start;gap:7px;padding:5px 6px;border-radius:6px;color:#b8c7d9;font-size:10.5px;line-height:1.4}
      #${TASK_ID} .ag-task-item:hover{background:rgba(255,255,255,.04)}
      #${TASK_ID} .ag-task-item[data-state="doing"]{color:#f6e7c3;background:rgba(246,216,147,.06)}
      #${TASK_ID} .ag-task-item[data-state="done"]{color:#71839a}
      #${TASK_ID} .ag-task-item[data-state="done"] .ag-task-mark{color:#86e0c0}
      #${TASK_ID} .ag-task-item[data-state="doing"] .ag-task-mark{color:#f6d893}
      #${TASK_ID} .ag-task-mark{flex:0 0 11px;text-align:center;line-height:1.35}
      #${GOAL_ID}{display:inline-flex;align-items:center;gap:5px;align-self:flex-start;height:22px;margin:0 0 5px;padding:0 9px;border:1px solid rgba(196,181,253,.2);border-radius:999px;
        background:rgba(196,181,253,.07);color:#cbbdf3;font:500 10.5px/1 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;cursor:pointer}
      #${GOAL_ID}:hover{background:rgba(246,216,147,.1);border-color:rgba(246,216,147,.28);color:#f6e7c3}
      #${GOAL_ID}.is-hidden{display:none!important}
      #${CLOCK_ID}{position:fixed;z-index:0;pointer-events:none;user-select:none;text-align:center;color:rgba(241,245,255,.105);
        font-family:Georgia,"Times New Roman",serif;line-height:1;mix-blend-mode:screen;text-shadow:0 0 28px rgba(196,181,253,.12)}
      #${CLOCK_ID} .ag-clock-time{font-size:clamp(76px,10vw,142px);font-weight:300;letter-spacing:-.045em;font-variant-numeric:tabular-nums}
      #${CLOCK_ID} .ag-clock-date{margin-top:9px;font-size:17px;letter-spacing:.18em;opacity:.72}
      #${POP_ID}{position:fixed;z-index:9600;width:292px;max-width:calc(100vw - 24px);padding:12px 13px 10px;border:1px solid rgba(196,181,253,.19);border-radius:14px;
        background:radial-gradient(120% 80% at 100% 0%,rgba(139,92,246,.12),transparent 58%),rgba(15,17,32,.93);
        backdrop-filter:blur(24px) saturate(180%);box-shadow:0 20px 50px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.06);
        color:#dce6f2;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:11px;line-height:1.4}
      #${POP_ID}.is-hidden{display:none!important}
      #${POP_ID} .ag-pop-head{display:flex;align-items:flex-start;gap:8px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,.07)}
      #${POP_ID} .ag-pop-title{flex:1;min-width:0;display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:#f3f1ea}
      #${POP_ID} .ag-pop-title svg{width:14px;height:14px;color:#f6d893;flex:0 0 14px}
      #${POP_ID} .ag-pop-sub{font-size:10px;color:#8295ac;margin-top:2px}
      #${POP_ID} .ag-pop-copy{width:23px;height:23px;display:grid;place-items:center;border:1px solid rgba(255,255,255,.08);border-radius:6px;background:transparent;color:#8fa2b8;cursor:pointer}
      #${POP_ID} .ag-pop-copy:hover{color:#f6e7c3;border-color:rgba(246,216,147,.25);background:rgba(246,216,147,.07)}
      #${POP_ID} .ag-pop-copy svg{width:12px;height:12px}
      #${POP_ID} .ag-pop-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.035)}
      #${POP_ID} .ag-pop-row:last-of-type{border-bottom:0}
      #${POP_ID} .ag-pop-row span{color:#9bacc0}
      #${POP_ID} .ag-pop-row strong{color:#f1f5fb;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
      #${POP_ID} .ag-pop-total{font-size:12px;color:#f6e7c3;font-variant-numeric:tabular-nums}
      #${POP_ID} .ag-pop-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:10px;padding:9px 0 7px}
      #${POP_ID} .ag-pop-hero strong{font-size:24px;font-weight:600;color:#f3e8cb;line-height:1;font-variant-numeric:tabular-nums}
      #${POP_ID} .ag-pop-hero span{font-size:10.5px;color:#8598af}
      #${POP_ID} .ag-ctx-track{display:flex;height:6px;border-radius:999px;overflow:hidden;background:rgba(255,255,255,.07);margin:8px 0 7px}
      #${POP_ID} .ag-ctx-seg{height:100%;min-width:0}
      #${POP_ID} .ag-legend{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0;color:#9bacc0}
      #${POP_ID} .ag-legend .ag-legend-name{display:flex;align-items:center;gap:6px}
      #${POP_ID} .ag-legend i{width:7px;height:7px;border-radius:2px;display:inline-block}
      #${POP_ID} .ag-legend strong{color:#e8eef7;font-weight:500;font-variant-numeric:tabular-nums}
      #${POP_ID} .ag-pop-cost{margin-top:7px;padding-top:7px;border-top:1px solid rgba(255,255,255,.06);color:#b9a880;font-size:9.5px}
      #${POP_ID} .ag-pop-cost strong{color:#f6d893;font-weight:600}
      #${POP_ID} .ag-pop-empty{padding:10px 0 4px;color:#7d90a7}
      #${TOAST_ID}{position:fixed;left:50%;bottom:34px;transform:translate(-50%,8px);z-index:10003;padding:7px 12px;border:1px solid rgba(196,181,253,.2);border-radius:999px;
        background:rgba(12,14,26,.95);color:#e9eef8;font:500 11px/1.4 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;opacity:0;pointer-events:none;transition:opacity .16s,transform .16s}
      #${TOAST_ID}.is-visible{opacity:1;transform:translate(-50%,0)}
      @keyframes ag-tele-breathe{0%,100%{opacity:.42;transform:scale(.94)}50%{opacity:.95;transform:scale(1.06)}}
      @media (prefers-reduced-motion:reduce){#${BAR_ID} .ag-tele-pill,#${TOAST_ID}{transition:none!important}#${BAR_ID} .ag-tele-pill.is-live svg{animation:none!important}}
    `;
    document.head.appendChild(style);
  }

  function grpcFrame(payload) {
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const frame = new Uint8Array(5 + body.length);
    new DataView(frame.buffer).setUint32(1, body.length, false);
    frame.set(body, 5);
    return frame;
  }

  function parseGrpc(buffer) {
    let offset = 0;
    let last = null;
    while (offset + 5 <= buffer.length) {
      const length = ((buffer[offset + 1] << 24) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 8) | buffer[offset + 4]) >>> 0;
      const start = offset + 5;
      const end = start + length;
      offset = end;
      if (!length || end > buffer.length) break;
      try { last = JSON.parse(new TextDecoder().decode(buffer.subarray(start, end))); } catch (error) {}
    }
    return last;
  }

  async function grpcCall(method, payload) {
    const token = window.__APP_CONFIG__?.csrfToken;
    if (!token) throw new Error("missing csrf token");
    const response = await fetch("/exa.language_server_pb.LanguageServerService/" + method, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/grpc-web+json",
        "x-grpc-web": "1",
        "x-codeium-csrf-token": token,
        "x-user-agent": "CONNECT_ES_USER_AGENT",
      },
      body: grpcFrame(payload),
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const parsed = parseGrpc(new Uint8Array(await response.arrayBuffer()));
    if (!parsed) throw new Error("empty gRPC payload");
    return parsed;
  }

  async function fetchMetadata(session) {
    const payload = await grpcCall("GetCascadeTrajectoryGeneratorMetadata", {
      cascadeId: session.id,
      generatorMetadataOffset: session.metaOffset,
    });
    const list = Array.isArray(payload.generatorMetadata) ? payload.generatorMetadata : [];
    const stats = session.stats;
    list.forEach((item) => {
      const chatModel = item.chatModel || {};
      const usage = chatModel.usage || {};
      stats.input += int(usage.inputTokens);
      stats.cacheRead += int(usage.cacheReadTokens);
      stats.output += int(usage.outputTokens);
      const ttft = parseSeconds(chatModel.timeToFirstToken);
      if (ttft > 0) {
        stats.ttftSum += ttft;
        stats.ttftCount += 1;
      }
      stats.modelMs += parseSeconds(chatModel.streamingDuration) * 1000;
      stats.generators += 1;
      if (chatModel.modelDisplayName) stats.model = chatModel.modelDisplayName;
      const context = chatModel.chatStartMetadata?.contextWindowMetadata;
      if (context) stats.context = parseContext(context, chatModel);
    });
    session.metaOffset += list.length;
    session.metaLoaded = true;
    session.metaError = "";
    return list.length;
  }

  async function fetchSteps(session) {
    const payload = await grpcCall("GetCascadeTrajectorySteps", {
      cascadeId: session.id,
      stepOffset: session.stepOffset,
    });
    const list = Array.isArray(payload.steps) ? payload.steps : [];
    list.forEach((step) => {
      if (step.type === "CORTEX_STEP_TYPE_USER_INPUT" || step.userInput) session.stats.turns += 1;
      const metadata = step.metadata || {};
      if (metadata.toolCall) {
        const started = Date.parse(metadata.startedAt || "");
        const completed = Date.parse(metadata.completedAt || "");
        if (Number.isFinite(started) && Number.isFinite(completed) && completed >= started) {
          session.stats.toolMs += completed - started;
        }
      }
    });
    session.stepOffset += list.length;
    session.stats.steps = session.stepOffset;
    session.stepsLoaded = true;
    session.stepError = "";
    return list.length;
  }

  async function fetchSidecar(session) {
    const response = await fetch(sidecarBase() + "/api/telemetry/session?id=" + encodeURIComponent(session.id), { cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json();
    if (data && data.ok) {
      session.sidecar = data;
      if (data.tasks) session.tasks = data.tasks;
    } else if (data && data.tasks) {
      session.tasks = data.tasks;
    }
  }

  async function sync(force) {
    const id = state.cascadeId;
    const session = state.session;
    if (!id || !session) return;
    if (session.loading) {
      session.pending = true;
      return;
    }
    session.loading = true;
    session.lastFetch = Date.now();
    const side = fetchSidecar(session).catch(() => {});
    const meta = fetchMetadata(session).catch((error) => { session.metaError = error.message || String(error); });
    const steps = fetchSteps(session).catch((error) => { session.stepError = error.message || String(error); });
    await Promise.allSettled([side, meta]);
    if (state.cascadeId === id) renderAll();
    await steps;
    session.loading = false;
    if (state.cascadeId === id) renderAll();
    if (session.pending) {
      session.pending = false;
      setTimeout(() => { if (state.cascadeId === id) sync(true); }, 160);
    }
  }

  function composer() {
    return document.getElementById("antigravity.agentSidePanelInputBox") || document.querySelector(".surface-composer");
  }

  function ensureBar() {
    const input = composer();
    const parent = input?.parentElement;
    if (!input || !parent) return null;
    let bar = document.getElementById(BAR_ID);
    if (!bar) {
      bar = document.createElement("div");
      bar.id = BAR_ID;
      bar.setAttribute("role", "status");
      bar.setAttribute("aria-label", text("会话遥测", "Conversation telemetry"));
    }
    if (bar.parentElement !== parent || bar.previousElementSibling !== input) {
      parent.insertBefore(bar, input.nextSibling);
    }
    return bar;
  }

  function ensureTaskBar() {
    const input = composer();
    const parent = input?.parentElement;
    if (!input || !parent) return null;
    let bar = document.getElementById(TASK_ID);
    if (!bar) {
      bar = document.createElement("div");
      bar.id = TASK_ID;
      bar.className = "is-hidden";
    }
    if (bar.parentElement !== parent) {
      const goal = document.getElementById(GOAL_ID);
      parent.insertBefore(bar, goal && goal.parentElement === parent ? goal : input);
    }
    return bar;
  }

  function ensureGoal() {
    const input = composer();
    const parent = input?.parentElement;
    if (!input || !parent) return null;
    let goal = document.getElementById(GOAL_ID);
    if (!goal) {
      goal = document.createElement("button");
      goal.id = GOAL_ID;
      goal.type = "button";
      goal.className = "is-hidden";
      goal.textContent = "◎ " + text("启动目标", "Start goal");
      goal.title = text("向输入框写入 /goal", "Insert /goal into the composer");
      goal.addEventListener("click", (event) => {
        event.preventDefault();
        insertGoal();
      });
    }
    if (goal.parentElement !== parent || goal.nextElementSibling !== input) {
      parent.insertBefore(goal, input);
    }
    return goal;
  }
  function ensureClock() {
    let clock = document.getElementById(CLOCK_ID);
    if (!clock) {
      clock = document.createElement("div");
      clock.id = CLOCK_ID;
      clock.innerHTML = `<div class="ag-clock-time"></div><div class="ag-clock-date"></div>`;
      document.body.appendChild(clock);
    }
    return clock;
  }

  function removeNode(id) {
    document.getElementById(id)?.remove();
  }

  function hidePanel(force) {
    if (state.popoverPinned && !force) return;
    state.popoverPanel = "";
    state.popoverAnchor = null;
    state.popoverPinned = false;
    state.popoverHover = false;
    removeNode(POP_ID);
    document.querySelectorAll(`#${BAR_ID} .ag-tele-pill`).forEach((pill) => pill.classList.remove("is-active"));
  }

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

  function insertGoal() {
    const editor = document.querySelector('[contenteditable="true"]');
    if (!editor) {
      toast(text("未找到输入框", "Composer not found"));
      return;
    }
    editor.focus();
    const selection = window.getSelection();
    if (selection && selection.rangeCount === 0) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.addRange(range);
    }
    let inserted = false;
    try { inserted = document.execCommand("insertText", false, "/goal "); } catch (error) {}
    if (!inserted) {
      editor.textContent = String(editor.textContent || "") + "/goal ";
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "/goal " }));
    }
    toast(text("已写入 /goal", "Inserted /goal"));
  }

  function ringSvg(percent) {
    const value = Math.max(0, Math.min(100, Number(percent) || 0));
    const color = value > 80 ? "#fb7185" : value > 60 ? "#f6d893" : "#22e3ff";
    const radius = 6.4;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference * (1 - value / 100);
    return `<svg class="ag-tele-ring" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="${radius}" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="2"/><circle cx="8" cy="8" r="${radius}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" transform="rotate(-90 8 8)"/></svg>`;
  }

  const ICONS = {
    stats: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-6"/><path d="M22 19H2"/></svg>`,
    tokens: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v5c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 11v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>`,
  };

  function renderBar(view) {
    if (!view) return;
    const bar = ensureBar();
    if (!bar) return;
    if (cfg().telemetryBar === false) {
      bar.classList.add("is-hidden");
      hidePanel(true);
      return;
    }
    bar.classList.remove("is-hidden");
    const tps = view.tps ? Math.round(view.tps) : 0;
    const hit = Math.round(view.cacheHit);
    const ctx = view.context ? Math.round(view.context.percent) : 0;
    const turnUnit = isEn() ? (view.turns === 1 ? "turn" : "turns") : "轮";
    const stepUnit = isEn() ? (view.steps === 1 ? "step" : "steps") : "步";
    const statsText = view.generating
      ? `${view.turns} ${turnUnit} ${view.steps} ${stepUnit} · ${text("生成中…", "generating…")}`
      : `${view.turns} ${turnUnit} ${view.steps} ${stepUnit} · <strong>${tps || "—"}</strong> tok/s`;
    const tokenText = view.generating ? text("等待模型响应…", "waiting for model…") : `${compact(view.tokens.total)} tok · ${text("缓存命中", "cache hit")} ${hit}%`;
    const contextText = view.generating && !view.context ? "—" : `${ctx}%`;
    bar.innerHTML = `<button type="button" class="ag-tele-pill${view.generating ? " is-live" : ""}" data-tele-panel="stats" title="${text("会话统计", "Session stats")}">${ICONS.stats}<span>${statsText}</span></button>` +
      `<span class="ag-tele-dot"></span>` +
      `<button type="button" class="ag-tele-pill${view.generating ? " is-live" : ""}" data-tele-panel="tokens" title="${text("Token 用量", "Token usage")}">${ICONS.tokens}<span>${tokenText}</span></button>` +
      `<span class="ag-tele-dot"></span>` +
      `<button type="button" class="ag-tele-pill${view.generating && !view.context ? " is-live" : ""}" data-tele-panel="context" title="${text("上下文已用", "Context used")}">${ringSvg(ctx)}<span>${contextText}</span></button>`;
    bindBar(bar);
    if (state.popoverPanel) {
      const activePill = bar.querySelector(`[data-tele-panel="${state.popoverPanel}"]`);
      if (activePill) state.popoverAnchor = activePill;
      renderPopover(view);
    }
  }

  function bindBar(bar) {
    bar.onpointerover = (event) => {
      const pill = event.target.closest("[data-tele-panel]");
      if (!pill) return;
      clearTimeout(state.showTimer);
      clearTimeout(state.hideTimer);
      const panel = pill.getAttribute("data-tele-panel");
      state.showTimer = setTimeout(() => {
        if (!state.popoverPinned) showPanel(panel, pill, false);
      }, 120);
    };
    bar.onpointerout = (event) => {
      const pill = event.target.closest("[data-tele-panel]");
      if (!pill) return;
      if (event.relatedTarget && pill.contains(event.relatedTarget)) return;
      clearTimeout(state.showTimer);
      if (!state.popoverPinned) {
        clearTimeout(state.hideTimer);
        state.hideTimer = setTimeout(() => hidePanel(), 180);
      }
    };
    bar.onclick = (event) => {
      const pill = event.target.closest("[data-tele-panel]");
      if (!pill) return;
      event.preventDefault();
      event.stopPropagation();
      clearTimeout(state.showTimer);
      clearTimeout(state.hideTimer);
      const panel = pill.getAttribute("data-tele-panel");
      if (state.popoverPinned && state.popoverPanel === panel) {
        hidePanel(true);
      } else {
        showPanel(panel, pill, true);
      }
    };
  }

  function showPanel(panel, anchor, pinned) {
    ensureStyle();
    const view = buildView(state.session);
    if (!view) return;
    state.popoverPanel = panel;
    state.popoverAnchor = anchor;
    state.popoverPinned = !!pinned;
    let pop = document.getElementById(POP_ID);
    if (!pop) {
      pop = document.createElement("div");
      pop.id = POP_ID;
      document.body.appendChild(pop);
    }
    pop.classList.remove("is-hidden");
    pop.onpointerenter = () => {
      state.popoverHover = true;
      clearTimeout(state.hideTimer);
    };
    pop.onpointerleave = () => {
      state.popoverHover = false;
      if (!state.popoverPinned) {
        clearTimeout(state.hideTimer);
        state.hideTimer = setTimeout(() => hidePanel(), 180);
      }
    };
    renderPopover(view);
    document.querySelectorAll(`#${BAR_ID} .ag-tele-pill`).forEach((pill) => pill.classList.toggle("is-active", pill.getAttribute("data-tele-panel") === panel));
  }

  function renderPopover(view) {
    if (!view || !state.popoverPanel) return;
    let pop = document.getElementById(POP_ID);
    if (!pop) return;
    const panel = state.popoverPanel;
    const content = panel === "tokens" ? tokensPanel(view) : panel === "context" ? contextPanel(view) : statsPanel(view);
    pop.innerHTML = content;
    pop.querySelector("[data-tele-copy]")?.addEventListener("click", () => copyPanel(panel, view));
    positionPopover();
  }

  function panelHead(title, icon, sub) {
    return `<div class="ag-pop-head"><div class="ag-pop-title">${icon || ""}<div>${esc(title)}${sub ? `<div class="ag-pop-sub">${esc(sub)}</div>` : ""}</div></div><button type="button" class="ag-pop-copy" data-tele-copy title="${text("复制摘要", "Copy summary")}">${ICONS.copy}</button></div>`;
  }

  function row(label, value) {
    return `<div class="ag-pop-row"><span>${esc(label)}</span><strong>${value}</strong></div>`;
  }

  function statsPanel(view) {
    const tps = view.tps ? Math.round(view.tps) : 0;
    if (view.generating) {
      return panelHead(text("会话统计", "Session stats"), ICONS.stats, view.model || "") + `<div class="ag-pop-empty">${text("模型正在生成，完成后自动刷新…", "The model is generating; stats will refresh when done…")}</div>`;
    }
    return panelHead(text("会话统计", "Session stats"), ICONS.stats, view.model || "") +
      `<div style="padding-top:3px">` +
      row(text("模型用时", "Model time"), duration(view.modelMs)) +
      row(text("工具调用用时", "Tool time"), duration(view.toolMs)) +
      row(text("首 token 平均 (TTFT)", "Avg TTFT"), view.ttft ? shortDuration(view.ttft * 1000) : "—") +
      row(text("输出速度 (TPS)", "Output speed (TPS)"), (tps || "—") + " tok/s") +
      `</div>`;
  }

  function tokensPanel(view) {
    if (view.generating) {
      return panelHead(text("Token 用量", "Token usage"), ICONS.tokens, "") + `<div class="ag-pop-empty">${text("等待模型响应，Token 将在完成后累加…", "Waiting for the model; tokens will be summed when the response completes…")}</div>`;
    }
    const tokens = view.tokens;
    const cost = view.cost;
    const showCost = cfg().telemetryShowCost !== false && cost && cost.cacheSaved > 0;
    return panelHead(text("Token 用量", "Token usage"), ICONS.tokens, "") +
      `<div class="ag-pop-hero"><strong>${fmtInt(tokens.total)}</strong><span>tok</span></div>` +
      row(text("缓存命中", "Cache hit"), (view.cacheHit ? view.cacheHit.toFixed(1) : "0") + "%") +
      row(text("未缓存输入", "Uncached input"), fmtInt(tokens.input) + " tok") +
      row(text("缓存读取", "Cache read"), fmtInt(tokens.cacheRead) + " tok") +
      row(text("输出", "Output"), fmtInt(tokens.output) + " tok") +
      (showCost ? `<div class="ag-pop-cost">${text("缓存已省", "Cache saved")} <strong>~$${cost.cacheSaved.toFixed(2)}</strong> · ${text("估算", "estimated")}</div>` : "");
  }

  function contextPanel(view) {
    const ctx = view.context;
    if (!ctx) {
      const message = view.generating
        ? text("模型正在生成，完成后显示上下文构成…", "Context breakdown will appear when generation completes…")
        : text("上下文数据尚未就绪", "Context data is not ready yet");
      return panelHead(text("上下文已用", "Context used"), "", "") + `<div class="ag-pop-empty">${message}</div>`;
    }
    const system = int(ctx.system);
    const tools = int(ctx.tools);
    const messages = int(ctx.messages);
    const total = Math.max(1, system + tools + messages);
    const percent = ctx.percent.toFixed(1).replace(/\.0$/, "");
    const segment = (count, color) => count > 0 ? `<span class="ag-ctx-seg" style="width:${(count / total) * 100}%;background:${color}"></span>` : "";
    return panelHead(text("上下文已用", "Context used"), "", "") +
      `<div class="ag-pop-hero"><strong>${percent}%</strong><span>${fmtInt(ctx.used)} / ${compact(ctx.max)}</span></div>` +
      `<div class="ag-ctx-track">${segment(system, CONTEXT_COLORS.system)}${segment(tools, CONTEXT_COLORS.tools)}${segment(messages, CONTEXT_COLORS.messages)}</div>` +
      `<div class="ag-legend"><span class="ag-legend-name"><i style="background:${CONTEXT_COLORS.system}"></i>${text("系统提示词", "System prompt")}</span><strong>${fmtInt(system)}</strong></div>` +
      `<div class="ag-legend"><span class="ag-legend-name"><i style="background:${CONTEXT_COLORS.tools}"></i>${text("工具定义", "Tool definitions")}</span><strong>${fmtInt(tools)}</strong></div>` +
      `<div class="ag-legend"><span class="ag-legend-name"><i style="background:${CONTEXT_COLORS.messages}"></i>${text("对话消息", "Chat messages")}</span><strong>${fmtInt(messages)}</strong></div>`;
  }

  function positionPopover() {
    const pop = document.getElementById(POP_ID);
    const anchor = state.popoverAnchor;
    if (!pop || !anchor || !anchor.isConnected) {
      if (pop) hidePanel(true);
      return;
    }
    pop.style.left = "0px";
    pop.style.top = "0px";
    const rect = anchor.getBoundingClientRect();
    const width = pop.offsetWidth || 292;
    const height = pop.offsetHeight || 220;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2));
    const top = Math.max(8, rect.top - height - 9);
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }

  async function copyPanel(panel, view) {
    let textValue = "";
    if (panel === "stats") {
      textValue = [text("会话统计", "Session stats"), text("模型用时", "Model time") + ": " + duration(view.modelMs), text("工具调用用时", "Tool time") + ": " + duration(view.toolMs), text("首 token 平均 (TTFT)", "Avg TTFT") + ": " + (view.ttft ? shortDuration(view.ttft * 1000) : "—"), text("输出速度 (TPS)", "TPS") + ": " + (view.tps ? Math.round(view.tps) : "—") + " tok/s"].join("\n");
    } else if (panel === "tokens") {
      textValue = [text("Token 用量", "Token usage"), "Total: " + fmtInt(view.tokens.total), text("缓存命中", "Cache hit") + ": " + view.cacheHit.toFixed(1) + "%", text("未缓存输入", "Uncached input") + ": " + fmtInt(view.tokens.input), text("缓存读取", "Cache read") + ": " + fmtInt(view.tokens.cacheRead), text("输出", "Output") + ": " + fmtInt(view.tokens.output)].join("\n");
    } else if (panel === "context" && view.context) {
      textValue = [text("上下文已用", "Context used") + ": " + view.context.percent.toFixed(1) + "%", text("已用", "Used") + ": " + fmtInt(view.context.used) + " / " + fmtInt(view.context.max), text("系统提示词", "System") + ": " + fmtInt(view.context.system), text("工具定义", "Tools") + ": " + fmtInt(view.context.tools), text("对话消息", "Messages") + ": " + fmtInt(view.context.messages)].join("\n");
    }
    try {
      await navigator.clipboard.writeText(textValue);
      toast(text("统计摘要已复制", "Summary copied"));
    } catch (error) {
      toast(text("复制失败", "Copy failed"));
    }
  }

  function renderTaskBar(view) {
    const enabled = cfg().taskProgressBar !== false;
    const tasks = view?.tasks || EMPTY_TASKS;
    if (!enabled || !tasks.exists) {
      removeNode(TASK_ID);
      state.taskExpanded = false;
      return;
    }
    const bar = ensureTaskBar();
    if (!bar) return;
    bar.classList.remove("is-hidden");
    bar.classList.toggle("is-open", state.taskExpanded);
    const items = (tasks.items || []).map((item) => {
      const mark = item.state === "done" ? "✓" : item.state === "doing" ? "●" : "○";
      return `<div class="ag-task-item" data-state="${esc(item.state)}"><span class="ag-task-mark">${mark}</span><span>${esc(item.text)}</span></div>`;
    }).join("");
    bar.innerHTML = `<button type="button" class="ag-task-summary"><span class="ag-task-ico">☷</span><span>${text("任务", "Tasks")} <strong>${tasks.doing || 0}</strong> ${text("进行中", "in progress")} · <strong>${tasks.todo || 0}</strong> ${text("待处理", "pending")}</span><span class="ag-task-expand">⌃</span></button>` +
      `<div class="ag-task-list">${items || `<div class="ag-task-item">${text("暂无任务条目", "No task items")}</div>`}</div>`;
    bar.querySelector(".ag-task-summary")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.taskExpanded = !state.taskExpanded;
      bar.classList.toggle("is-open", state.taskExpanded);
    });
  }

  function renderGoal() {
    const goal = ensureGoal();
    if (!goal) return;
    goal.classList.toggle("is-hidden", cfg().quickGoalPill !== true || !state.cascadeId);
    goal.textContent = "◎ " + text("启动目标", "Start goal");
    goal.title = text("向输入框写入 /goal", "Insert /goal into the composer");
  }

  function renderClock() {
    if (cfg().ambientClock !== true || !state.cascadeId) {
      removeNode(CLOCK_ID);
      return;
    }
    const clock = ensureClock();
    const view = document.querySelector('[data-testid="conversation-view"]');
    if (!view) {
      clock.style.display = "none";
      return;
    }
    const rect = view.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 120) {
      clock.style.display = "none";
      return;
    }
    clock.style.display = "block";
    clock.style.left = (rect.left + rect.width / 2) + "px";
    clock.style.top = (rect.top + rect.height * 0.44) + "px";
    clock.style.transform = "translate(-50%, -50%)";
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const date = now.getFullYear() + "." + String(now.getMonth() + 1).padStart(2, "0") + "." + String(now.getDate()).padStart(2, "0");
    const timeNode = clock.querySelector(".ag-clock-time");
    const dateNode = clock.querySelector(".ag-clock-date");
    if (timeNode) timeNode.textContent = hh + ":" + mm;
    if (dateNode) dateNode.textContent = date;
  }

  function teardown() {
    removeNode(BAR_ID);
    removeNode(TASK_ID);
    removeNode(GOAL_ID);
    removeNode(CLOCK_ID);
    hidePanel(true);
  }

  function renderAll() {
    const view = buildView(state.session);
    if (!state.cascadeId) {
      teardown();
      return;
    }
    if (!view) {
      renderBar(null);
      return;
    }
    if (cfg().telemetryBar === false) {
      removeNode(BAR_ID);
      hidePanel(true);
    } else {
      renderBar(view);
    }
    renderTaskBar(view);
    renderGoal();
    renderClock();
    if (state.popoverPanel) renderPopover(view);
  }

  function isRunning() {
    return !!document.querySelector('[aria-label="Stop execution"], [aria-label*="Stop"], [data-testid="status-task-running"]');
  }

  function tick() {
    const id = currentId();
    if (!id) {
      if (state.cascadeId) {
        state.cascadeId = "";
        state.session = null;
        teardown();
      }
      return;
    }
    if (id !== state.cascadeId) {
      state.cascadeId = id;
      state.session = ensureSession(id);
      state.taskExpanded = false;
      hidePanel(true);
      if (!state.session.metaLoaded && !state.session.stepsLoaded) {
        state.session.lastFetch = 0;
      }
      renderAll();
      sync(true);
    } else {
      const barMissing = cfg().telemetryBar !== false && !document.getElementById(BAR_ID);
      const goalMissing = cfg().quickGoalPill === true && !document.getElementById(GOAL_ID);
      const needsTask = state.session?.tasks?.exists && cfg().taskProgressBar !== false && !document.getElementById(TASK_ID);
      if (barMissing || goalMissing || needsTask) renderAll();
      renderClock();
    }
    if (!document.hidden && state.session && Date.now() - state.session.lastFetch > (isRunning() ? 1800 : 7000)) sync(false);
  }

  function bind() {
    ensureStyle();
    state.timer = setInterval(tick, 1000);
    state.clockTimer = setInterval(() => { if (!document.hidden) renderClock(); }, 20000);
    window.addEventListener("resize", () => { positionPopover(); renderClock(); }, { passive: true });
    window.addEventListener("popstate", () => { state.lastPath = location.pathname; tick(); });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        tick();
        if (state.session) sync(true);
      }
    });
    document.addEventListener("ag-config-updated", (event) => {
      const patch = event.detail || {};
      if (["telemetryBar", "telemetryShowCost", "taskProgressBar", "quickGoalPill", "ambientClock", "language"].some((key) => Object.prototype.hasOwnProperty.call(patch, key))) {
        renderAll();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.popoverPanel) hidePanel(true);
    }, true);
    document.addEventListener("pointerdown", (event) => {
      const pop = document.getElementById(POP_ID);
      if (!pop || !state.popoverPinned) return;
      if (pop.contains(event.target) || event.target.closest(`#${BAR_ID} [data-tele-panel]`)) return;
      hidePanel(true);
    }, true);
    document.addEventListener("click", (event) => {
      const button = event.target.closest?.("button, [role=button]");
      if (!button) return;
      const label = [button.getAttribute("aria-label"), button.getAttribute("title"), button.textContent].filter(Boolean).join(" ");
      if (/stop|cancel|abort|send|submit/i.test(label) && (button.closest(".surface-composer, [data-testid=composer], form") || /send|stop/i.test(label))) {
        setTimeout(() => { if (state.cascadeId) sync(true); }, 350);
      }
    }, true);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.target.closest?.('[contenteditable="true"], textarea')) setTimeout(() => { if (state.cascadeId) sync(true); }, 450);
    }, true);
    tick();
  }

  if (document.body) bind();
  else document.addEventListener("DOMContentLoaded", bind, { once: true });

  function dispose() {
    clearInterval(state.timer);
    clearInterval(state.clockTimer);
    teardown();
    removeNode(STYLE_ID);
    removeNode(TOAST_ID);
  }

  window.__agTelemetryDispose = dispose;
  window.__agTelemetry = {
    version: VERSION,
    refresh: () => sync(true),
    state: () => ({ cascadeId: state.cascadeId, filter: "", view: buildView(state.session), sidecar: state.session?.sidecar || null, metaError: state.session?.metaError || "", stepError: state.session?.stepError || "" }),
    previewTasks: (tasks) => {
      if (!state.session) return false;
      state.session.previewTasks = Object.assign({}, EMPTY_TASKS, tasks || {});
      renderAll();
      return true;
    },
    clearPreviewTasks: () => {
      if (!state.session) return false;
      state.session.previewTasks = null;
      renderAll();
      return true;
    },
    openPanel: (panel) => {
      const pill = document.querySelector(`#${BAR_ID} [data-tele-panel="${panel}"]`);
      if (pill) showPanel(panel, pill, true);
    },
    closePanel: () => hidePanel(true),
  };
})();
