const $ = (id) => document.getElementById(id);

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r || {})));
}

function showRecError(message) {
  const box = $("rec-error");
  if (!message) {
    box.textContent = "";
    box.classList.add("hidden");
    return;
  }
  box.textContent = message;
  box.classList.remove("hidden");
}

function setRecBusy(busy, label) {
  $("rec-start").disabled = busy;
  $("rec-stop").disabled = busy;
  if (busy) {
    const badge = $("rec-state");
    badge.textContent = label || "处理中…";
    badge.className = "rec-badge live";
  }
}

async function render() {
  const st = await send({ type: "ag:status" });
  const s = st.settings || {};
  $("port").value = s.port ?? 8767;
  $("token").value = s.token ?? "";
  $("search").value = s.searchEngine ?? "";
  $("auto").checked = s.autoConnect !== false;

  $("browser").textContent = st.browser ? "· " + st.browser : "";
  const dot = $("dot");
  dot.className = "dot " + (st.wsState === "connected" ? "on" : st.wsState === "connecting" ? "" : "off");
  $("state").textContent =
    st.wsState === "connected" ? "已连接本地 MCP 服务"
    : st.wsState === "connecting" ? "正在连接…"
    : "未连接（等待 MCP 服务启动）";
  const lines = [];
  if (st.tabs != null) lines.push("标签 " + st.tabs);
  if (st.activeTab) lines.push(st.activeTab.title ? "当前：" + st.activeTab.title : "");
  if (st.cdpTabId) lines.push("CDP tab " + st.cdpTabId);
  if (st.lastError) lines.push("错误：" + st.lastError);
  $("detail").textContent = lines.filter(Boolean).join(" · ");

  const rec = st.recording;
  const lastRec = st.lastRecording;
  const recBadge = $("rec-state");
  const recDetail = $("rec-detail");
  const btnStart = $("rec-start");
  const btnStop = $("rec-stop");
  if (rec && rec.active) {
    recBadge.textContent = rec.paused ? "已暂停" : ("录制中 · " + (rec.stepCount || 0) + " 步");
    recBadge.className = "rec-badge on";
    recDetail.textContent = "会话 " + rec.recordingId + " · 页面右下角胶囊可备注规则 / 标记提取 / 完成";
    btnStart.disabled = true;
    btnStop.disabled = false;
  } else {
    recBadge.textContent = "待命";
    recBadge.className = "rec-badge";
    if (lastRec) {
      recDetail.textContent = "最近录制：" + (lastRec.title || lastRec.recordingId) + "（" + (lastRec.stepCount || 0) + " 步），可在 Antigravity 中生成 Skill";
    } else {
      recDetail.textContent = "点击下方按钮在当前标签页开启 RPA 轨迹录制";
    }
    btnStart.disabled = false;
    btnStop.disabled = true;
  }

  // 旧版 service worker 连录制消息都不认识：给出明确的重载指引，而不是静默失败
  if (st.wsState === "connected" && st.recordingSupported === false) {
    showRecError("当前扩展仍在运行旧代码，录制/回放不可用。请点击底部「⟳ 重载扩展」后重试。");
  }
}

$("rec-start").onclick = async () => {
  showRecError("");
  setRecBusy(true, "正在启动…");
  const res = await send({ type: "ag:record:start", args: {} });
  if (!res || res.ok === false) {
    showRecError((res && (res.error || res.hint)) || "无法开始录制：当前页面可能受保护（edge://、扩展商店等），或扩展需要重载。");
  } else if (res.hudInjected === false) {
    showRecError(res.hudNote || "录制已开启，但当前页面无法注入悬浮录制胶囊（受保护页面）。请打开普通网页后再录制。");
  }
  setRecBusy(false);
  render();
};

$("rec-stop").onclick = async () => {
  showRecError("");
  setRecBusy(true, "正在保存…");
  const res = await send({ type: "ag:record:stop", args: {} });
  if (!res || res.ok === false) {
    showRecError((res && (res.error || res.hint)) || "完成录制失败，请重试。");
  }
  setRecBusy(false);
  render();
};

$("reload-ext").onclick = () => {
  showRecError("");
  chrome.runtime.reload();
};

$("save").onclick = async () => {
  await send({
    type: "ag:settings",
    settings: {
      port: Number($("port").value) || 8767,
      token: $("token").value.trim(),
      searchEngine: $("search").value.trim() || "https://www.bing.com/search?q=",
      autoConnect: $("auto").checked,
    },
  });
  await send({ type: "ag:reconnect" });
  render();
};

$("reconnect").onclick = async () => { await send({ type: "ag:reconnect" }); render(); };

render();
setInterval(render, 1500);
