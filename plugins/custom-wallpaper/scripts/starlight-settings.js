/**
 * starlight-settings.js
 * v4.0 「✦ 星夜美化」设置页：Alt+S / 顶栏星键呼出悬浮玻璃窗，
 * 也可从原生设置弹窗的导航入口打开。所有修改实时写回 /api/config 并热应用。
 */
(function () {
  if (window.__agStarlightInstalled) return;
  window.__agStarlightInstalled = true;

  const VERSION = "1.1.1";
  const SIDECAR = "http://127.0.0.1:" + (window.__AG_SIDECAR_PORT || 39290);
  const STYLE_ID = "ag-starlight-style";
  const WINDOW_ID = "ag-starlight-window";
  const EMBEDDED_ID = "ag-starlight-settings-embedded";
  const LAUNCH_ID = "ag-starlight-launch";
  const DEFAULTS = {
    language: "zh-CN",
    deepI18n: true,
    translateAlerts: true,
    runningRadar: true,
    hideRadarWhenIdle: false,
    quickCopyButton: true,
    cursorParticles: true,
    questChime: false,
    telemetryBar: true,
    telemetryShowCost: true,
    taskProgressBar: true,
    quickGoalPill: false,
    ambientClock: false,
    promptSticky: false,
    opacity: 0.72,
    darkTint: 0.42,
    blur: 24,
    focusX: 50,
    focusY: 26,
    fontPreset: "editorial-luxe",
    fontScale: 1,
    starEffectMode: "orbit-meteor",
    starIntensity: 0.85,
    meteorFrequency: 0.6,
  };
  const FONTS = [
    { id: "editorial-luxe", zh: "星刊雅宋", en: "Editorial Luxe" },
    { id: "modern-silk", zh: "现代几何", en: "Modern Silk" },
    { id: "literary-serif", zh: "人文书卷", en: "Literary Serif" },
    { id: "starry-game", zh: "星夜萌圆", en: "Starry Game" },
  ];
  const STAR_MODES = [
    { id: "orbit-meteor", zh: "星环全开", en: "Orbit + Meteors" },
    { id: "meteor-stars", zh: "流星微星", en: "Meteors" },
    { id: "minimal", zh: "极简静谧", en: "Minimal" },
    { id: "off", zh: "关闭特效", en: "Off" },
  ];

  const state = {
    cfg: Object.assign({}, DEFAULTS, window.__AG_CONFIG || {}),
    tab: "language",
    open: false,
    embeddedOpen: false,
    loading: false,
    minimized: false,
    initialized: false,
    saveTimer: 0,
    toastTimer: 0,
    legacy: null,
    update: null,
    updateLoading: false,
  };
  let win = null;
  let drag = null;

  const isEn = () => String(state.cfg.language || "zh-CN").toLowerCase() === "en";
  const L = (zh, en) => (isEn() ? en : zh);
  const esc = (value) => String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${LAUNCH_ID}{display:inline-flex!important;align-items:center!important;justify-content:center!important;width:26px!important;height:26px!important;margin-right:4px!important;
        border:1px solid rgba(246,216,147,.18)!important;border-radius:7px!important;background:rgba(246,216,147,.06)!important;color:#f6d893!important;
        cursor:pointer!important;font-size:14px!important;line-height:1!important;transition:background-color .15s,border-color .15s!important;vertical-align:middle!important}
      #${LAUNCH_ID}:hover{background:rgba(246,216,147,.14)!important;border-color:rgba(246,216,147,.4)!important}
      #${LAUNCH_ID}.has-update{position:relative!important}
      #${LAUNCH_ID}.has-update::after{content:""!important;position:absolute!important;right:-2px!important;top:-2px!important;width:7px!important;height:7px!important;border-radius:50%!important;background:#f6d893!important;box-shadow:0 0 8px rgba(246,216,147,.9)!important;border:1px solid #151020!important}
      #${WINDOW_ID}{position:fixed;right:24px;top:84px;z-index:9500;width:392px;max-width:calc(100vw - 32px);max-height:calc(100vh - 110px);display:none;
        color:#dce6f2;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;filter:drop-shadow(0 20px 50px rgba(0,0,0,.45));
        --st-gold:#f6d893;--st-lav:#c4b5fd;--st-cyan:#7dd3fc;--st-bg:rgba(12,14,26,.96)}
      #${WINDOW_ID}.is-open{display:flex}
      .ag-starlight-shell{width:100%;min-height:0;display:flex;flex-direction:column;border:1px solid rgba(196,181,253,.18);border-radius:16px;overflow:hidden;
        background:radial-gradient(120% 80% at 100% 0%,rgba(139,92,246,.14),transparent 55%),radial-gradient(90% 70% at 0% 100%,rgba(246,216,147,.06),transparent 60%),var(--st-bg);
        backdrop-filter:blur(24px) saturate(1.2);box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}
      .ag-starlight-head{display:flex;align-items:center;gap:9px;padding:13px 14px 11px;cursor:grab;user-select:none;border-bottom:1px solid rgba(255,255,255,.06)}
      .ag-starlight-head.dragging{cursor:grabbing}
      .ag-starlight-spark{width:26px;height:26px;display:grid;place-items:center;border-radius:8px;border:1px solid rgba(246,216,147,.24);background:rgba(246,216,147,.08);color:var(--st-gold);font-size:15px;box-shadow:0 0 16px -8px rgba(246,216,147,.8)}
      .ag-starlight-titlebox{flex:1;min-width:0}
      .ag-starlight-kicker{font-size:8.5px;letter-spacing:.16em;color:var(--st-gold);opacity:.75;font-weight:600}
      .ag-starlight-title{margin:2px 0 0;font-size:15px;line-height:1.2;font-weight:600;color:#f3f7ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .ag-starlight-chip{padding:1px 6px;border-radius:999px;border:1px solid rgba(196,181,253,.18);background:rgba(196,181,253,.08);color:#c4b5fd;font-size:9px;line-height:15px}
      .ag-starlight-iconbtn{width:24px;height:24px;display:grid;place-items:center;border:1px solid transparent;border-radius:6px;background:transparent;color:#8fa2b8;cursor:pointer;font-size:13px;line-height:1}
      .ag-starlight-iconbtn:hover{background:rgba(255,255,255,.06);color:#f2f5fb;border-color:rgba(255,255,255,.08)}
      .ag-starlight-tabs{display:flex;gap:2px;padding:8px 10px 0;border-bottom:1px solid rgba(255,255,255,.055);overflow-x:auto;scrollbar-width:none}
      .ag-starlight-tab{flex:0 0 auto;display:flex;align-items:center;gap:4px;height:28px;padding:0 9px;border:1px solid transparent;border-bottom:0;border-radius:8px 8px 0 0;
        background:transparent;color:#8fa2b8;font:500 10.5px/1 inherit;cursor:pointer;white-space:nowrap}
      .ag-starlight-tab:hover{color:#dce6f2;background:rgba(255,255,255,.035)}
      .ag-starlight-tab.is-active{color:#f6e8c8;background:linear-gradient(180deg,rgba(246,216,147,.11),rgba(246,216,147,.025));border-color:rgba(246,216,147,.16);box-shadow:inset 0 1px 0 rgba(246,216,147,.20)}
      .ag-starlight-body{padding:12px 14px;overflow-y:auto;min-height:0;scrollbar-width:thin}
      .ag-starlight-section{display:flex;flex-direction:column;gap:10px}
      .ag-starlight-row{display:flex;align-items:center;gap:10px;min-height:30px}
      .ag-starlight-rowlabel{flex:0 0 104px;font-size:11px;color:#aab8ca;line-height:1.35}
      .ag-starlight-rowmain{flex:1;min-width:0;display:flex;align-items:center;gap:8px}
      .ag-starlight-hint{font-size:9.5px;color:#6f8198;line-height:1.45;margin-top:2px}
      .ag-starlight-seg{display:flex;min-width:140px;padding:2px;border:1px solid rgba(255,255,255,.08);border-radius:8px;background:rgba(8,11,21,.45)}
      .ag-starlight-seg button{flex:1;min-width:62px;height:24px;padding:0 6px;border:0;border-radius:6px;background:transparent;color:#8fa2b8;font:500 10px/1 inherit;cursor:pointer;white-space:nowrap}
      .ag-starlight-seg button.is-active{background:rgba(246,216,147,.13);color:#f7e7c3;box-shadow:inset 0 0 0 1px rgba(246,216,147,.18)}
      .ag-starlight-switch{position:relative;width:34px;height:19px;flex:0 0 34px;border:0;border-radius:999px;background:rgba(255,255,255,.10);cursor:pointer;transition:background-color .16s}
      .ag-starlight-switch::after{content:"";position:absolute;left:2px;top:2px;width:15px;height:15px;border-radius:50%;background:#8fa2b8;transition:transform .16s,background-color .16s}
      .ag-starlight-switch.is-on{background:rgba(246,216,147,.32)}
      .ag-starlight-switch.is-on::after{transform:translateX(15px);background:#f6d893;box-shadow:0 0 8px rgba(246,216,147,.55)}
      .ag-starlight-slider{flex:1;min-width:0;display:flex;align-items:center;gap:8px}
      .ag-starlight-slider input{flex:1;min-width:0;appearance:none;-webkit-appearance:none;height:3px;border-radius:2px;background:linear-gradient(90deg,rgba(246,216,147,.65),rgba(196,181,253,.5));outline:none;cursor:pointer}
      .ag-starlight-slider input::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;border-radius:50%;background:#f6d893;border:2px solid #0d0a1c;box-shadow:0 0 7px rgba(246,216,147,.55);cursor:pointer}
      .ag-starlight-value{flex:0 0 40px;text-align:right;font:10px/1 ui-monospace,Consolas,monospace;color:#d9e4f1}
      .ag-starlight-cards{display:grid;grid-template-columns:1fr 1fr;gap:6px}
      .ag-starlight-card{display:flex;flex-direction:column;gap:2px;padding:8px;border:1px solid rgba(255,255,255,.075);border-radius:9px;background:rgba(255,255,255,.025);color:#b9c8da;cursor:pointer;text-align:left;font:inherit}
      .ag-starlight-card:hover{border-color:rgba(246,216,147,.22);background:rgba(246,216,147,.055)}
      .ag-starlight-card.is-active{border-color:rgba(246,216,147,.34);background:linear-gradient(135deg,rgba(246,216,147,.12),rgba(196,181,253,.07));color:#f4ecd9;box-shadow:inset 0 0 0 1px rgba(246,216,147,.10)}
      .ag-starlight-card strong{font-size:10.5px;font-weight:600}
      .ag-starlight-card span{font-size:9px;color:#7f93ab;line-height:1.35}
      .ag-starlight-card.is-active span{color:#bda9d9}
      .ag-starlight-wallpaper{position:relative;height:94px;border:1px solid rgba(255,255,255,.08);border-radius:10px;overflow:hidden;background:#0a0d18 center/cover no-repeat}
      .ag-starlight-wallpaper::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.02),rgba(0,0,0,.28))}
      .ag-starlight-focus{position:absolute;left:var(--fx,50%);top:var(--fy,26%);width:18px;height:18px;margin:-9px 0 0 -9px;border:1px solid rgba(246,216,147,.85);border-radius:50%;box-shadow:0 0 0 3px rgba(246,216,147,.13),0 0 10px rgba(246,216,147,.35);cursor:crosshair;z-index:2}
      .ag-starlight-focus::before,.ag-starlight-focus::after{content:"";position:absolute;background:rgba(246,216,147,.8)}
      .ag-starlight-focus::before{left:50%;top:-5px;width:1px;height:5px}.ag-starlight-focus::after{top:50%;left:-5px;height:1px;width:5px}
      .ag-starlight-wallnote{position:absolute;right:7px;bottom:6px;z-index:3;padding:2px 6px;border-radius:999px;background:rgba(9,12,22,.78);border:1px solid rgba(255,255,255,.09);color:#9fb0c4;font-size:8.5px}
      .ag-starlight-actions{display:flex;gap:6px;margin-top:2px}
      .ag-starlight-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:26px;padding:0 9px;border:1px solid rgba(255,255,255,.09);border-radius:7px;background:rgba(255,255,255,.035);color:#b9c8da;font:500 10.5px/1 inherit;cursor:pointer}
      .ag-starlight-btn:hover{border-color:rgba(196,181,253,.24);background:rgba(196,181,253,.08);color:#f1f5fb}
      .ag-starlight-btn.primary{border-color:rgba(246,216,147,.28);background:rgba(246,216,147,.10);color:#f6e7c3}
      .ag-starlight-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 14px;border-top:1px solid rgba(255,255,255,.055);color:#71839a;font-size:9.5px}
      .ag-starlight-foot strong{color:#9fb0c4;font-weight:500}
      .ag-starlight-legacy{display:flex;align-items:center;gap:8px;padding:8px;border:1px solid rgba(255,255,255,.07);border-radius:9px;background:rgba(255,255,255,.02);font-size:10px;color:#aab8ca}
      .ag-starlight-legacy .dot{width:6px;height:6px;border-radius:50%;background:#86e0c0;box-shadow:0 0 7px rgba(134,224,192,.6)}
      .ag-starlight-legacy.is-warn .dot{background:#f6d893;box-shadow:0 0 7px rgba(246,216,147,.6)}
      #${WINDOW_ID}.is-minimized{width:220px}
      #${WINDOW_ID}.is-minimized .ag-starlight-tabs,#${WINDOW_ID}.is-minimized .ag-starlight-body,#${WINDOW_ID}.is-minimized .ag-starlight-foot{display:none}
      .ag-starlight-toast{position:fixed;left:50%;bottom:26px;transform:translate(-50%,8px);z-index:10002;padding:7px 12px;border:1px solid rgba(196,181,253,.2);border-radius:999px;background:rgba(12,14,26,.95);color:#e9eef8;font:500 11px/1.4 inherit;opacity:0;pointer-events:none;transition:opacity .16s,transform .16s}
      .ag-starlight-toast.is-visible{opacity:1;transform:translate(-50%,0)}
      .ag-starlight-navitem{display:flex!important;align-items:center!important;gap:7px!important;width:100%!important;padding:7px 9px!important;border:0!important;border-radius:7px!important;background:transparent!important;color:inherit!important;font:inherit!important;cursor:pointer!important;text-align:left!important}
      .ag-starlight-navitem:hover{background:rgba(255,255,255,.05)!important}
      .ag-starlight-navitem.is-active{background:linear-gradient(90deg,rgba(246,216,147,.14),rgba(196,181,253,.08))!important;box-shadow:inset 0 0 0 1px rgba(246,216,147,.20)!important;color:#f7e7c3!important}
      .ag-starlight-navitem .badge{margin-left:auto;padding:1px 5px;border-radius:999px;background:rgba(246,216,147,.10);border:1px solid rgba(246,216,147,.2);color:#f6d893;font-size:8px}
      .settings-modal-container.ag-starlight-embedded-open [data-testid^="settings-nav-item-"].bg-sidebar-secondary{background:transparent!important;color:#95a6bd!important;box-shadow:none!important;border-color:transparent!important}
      .settings-modal-container.ag-starlight-embedded-open [data-testid^="settings-nav-item-"]:hover{background:rgba(255,255,255,.05)!important}
      .ag-starlight-content-host{position:relative!important}
      .ag-starlight-content-host > :not(#ag-starlight-settings-embedded){display:none!important}
      .ag-starlight-embedded{position:absolute;inset:0;z-index:30;display:flex;min-height:0;overflow:hidden;
        background:radial-gradient(120% 80% at 100% 0%,rgba(139,92,246,.10),transparent 55%),radial-gradient(100% 70% at 0% 100%,rgba(246,216,147,.05),transparent 60%),linear-gradient(180deg,rgba(15,17,30,.55),rgba(9,11,21,.35))}
      .ag-starlight-embedded .ag-starlight-shell{width:100%;height:100%;border:0;border-radius:0;box-shadow:none;background:transparent;backdrop-filter:none}
      .ag-starlight-embedded .ag-starlight-head{cursor:default;padding:20px 28px 12px;border-bottom:0}
      .ag-starlight-embedded .ag-starlight-spark{width:32px;height:32px;border-radius:10px;font-size:18px}
      .ag-starlight-embedded .ag-starlight-kicker{font-size:9px}
      .ag-starlight-embedded .ag-starlight-title{font-size:20px;margin-top:3px}
      .ag-starlight-embedded .ag-starlight-tabs{padding:4px 24px 0;gap:3px}
      .ag-starlight-embedded .ag-starlight-tab{height:32px;padding:0 12px;font-size:11.5px}
      .ag-starlight-embedded .ag-starlight-body{flex:1 1 auto;min-height:0;padding:18px 28px 30px;overflow-y:auto}
      .ag-starlight-embedded .ag-starlight-section{width:100%;max-width:800px;margin:0 auto;gap:14px}
      .ag-starlight-embedded .ag-starlight-row{min-height:38px}
      .ag-starlight-embedded .ag-starlight-rowlabel{flex-basis:156px;font-size:12px;color:#b8c6d8}
      .ag-starlight-embedded .ag-starlight-hint{font-size:10px}
      .ag-starlight-embedded .ag-starlight-seg{min-width:168px}
      .ag-starlight-embedded .ag-starlight-seg button{height:27px;font-size:11px}
      .ag-starlight-embedded .ag-starlight-cards{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
      .ag-starlight-embedded .ag-starlight-card{padding:10px 12px}
      .ag-starlight-embedded .ag-starlight-card strong{font-size:11.5px}
      .ag-starlight-embedded .ag-starlight-card span{font-size:9.5px}
      .ag-starlight-embedded .ag-starlight-wallpaper{height:150px}
      .ag-starlight-embedded .ag-starlight-btn{height:29px;font-size:11px}
      .ag-starlight-embedded .ag-starlight-foot{padding:11px 28px;background:rgba(9,11,20,.28)}
      @media (max-width:1100px){.ag-starlight-embedded .ag-starlight-cards{grid-template-columns:1fr}}
      @media (prefers-reduced-motion:reduce){#${WINDOW_ID},.ag-starlight-switch,.ag-starlight-switch::after{transition:none!important}}
    `;
    document.head.appendChild(style);
  }

  function toast(message) {
    ensureStyle();
    let node = document.querySelector(".ag-starlight-toast");
    if (!node) {
      node = document.createElement("div");
      node.className = "ag-starlight-toast";
      document.body.appendChild(node);
    }
    node.textContent = message;
    node.classList.add("is-visible");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => node.classList.remove("is-visible"), 1700);
  }

  async function api(path, options) {
    const response = await fetch(SIDECAR + path, Object.assign({ cache: "no-store" }, options || {}));
    if (!response.ok) throw new Error("HTTP " + response.status);
    return response.json();
  }

  async function loadConfig() {
    state.loading = true;
    setStatus(L("正在读取配置…", "Loading config…"), "busy");
    try {
      const data = await api("/api/config");
      state.cfg = Object.assign({}, DEFAULTS, window.__AG_CONFIG || {}, data || {});
      setStatus(L("配置已同步", "Config synced"), "ok");
    } catch (error) {
      state.cfg = Object.assign({}, DEFAULTS, window.__AG_CONFIG || {});
      setStatus(L("侧车未连接，使用当前页面配置", "Sidecar offline; using page config"), "warn");
    } finally {
      state.loading = false;
      state.initialized = true;
      render();
    }
  }

  function setStatus(message, kind) {
    state.status = { message, kind };
    document.querySelectorAll("[data-starlight-status]").forEach((node) => {
      node.textContent = message;
      node.dataset.kind = kind || "";
    });
  }

  function persist(patch) {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(async () => {
      try {
        const data = await api("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (data?.config) state.cfg = Object.assign({}, state.cfg, data.config);
        setStatus(L("已保存并实时生效", "Saved and applied"), "ok");
      } catch (error) {
        setStatus(L("保存失败：", "Save failed: ") + error.message, "error");
      }
    }, 180);
  }

  function patchConfig(patch, persistNow) {
    state.cfg = Object.assign({}, state.cfg, patch);
    try { window.__agApplyConfig?.(patch); } catch (error) {}
    if (persistNow !== false) persist(patch);
    render();
  }

  function toggle(key) {
    patchConfig({ [key]: !state.cfg[key] });
  }

  function row(label, control, hint) {
    return `<div class="ag-starlight-row"><div class="ag-starlight-rowlabel">${label}${hint ? `<div class="ag-starlight-hint">${hint}</div>` : ""}</div><div class="ag-starlight-rowmain">${control}</div></div>`;
  }

  function switchHtml(key) {
    return `<button type="button" class="ag-starlight-switch${state.cfg[key] ? " is-on" : ""}" data-starlight-toggle="${key}" aria-pressed="${state.cfg[key] ? "true" : "false"}"></button>`;
  }

  function sliderHtml(key, min, max, step, format) {
    const value = Number(state.cfg[key]);
    return `<div class="ag-starlight-slider"><input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-starlight-slider="${key}"><span class="ag-starlight-value" data-starlight-val="${key}">${format ? format(value) : value}</span></div>`;
  }

  async function loadUpdate({ check = false, silent = true } = {}) {
    if (state.updateLoading) return;
    state.updateLoading = true;
    if (state.tab === "update" && (state.open || state.embeddedOpen)) render();
    try {
      const data = check
        ? await api("/api/update/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
        : await api("/api/update/status");
      state.update = data;
      if (data?.available && !silent) {
        toast(L(`发现新版本 v${data.latest}，可在「更新」页升级`, `v${data.latest} is available in Update`));
      }
    } catch (error) {
      state.update = { ok: false, error: error?.message || String(error) };
    } finally {
      state.updateLoading = false;
      syncLauncherUpdateBadge();
      if (state.tab === "update" && (state.open || state.embeddedOpen)) render();
    }
  }

  async function applyUpdate() {
    if (state.updateLoading) return;
    state.updateLoading = true;
    setStatus(L("正在下载并校验更新…", "Downloading and verifying update…"), "busy");
    if (state.open || state.embeddedOpen) render();
    try {
      const data = await api("/api/update/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      state.update = {
        ...(state.update || {}),
        ...data,
        latest: data?.to || data?.latest || state.update?.latest || "",
        current: data?.to || data?.current || state.update?.current || VERSION,
        available: Boolean(data?.available),
        configured: true,
      };
      if (data?.updated) {
        toast(L(`已更新到 v${data.to}，重启 Antigravity 生效`, `Updated to v${data.to}; restart Antigravity`));
        setStatus(L("更新完成，重启 Antigravity 生效", "Update complete; restart Antigravity"), "ok");
      } else {
        toast(data?.message || L("已是最新版本", "Already up to date"));
        setStatus(data?.message || L("已是最新版本", "Already up to date"), "ok");
      }
    } catch (error) {
      state.update = { ...(state.update || {}), ok: false, error: error?.message || String(error) };
      toast(L("更新失败：", "Update failed: ") + (error?.message || error), true);
    } finally {
      state.updateLoading = false;
      syncLauncherUpdateBadge();
      if (state.tab === "update" && (state.open || state.embeddedOpen)) render();
    }
  }

  function sectionUpdate() {
    const u = state.update || {};
    const latest = u.latest ? String(u.latest) : "";
    const statusText = state.updateLoading
      ? L("正在检查…", "Checking…")
      : u.error
        ? u.error
        : u.configured === false
          ? L("未配置更新源，请先在 config/update.json 填写 GitHub 仓库", "Configure a GitHub repo in config/update.json")
          : u.latest
            ? (u.available ? L(`发现新版本 v${latest}`, `v${latest} is available`) : L("已是最新版本", "Already up to date"))
            : L("尚未检查", "Not checked yet");
    return `<div class="ag-starlight-section">
      ${row(L("当前版本", "Current"), `<strong>v${esc(VERSION)}</strong>`)}
      ${row(L("最新版本", "Latest"), `<strong>${latest ? "v" + esc(latest) : "—"}</strong>`)}
      ${row(L("更新源", "Update source"), `<span class="ag-starlight-hint" style="margin:0">${u.configured === false ? L("未配置", "Not configured") : L("GitHub Releases", "GitHub Releases")}</span>`)}
      ${row(L("状态", "Status"), `<span class="ag-starlight-hint" style="margin:0">${esc(statusText)}</span>`)}
      <div class="ag-starlight-actions">
        <button type="button" class="ag-starlight-btn" data-starlight-update-check ${state.updateLoading ? "disabled" : ""}>${L("检查更新", "Check for updates")}</button>
        <button type="button" class="ag-starlight-btn primary" data-starlight-update-apply ${u.available && !state.updateLoading ? "" : "hidden"}>${L("立即更新", "Update now")}</button>
      </div>
      ${u.notes ? `<div class="ag-starlight-hint">${esc(String(u.notes).slice(0, 800))}</div>` : ""}
      <div class="ag-starlight-hint">${L("更新包会校验 SHA-256，更新前自动备份；壁纸、提示词和本地配置会保留。更新完成后重启 Antigravity。", "The package is SHA-256 verified and backed up first. Wallpaper, prompts and local config are preserved. Restart Antigravity after updating.")}</div>
    </div>`;
  }

  function sectionLanguage() {
    return `<div class="ag-starlight-section">
      ${row(L("界面语言", "Language"), `<div class="ag-starlight-seg" data-starlight-lang><button data-lang="zh-CN" class="${isEn() ? "" : "is-active"}">简体中文</button><button data-lang="en" class="${isEn() ? "is-active" : ""}">English</button></div>`)}
      ${row(L("深度汉化", "Deep i18n"), switchHtml("deepI18n"), L("仅翻译可见 UI，不动对话/代码", "Visible UI only; never chat/code"))}
      ${row(L("提示框标题", "Alert labels"), switchHtml("translateAlerts"), L("NOTE / TIP / IMPORTANT / WARNING / CAUTION", "Translate only the five alert titles"))}
      <div class="ag-starlight-legacy" data-starlight-legacy><span class="dot"></span><span>${L("外部汉化插件：检查中…", "Legacy Chinese plugin: checking…")}</span></div>
      <div class="ag-starlight-actions"><button type="button" class="ag-starlight-btn" data-starlight-legacy-check>${L("重新检查", "Recheck")}</button><button type="button" class="ag-starlight-btn" data-starlight-legacy-retire hidden>${L("停用并归档旧插件", "Retire legacy plugin")}</button></div>
    </div>`;
  }

  function sectionWallpaper() {
    const bg = `background-image:url('${SIDECAR}/wallpaper?t=${Date.now()}')`;
    return `<div class="ag-starlight-section">
      <div class="ag-starlight-wallpaper" data-starlight-wallpaper style="${bg}">
        <span class="ag-starlight-focus" style="--fx:${Number(state.cfg.focusX) || 50}%;--fy:${Number(state.cfg.focusY) || 26}%"></span>
        <span class="ag-starlight-wallnote">${L("拖动准星调整焦点", "Drag to set focus")}</span>
      </div>
      <div class="ag-starlight-actions">
        <button type="button" class="ag-starlight-btn primary" data-starlight-wall-upload>${L("上传新壁纸", "Upload wallpaper")}</button>
        <button type="button" class="ag-starlight-btn" data-starlight-wall-reset>${L("还原默认", "Reset")}</button>
      </div>
      ${row(L("壁纸显隐", "Wallpaper"), sliderHtml("opacity", 0, 1, 0.01, (v) => Math.round(v * 100) + "%"))}
      ${row(L("暗色遮罩", "Dark tint"), sliderHtml("darkTint", 0, 0.9, 0.01, (v) => Math.round(v * 100) + "%"))}
      ${row(L("毛玻璃模糊", "Glass blur"), sliderHtml("blur", 0, 40, 1, (v) => Math.round(v) + "px"))}
      ${row(L("背景时钟水印", "Ambient clock"), switchHtml("ambientClock"), L("对话区中央显示半透明时间日期", "Show a faint time and date watermark behind the chat"))}
    </div>`;
  }

  function sectionStars() {
    const cards = STAR_MODES.map((mode) => `<button type="button" class="ag-starlight-card${state.cfg.starEffectMode === mode.id ? " is-active" : ""}" data-starlight-star="${mode.id}"><strong>${isEn() ? mode.en : mode.zh}</strong><span>${mode.id === "orbit-meteor" ? L("3D 环绕 + 流星", "3D orbit + meteors") : mode.id === "meteor-stars" ? L("流星 + 微星尘", "Meteors + dust") : mode.id === "minimal" ? L("静态呼吸星尘", "Static stardust") : L("完全不渲染", "No effects")}</span></button>`).join("");
    return `<div class="ag-starlight-section">
      <div class="ag-starlight-cards">${cards}</div>
      ${row(L("星光亮度", "Star brightness"), sliderHtml("starIntensity", 0, 1, 0.01, (v) => Math.round(v * 100) + "%"))}
      ${row(L("流星频率", "Meteor rate"), sliderHtml("meteorFrequency", 0, 1, 0.01, (v) => Math.round(v * 100) + "%"))}
      ${row(L("鼠标星尘", "Cursor dust"), switchHtml("cursorParticles"))}
      ${row(L("完成提示音", "Quest chime"), switchHtml("questChime"), L("任务完成时播放星轨提示音", "Play a chime when a task completes"))}
    </div>`;
  }

  function sectionFonts() {
    const cards = FONTS.map((font) => `<button type="button" class="ag-starlight-card${state.cfg.fontPreset === font.id ? " is-active" : ""}" data-starlight-font="${font.id}"><strong>${isEn() ? font.en : font.zh}</strong><span>${font.id === "editorial-luxe" ? "Serif · Editorial" : font.id === "modern-silk" ? "Sans · Modern" : font.id === "literary-serif" ? "Serif · Literary" : "Rounded · Playful"}</span></button>`).join("");
    return `<div class="ag-starlight-section">
      <div class="ag-starlight-cards">${cards}</div>
      ${row(L("字号缩放", "Font scale"), sliderHtml("fontScale", 0.85, 1.15, 0.01, (v) => Math.round(v * 100) + "%"))}
    </div>`;
  }

  function sectionEfficiency() {
    return `<div class="ag-starlight-section">
      ${row(L("底部遥测栏", "Telemetry dock"), switchHtml("telemetryBar"), L("会话耗时 / Token 缓存 / 上下文三面板", "Session timing, token cache and context panels"))}
      ${row(L("缓存省钱提示", "Cache savings"), switchHtml("telemetryShowCost"), L("在 Token 面板底部显示缓存节省估算", "Show estimated cache savings in the token panel"))}
      ${row(L("任务进度横条", "Task progress"), switchHtml("taskProgressBar"), L("当前会话含 task.md 时显示进度与清单", "Show progress and checklist when task.md exists"))}
      ${row(L("启动目标胶囊", "Start goal pill"), switchHtml("quickGoalPill"), L("输入框上方显示 /goal 快捷写入按钮", "Show a /goal quick-insert pill above the composer"))}
      ${row(L("对话雷达", "Conversation radar"), switchHtml("runningRadar"), L("侧栏顶部实时显示运行 / 待确认 / 未读对话", "Live running, waiting and unread conversations in the sidebar"))}
      ${row(L("空闲隐藏", "Hide when idle"), switchHtml("hideRadarWhenIdle"))}
      ${row(L("一键复制", "Quick copy"), switchHtml("quickCopyButton"), L("在右侧/主顶栏 ⋮ 旁显示复制按钮", "Copy buttons beside ⋮ in the artifact and main topbars"))}
      ${row(L("提问吸顶", "Prompt sticky"), switchHtml("promptSticky"), L("提问滚到顶部时压缩成一行", "Compact the prompt when it pins to the top"))}
    </div>`;
  }

  const TABS = [
    { id: "language", zh: "语言", en: "Language", icon: "🌐" },
    { id: "wallpaper", zh: "壁纸", en: "Wallpaper", icon: "🖼" },
    { id: "stars", zh: "星效", en: "Stars", icon: "✦" },
    { id: "fonts", zh: "字体", en: "Fonts", icon: "✒" },
    { id: "efficiency", zh: "效率", en: "Efficiency", icon: "⚡" },
    { id: "update", zh: "更新", en: "Update", icon: "⟳" },
  ];

  function sectionHtml() {
    if (state.tab === "wallpaper") return sectionWallpaper();
    if (state.tab === "stars") return sectionStars();
    if (state.tab === "fonts") return sectionFonts();
    if (state.tab === "efficiency") return sectionEfficiency();
    if (state.tab === "update") return sectionUpdate();
    return sectionLanguage();
  }

  function renderInto(container) {
    if (!container) return;
    const embedded = container.id === EMBEDDED_ID;
    const tabs = TABS.map((tab) => `<button type="button" class="ag-starlight-tab${state.tab === tab.id ? " is-active" : ""}" data-starlight-tab="${tab.id}"><span>${tab.icon}</span>${isEn() ? tab.en : tab.zh}</button>`).join("");
    const headActions = embedded
      ? `<button type="button" class="ag-starlight-iconbtn" data-starlight-detach title="${L("在独立窗口中打开", "Open in floating window")}">⧉</button><button type="button" class="ag-starlight-iconbtn" data-starlight-back title="${L("返回设置", "Back to settings")}">←</button>`
      : `<button type="button" class="ag-starlight-iconbtn" data-starlight-min title="${L("收起", "Minimize")}">—</button><button type="button" class="ag-starlight-iconbtn" data-starlight-close title="${L("关闭", "Close")}">×</button>`;
    container.innerHTML = `<div class="ag-starlight-shell${embedded ? " is-embedded" : ""}">
      <div class="ag-starlight-head"${embedded ? "" : " data-starlight-drag"}>
        <span class="ag-starlight-spark">✦</span>
        <div class="ag-starlight-titlebox"><div class="ag-starlight-kicker">STARLIGHT · v${VERSION}</div><h2 class="ag-starlight-title">${L("星夜美化", "Starlight")}</h2></div>
        <span class="ag-starlight-chip">${state.cfg.language === "en" ? "EN" : "中文"}</span>
        ${headActions}
      </div>
      <div class="ag-starlight-tabs">${tabs}</div>
      <div class="ag-starlight-body">${sectionHtml()}</div>
      <div class="ag-starlight-foot"><span data-starlight-status data-kind="${state.status?.kind || ""}">${state.status?.message || (embedded ? L("修改后立即写入配置", "Changes are saved immediately") : L("Alt+S 呼出 / Esc 关闭", "Alt+S to open / Esc to close"))}</span><strong>${L("实时生效", "Live")}</strong></div>
    </div>`;
    bindControls(container, embedded);
  }

  function render() {
    if (win) renderInto(win);
    if (state.embeddedOpen) {
      const embedded = document.getElementById(EMBEDDED_ID);
      if (embedded) renderInto(embedded);
      else state.embeddedOpen = false;
    }
    if (state.tab === "language" && (state.open || state.embeddedOpen)) checkLegacy();
  }

  function bindControls(container, embedded) {
    container.querySelectorAll("[data-starlight-tab]").forEach((button) => button.addEventListener("click", () => {
      state.tab = button.getAttribute("data-starlight-tab");
      render();
    }));
    container.querySelector("[data-starlight-close]")?.addEventListener("click", close);
    container.querySelector("[data-starlight-min]")?.addEventListener("click", () => {
      state.minimized = !state.minimized;
      win.classList.toggle("is-minimized", state.minimized);
    });
    container.querySelector("[data-starlight-detach]")?.addEventListener("click", detachToWindow);
    container.querySelector("[data-starlight-back]")?.addEventListener("click", closeEmbedded);
    container.querySelectorAll("[data-starlight-toggle]").forEach((button) => button.addEventListener("click", () => toggle(button.getAttribute("data-starlight-toggle"))));
    container.querySelectorAll("[data-lang]").forEach((button) => button.addEventListener("click", () => {
      const language = button.getAttribute("data-lang");
      patchConfig({ language });
      setStatus(language === "en" ? "Language: English" : "界面语言：简体中文", "ok");
    }));
    container.querySelectorAll("[data-starlight-slider]").forEach((input) => {
      input.addEventListener("input", () => {
        const key = input.getAttribute("data-starlight-slider");
        const value = Number(input.value);
        const val = container.querySelector(`[data-starlight-val="${key}"]`);
        if (val) {
          if (key === "opacity" || key === "darkTint" || key === "starIntensity" || key === "meteorFrequency") val.textContent = Math.round(value * 100) + "%";
          else if (key === "fontScale") val.textContent = Math.round(value * 100) + "%";
          else val.textContent = Math.round(value) + (key === "blur" ? "px" : "");
        }
        patchConfig({ [key]: value });
      });
    });
    container.querySelectorAll("[data-starlight-star]").forEach((button) => button.addEventListener("click", () => {
      patchConfig({ starEffectMode: button.getAttribute("data-starlight-star") });
      render();
    }));
    container.querySelectorAll("[data-starlight-font]").forEach((button) => button.addEventListener("click", () => {
      patchConfig({ fontPreset: button.getAttribute("data-starlight-font") });
      render();
    }));
    container.querySelector("[data-starlight-update-check]")?.addEventListener("click", () => {
      state.tab = "update";
      void loadUpdate({ check: true, silent: false });
    });
    container.querySelector("[data-starlight-update-apply]")?.addEventListener("click", () => {
      state.tab = "update";
      void applyUpdate();
    });
    const pad = container.querySelector("[data-starlight-wallpaper]");
    if (pad) {
      const setFocus = (event) => {
        const rect = pad.getBoundingClientRect();
        const x = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
        const y = Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100));
        const focus = pad.querySelector(".ag-starlight-focus");
        if (focus) { focus.style.setProperty("--fx", x + "%"); focus.style.setProperty("--fy", y + "%"); }
        patchConfig({ focusX: Math.round(x * 10) / 10, focusY: Math.round(y * 10) / 10 });
      };
      pad.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        pad.setPointerCapture?.(event.pointerId);
        setFocus(event);
        const move = (e) => setFocus(e);
        const up = () => {
          pad.removeEventListener("pointermove", move);
          pad.removeEventListener("pointerup", up);
        };
        pad.addEventListener("pointermove", move);
        pad.addEventListener("pointerup", up);
      });
    }
    container.querySelector("[data-starlight-wall-upload]")?.addEventListener("click", () => pickWallpaper());
    container.querySelector("[data-starlight-wall-reset]")?.addEventListener("click", () => {
      patchConfig({ wallpaperPath: "assets/wallpaper.jpg" });
      toast(L("已还原默认壁纸", "Default wallpaper restored"));
      render();
    });
    container.querySelector("[data-starlight-legacy-check]")?.addEventListener("click", checkLegacy);
    container.querySelector("[data-starlight-legacy-retire]")?.addEventListener("click", retireLegacy);
    if (!embedded) bindDrag(container);
  }

  function bindDrag(container) {
    const head = container.querySelector("[data-starlight-drag]");
    if (!head) return;
    head.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button")) return;
      const rect = win.getBoundingClientRect();
      drag = { x: event.clientX - rect.left, y: event.clientY - rect.top, w: rect.width, h: rect.height };
      win.style.right = "auto";
      win.style.bottom = "auto";
      win.style.left = rect.left + "px";
      win.style.top = rect.top + "px";
      head.classList.add("dragging");
      head.setPointerCapture?.(event.pointerId);
    });
    head.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const left = Math.max(4, Math.min(window.innerWidth - drag.w - 4, event.clientX - drag.x));
      const top = Math.max(4, Math.min(window.innerHeight - 40, event.clientY - drag.y));
      win.style.left = left + "px";
      win.style.top = top + "px";
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      head.classList.remove("dragging");
      try { localStorage.setItem("ag-starlight-pos", JSON.stringify({ left: win.style.left, top: win.style.top })); } catch (error) {}
    };
    head.addEventListener("pointerup", end);
    head.addEventListener("pointercancel", end);
  }

  function pickWallpaper() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      if (file.size > 25 * 1024 * 1024) {
        toast(L("壁纸不能超过 25MB", "Wallpaper must be under 25MB"));
        return;
      }
      setStatus(L("正在上传壁纸…", "Uploading wallpaper…"), "busy");
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = () => reject(reader.error || new Error("read failed"));
          reader.readAsDataURL(file);
        });
        const response = await fetch(SIDECAR + "/api/wallpaper", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataUrl }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok === false) throw new Error(data.error || ("HTTP " + response.status));
        if (data.path) state.cfg.wallpaperPath = data.path;
        setStatus(L("壁纸已上传并应用", "Wallpaper uploaded and applied"), "ok");
        render();
      } catch (error) {
        setStatus(L("上传失败：", "Upload failed: ") + (error.message || error), "error");
      }
    });
    input.click();
  }

  async function checkLegacy() {
    const cards = Array.from(document.querySelectorAll("[data-starlight-legacy]"));
    if (!cards.length) return;
    try {
      const data = await api("/api/i18n/legacy-status");
      state.legacy = data;
      const active = !!data.active;
      cards.forEach((card) => {
        card.classList.toggle("is-warn", active);
        const label = card.querySelector("span:last-child");
        if (label) label.textContent = active
          ? L("检测到旧汉化进程仍在运行", "Legacy Chinese injector is still running")
          : L("旧汉化插件已停用 / 未运行", "Legacy Chinese plugin is stopped");
      });
      document.querySelectorAll("[data-starlight-legacy-retire]").forEach((button) => {
        button.hidden = !active;
      });
    } catch (error) {
      cards.forEach((card) => {
        card.classList.add("is-warn");
        const label = card.querySelector("span:last-child");
        if (label) label.textContent = L("无法读取旧汉化状态", "Legacy status unavailable");
      });
      document.querySelectorAll("[data-starlight-legacy-retire]").forEach((button) => {
        button.hidden = true;
      });
    }
  }

  async function retireLegacy() {
    if (!window.confirm(L("停用旧汉化守护进程并归档开机自启快捷方式？", "Stop the legacy Chinese injector and archive its startup shortcut?"))) return;
    try {
      const data = await api("/api/i18n/legacy-retire", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      state.legacy = data;
      toast(L("旧汉化插件已停用并归档", "Legacy plugin stopped and archived"));
      checkLegacy();
    } catch (error) {
      toast(L("停用失败：", "Retire failed: ") + (error.message || error));
    }
  }

  function ensureWindow() {
    ensureStyle();
    if (!win) {
      win = document.createElement("div");
      win.id = WINDOW_ID;
      win.setAttribute("role", "dialog");
      win.setAttribute("aria-label", L("星夜美化设置", "Starlight settings"));
      document.body.appendChild(win);
      try {
        const saved = JSON.parse(localStorage.getItem("ag-starlight-pos") || "null");
        if (saved && typeof saved.left === "string" && typeof saved.top === "string" && saved.left !== "auto") {
          win.style.right = "auto";
          win.style.left = saved.left;
          win.style.top = saved.top;
        }
      } catch (error) {}
      render();
    }
    return win;
  }

  function open() {
    if (state.embeddedOpen) closeEmbedded();
    ensureWindow();
    state.open = true;
    win.classList.add("is-open");
    win.classList.toggle("is-minimized", state.minimized);
    if (!state.initialized) loadConfig();
    else if (state.tab === "language") checkLegacy();
  }

  function close() {
    state.open = false;
    win?.classList.remove("is-open");
  }

  function toggleWindow() {
    if (state.open) close();
    else open();
  }

  function findEmbeddedHost() {
    const nav = document.querySelector(".ag-starlight-navitem");
    const row = nav?.closest(".relative.flex.w-full.h-full.outline-none")
      || document.querySelector(".settings-modal-container .relative.flex.w-full.h-full.outline-none");
    return row && row.children[1] ? row.children[1] : null;
  }

  function openEmbedded() {
    ensureStyle();
    if (state.open) close();
    const modal = document.querySelector(".settings-modal-container");
    if (!modal) { open(); return; }
    ensureSettingsNav();
    const nav = modal.querySelector(".ag-starlight-navitem");
    const host = findEmbeddedHost();
    if (!nav || !host) { open(); return; }
    let embedded = document.getElementById(EMBEDDED_ID);
    if (!embedded) {
      embedded = document.createElement("div");
      embedded.id = EMBEDDED_ID;
      embedded.className = "ag-starlight-embedded";
      embedded.setAttribute("role", "region");
      embedded.setAttribute("aria-label", L("星夜美化设置", "Starlight settings"));
      host.appendChild(embedded);
    }
    host.classList.add("ag-starlight-content-host");
    modal.classList.add("ag-starlight-embedded-open");
    nav.classList.add("is-active");
    state.embeddedOpen = true;
    renderInto(embedded);
    if (!state.initialized) loadConfig();
    else if (state.tab === "language") checkLegacy();
  }

  function closeEmbedded() {
    state.embeddedOpen = false;
    document.querySelector(".settings-modal-container")?.classList.remove("ag-starlight-embedded-open");
    document.querySelector(".ag-starlight-navitem")?.classList.remove("is-active");
    document.getElementById(EMBEDDED_ID)?.remove();
    document.querySelectorAll(".ag-starlight-content-host").forEach((node) => node.classList.remove("ag-starlight-content-host"));
  }

  function detachToWindow() {
    closeEmbedded();
    const modal = document.querySelector(".settings-modal-container");
    modal?.querySelector('button[aria-label="Close"]')?.click();
    setTimeout(open, 140);
  }

  function syncLauncherLanguage() {
    const launcher = document.getElementById(LAUNCH_ID);
    if (launcher) {
      launcher.title = L("星夜美化设置 (Alt+S)", "Starlight settings (Alt+S)");
      launcher.setAttribute("aria-label", L("打开星夜美化设置", "Open Starlight settings"));
    }
    const immersive = document.getElementById("ag-immersive-toggle");
    if (immersive) {
      immersive.title = L("沉浸观星 (Alt+Z)", "Immersive stargazing (Alt+Z)");
      immersive.setAttribute("aria-label", L("切换沉浸观星模式", "Toggle immersive stargazing"));
    }
    const nav = document.querySelector(".ag-starlight-navitem");
    if (nav) {
      const labels = nav.querySelectorAll("span");
      if (labels[1]) labels[1].textContent = L("星夜美化", "Starlight");
      nav.title = L("打开星夜美化设置页", "Open Starlight settings");
      nav.setAttribute("aria-label", L("星夜美化设置", "Starlight settings"));
    }
  }

  function syncLauncherUpdateBadge() {
    const launcher = document.getElementById(LAUNCH_ID);
    if (!launcher) return;
    const update = state.update || {};
    const available = Boolean(update.available);
    launcher.classList.toggle("has-update", available);
    if (available) {
      launcher.title = L(`发现新版本 v${update.latest}，打开星夜美化更新`, `v${update.latest} available — open Starlight to update`);
      launcher.setAttribute("aria-label", launcher.title);
    } else {
      syncLauncherLanguage();
    }
  }

  function ensureLauncher() {
    ensureStyle();
    if (document.getElementById(LAUNCH_ID)) {
      syncLauncherUpdateBadge();
      return;
    }
    const more = document.querySelector('[data-testid="titlebar-more-actions"]');
    const host = more?.parentElement || document.querySelector('[data-testid="title-menu-bar"]');
    if (!host) return;
    const button = document.createElement("button");
    button.id = LAUNCH_ID;
    button.type = "button";
    button.textContent = "✦";
    button.title = L("星夜美化设置 (Alt+S)", "Starlight settings (Alt+S)");
    button.setAttribute("aria-label", L("打开星夜美化设置", "Open Starlight settings"));
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleWindow();
    });
    host.insertBefore(button, more);
    syncLauncherLanguage();
    syncLauncherUpdateBadge();
  }

  function ensureSettingsNav() {
    const modal = document.querySelector(".settings-modal-container");
    if (!modal) return;
    const navItem = Array.from(modal.querySelectorAll('[data-testid^="settings-nav-item-"]')).find((node) => node.getBoundingClientRect().width > 0);
    const nav = navItem?.parentElement;
    if (!nav || nav.querySelector(".ag-starlight-navitem")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ag-starlight-navitem";
    button.innerHTML = `<span>✦</span><span>${L("星夜美化", "Starlight")}</span><span class="badge">v1.1</span>`;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openEmbedded();
    });
    nav.insertBefore(button, nav.firstChild);
  }

  document.addEventListener("keydown", (event) => {
    if (event.altKey && !event.ctrlKey && !event.metaKey && String(event.key).toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      toggleWindow();
    } else if (event.key === "Escape" && state.open) {
      close();
    }
  }, true);
  document.addEventListener("ag-config-updated", (event) => {
    const patch = event.detail || {};
    if (patch.language || Object.keys(patch).some((key) => key in DEFAULTS)) {
      state.cfg = Object.assign({}, state.cfg, patch);
      syncLauncherLanguage();
      if (state.open || state.embeddedOpen) render();
    }
  });
  document.addEventListener("click", (event) => {
    const target = event.target;
    const modal = document.querySelector(".settings-modal-container");
    if (modal && state.embeddedOpen && target?.closest
      && !target.closest(`#${EMBEDDED_ID}`)
      && !target.closest(".ag-starlight-navitem")
      && (target.closest('[data-testid^="settings-nav-item-"]') || target.closest('button[aria-label="Close"]'))) {
      closeEmbedded();
    }
    ensureSettingsNav();
  }, true);
  setInterval(() => {
    ensureLauncher();
    ensureSettingsNav();
    if (state.embeddedOpen && !document.querySelector(".settings-modal-container")) closeEmbedded();
  }, 1500);
  ensureLauncher();
  setTimeout(() => { void loadUpdate({ check: true, silent: false }); }, 4000);
  setInterval(() => { void loadUpdate({ check: true, silent: true }); }, 6 * 60 * 60 * 1000);

  window.__agStarlight = { open, close, toggle: toggleWindow, isOpen: () => state.open, openEmbedded, closeEmbedded, isEmbeddedOpen: () => state.embeddedOpen, version: VERSION };
})();
