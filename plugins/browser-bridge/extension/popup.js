const $ = (id) => document.getElementById(id);

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r || {})));
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
  if (st.tabs != null) lines.push("标签页 " + st.tabs + " 个");
  if (st.activeTab) lines.push("当前：" + st.activeTab.title);
  if (st.cdpTabId) lines.push("CDP 已附加 tab " + st.cdpTabId);
  if (st.lastError) lines.push("最近错误：" + st.lastError);
  $("detail").textContent = lines.join(" · ");
}

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
