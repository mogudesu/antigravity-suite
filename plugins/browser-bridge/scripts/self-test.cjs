#!/usr/bin/env node
"use strict";

/**
 * 自测：用「模拟扩展」连上真实的 MCP 服务，验证 MCP 协议帧、工具清单、转发链路、
 * 多浏览器路由、错误契约与图片内容映射。
 * 用法：node scripts/self-test.cjs
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");
const readline = require("readline");
const WebSocket = require("ws");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "mcp-server", "server.js");
const PNG_B64 = fs.readFileSync(path.join(ROOT, "extension", "icons", "icon16.png")).toString("base64");
const PORT = 8799;

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (detail ? "  —— " + detail : "")); }
}
function section(t) { console.log("\n" + t); }

/* ----------------------------------------------------------- MCP 客户端 */

class McpClient {
  constructor(env) {
    this.child = spawn(process.execPath, [SERVER], {
      env: Object.assign({}, process.env, env || {}),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.pending = new Map();
    this.nextId = 1;
    this.badLines = [];
    this.stderr = [];
    const out = readline.createInterface({ input: this.child.stdout });
    out.on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch (e) { this.badLines.push(line); return; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const resolve = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    });
    const err = readline.createInterface({ input: this.child.stderr });
    err.on("line", (l) => this.stderr.push(l));
  }
  request(method, params, timeoutMs = 8000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("MCP 请求超时：" + method));
      }, timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  close() {
    try { this.child.stdin.end(); } catch (e) { /* ignore */ }
    try { this.child.kill(); } catch (e) { /* ignore */ }
  }
}

/* ----------------------------------------------------------- 模拟扩展 */

function defaultResults(browser) {
  return {
    browser_status: () => ({
      ok: true, browser, extensionVersion: "1.0.0",
      bridge: { state: "connected", port: PORT, lastError: null },
      tabs: 3, activeTab: { id: 11, title: "示例页", url: "https://example.com/" },
      cdpAttachedTabs: [],
    }),
    browser_snapshot: () => ({
      ok: true, tabId: 11, title: "示例页", url: "https://example.com/", snapshotId: "s1",
      refs: 2, truncated: false,
      snapshot: '- textbox "用户名" [ref=e1]\n- button "登录" [ref=e2]',
    }),
    browser_click: (args) => ({ ok: true, engine: "cdp", tabId: 11, x: 100, y: 200, target: { ok: true, ref: args.ref } }),
    browser_type: (args) => ({ ok: true, tabId: 11, tag: "input", value: args.text, changed: true }),
    browser_screenshot: () => ({
      ok: true, engine: "cdp", tabId: 11, url: "https://example.com/",
      image: { data: PNG_B64, mimeType: "image/png" },
      text: "已截图 https://example.com/（可视区）",
    }),
    browser_get_text: () => ({ ok: true, tabId: 11, length: 5, truncated: false, text: "hello" }),
    browser_evaluate: (args) => ({ ok: true, engine: "cdp", tabId: 11, type: "number", value: String(args.expression).length }),
    browser_tabs: (args) => ({ ok: true, count: 1, tabs: [{ id: 11, active: true, url: "https://example.com/" }], action: args.action || "list" }),
  };
}

function connectMock({ browser, token, port = PORT, overrides = {}, failTools = [], silentTools = [] }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:" + port + "/bridge");
    const table = Object.assign({}, defaultResults(browser), overrides);
    const seen = [];
    let settled = false;
    const timer = setTimeout(() => { if (!settled) reject(new Error("模拟扩展握手超时：" + browser)); }, 5000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ t: "hello", browser, version: "test-1.0.0", token, ua: "mock/" + browser }));
    });
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch (e) { return; }
      if (msg.t === "welcome") {
        settled = true;
        clearTimeout(timer);
        resolve({ ws, browser, seen, close: () => ws.close() });
        return;
      }
      if (msg.t === "error") {
        settled = true;
        clearTimeout(timer);
        resolve({ ws, browser, rejected: true, message: msg.message, seen, close: () => ws.close() });
        return;
      }
      if (msg.t === "ping") { ws.send(JSON.stringify({ t: "pong" })); return; }
      if (msg.t === "req") {
        seen.push(msg.tool);
        if (silentTools.indexOf(msg.tool) !== -1) { return; }
        if (failTools.indexOf(msg.tool) !== -1) {
          ws.send(JSON.stringify({ t: "res", id: msg.id, ok: false, error: "模拟的失败：" + msg.tool }));
          return;
        }
        const fn = table[msg.tool];
        if (!fn) { ws.send(JSON.stringify({ t: "res", id: msg.id, ok: false, error: "模拟扩展没有实现 " + msg.tool })); return; }
        try {
          ws.send(JSON.stringify({ t: "res", id: msg.id, ok: true, result: fn(msg.args || {}) }));
        } catch (e) {
          ws.send(JSON.stringify({ t: "res", id: msg.id, ok: false, error: e.message }));
        }
      }
    });
    ws.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
  });
}

function textOf(res) {
  const c = res && res.result && res.result.content;
  if (!Array.isArray(c)) return "";
  return c.filter((x) => x.type === "text").map((x) => x.text).join("\n");
}

async function waitUntil(fn, timeoutMs = 5000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(stepMs);
  }
  return fn();
}

/** 直接请求桥接的本地 HTTP 接口，返回 { status, json }。 */
function httpJson(method, port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = options.body ? Buffer.from(JSON.stringify(options.body)) : null;
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method,
      agent: false,
      headers: Object.assign(
        { Accept: "application/json", Connection: "close" },
        payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {},
        options.token ? { "x-ag-token": options.token } : {}
      ),
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) { json = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    req.end(payload || undefined);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------------------------------------- 主流程 */

async function main() {
  section("启动 MCP 服务（stdio）");
  const client = new McpClient({ AG_BRIDGE_PORT: String(PORT) });
  await sleep(700);
  check("服务已监听桥接端口", client.stderr.some((l) => l.indexOf("桥接已监听") !== -1), client.stderr.join(" | "));

  section("MCP 握手与能力");
  const init = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "self-test", version: "1" } });
  check("initialize 返回 serverInfo.name", init.result && init.result.serverInfo && init.result.serverInfo.name === "antigravity-browser-bridge", JSON.stringify(init.result));
  check("initialize 回显 protocolVersion", init.result && init.result.protocolVersion === "2025-06-18");
  check("声明 tools 能力", !!(init.result && init.result.capabilities && init.result.capabilities.tools));
  check("Leader 的 initialize 说明包含 Leader", String(init.result.instructions || "").indexOf("Leader") !== -1);
  client.notify("notifications/initialized", {});

  const ping = await client.request("ping", {});
  check("ping 正常应答", ping.result && typeof ping.result === "object");

  const unknown = await client.request("no/such/method", {});
  check("未知方法返回 -32601", unknown.error && unknown.error.code === -32601, JSON.stringify(unknown.error));

  section("工具清单");
  const list = await client.request("tools/list", {});
  const tools = (list.result && list.result.tools) || [];
  check("工具数量为 18", tools.length === 18, "实际 " + tools.length);
  check("每个工具都有 name/description/inputSchema", tools.every((t) => t.name && t.description && t.inputSchema && t.inputSchema.type === "object"));
  const expected = ["browser_launch", "browser_status", "browser_tabs", "browser_open", "browser_history", "browser_snapshot",
    "browser_screenshot", "browser_click", "browser_type", "browser_press", "browser_hover", "browser_scroll",
    "browser_select_option", "browser_get_text", "browser_evaluate", "browser_wait_for", "browser_console", "browser_network"];
  const names = tools.map((t) => t.name);
  check("工具名齐全", expected.every((n) => names.indexOf(n) !== -1), names.join(","));
  const launchTool = tools.find((t) => t.name === "browser_launch");
  check("browser_launch 默认 browser=edge 且支持 dryRun", !!launchTool &&
    launchTool.inputSchema.properties.browser.enum.indexOf("edge") === 0 &&
    !!launchTool.inputSchema.properties.dryRun,
    JSON.stringify(launchTool && launchTool.inputSchema.properties));

  section("没有扩展连接时的错误契约");
  const noExt = await client.request("tools/call", { name: "browser_status", arguments: {} });
  check("isError = true", noExt.result && noExt.result.isError === true);
  check("错误码为 NO_EXTENSION", textOf(noExt).indexOf("NO_EXTENSION") !== -1, textOf(noExt));
  check("带排查指引", textOf(noExt).indexOf("重连") !== -1);

  section("扩展连接后转发");
  const edge = await connectMock({ browser: "edge" });
  await sleep(300);
  check("Edge 模拟扩展已握手", edge.ws.readyState === WebSocket.OPEN);

  const status = await client.request("tools/call", { name: "browser_status", arguments: {} });
  check("browser_status 透传成功", status.result && status.result.isError === false && textOf(status).indexOf('"edge"') !== -1, textOf(status));

  const snap = await client.request("tools/call", { name: "browser_snapshot", arguments: {} });
  check("browser_snapshot 透传成功", textOf(snap).indexOf("ref=e1") !== -1, textOf(snap));

  const click = await client.request("tools/call", { name: "browser_click", arguments: { ref: "e2" } });
  check("browser_click 带参数透传", textOf(click).indexOf('"x": 100') !== -1, textOf(click));

  const type = await client.request("tools/call", { name: "browser_type", arguments: { ref: "e1", text: "库库AI" } });
  check("browser_type 参数与中文透传", textOf(type).indexOf("库库AI") !== -1, textOf(type));

  const shot = await client.request("tools/call", { name: "browser_screenshot", arguments: {} });
  const content = shot.result.content;
  check("截图映射为 image 内容块", content[0] && content[0].type === "image" && content[0].mimeType === "image/png", JSON.stringify(content[0] && content[0].type));
  check("截图 base64 可解码为 PNG", Buffer.from(content[0].data, "base64").slice(0, 8).toString("hex") === "89504e470d0a1a0a");
  check("截图同时带文本说明", content.some((c) => c.type === "text" && c.text.indexOf("已截图") !== -1));

  const evaluate = await client.request("tools/call", { name: "browser_evaluate", arguments: { expression: "1 + 1" } });
  check("browser_evaluate 透传", evaluate.result.isError === false && textOf(evaluate).indexOf('"value": 5') !== -1, textOf(evaluate));

  section("扩展侧报错的传递");
  const bad = await client.request("tools/call", { name: "browser_hover", arguments: { ref: "e1" } });
  check("扩展未实现的工具报错并回传", bad.result.isError === true && textOf(bad).indexOf("EXTENSION_ERROR") !== -1, textOf(bad));
  const failMock = await connectMock({ browser: "edge", failTools: ["browser_click"], overrides: {} });
  await sleep(250);
  const failed2 = await client.request("tools/call", { name: "browser_click", arguments: { ref: "e1" } });
  check("扩展返回 ok:false 时映射为 isError", failed2.result.isError === true && textOf(failed2).indexOf("模拟的失败") !== -1, textOf(failed2));
  failMock.close();

  section("未知工具名");
  const bogus = await client.request("tools/call", { name: "browser_teleport", arguments: {} });
  check("未知工具返回 isError 与提示", bogus.result.isError === true && textOf(bogus).indexOf("未知工具") !== -1, textOf(bogus));

  section("多浏览器路由");
  const chrome = await connectMock({ browser: "chrome", overrides: { browser_status: () => ({ ok: true, browser: "chrome", marker: "CHROME-ONLY" }) } });
  await sleep(300);
  const toChrome = await client.request("tools/call", { name: "browser_status", arguments: { browser: "chrome" } });
  check("browser=chrome 路由到 Chrome 扩展", textOf(toChrome).indexOf("CHROME-ONLY") !== -1, textOf(toChrome));
  const toEdge = await client.request("tools/call", { name: "browser_status", arguments: { browser: "edge" } });
  check("browser=edge 路由到 Edge 扩展", textOf(toEdge).indexOf("CHROME-ONLY") === -1 && textOf(toEdge).indexOf('"edge"') !== -1, textOf(toEdge));
  const toMissing = await client.request("tools/call", { name: "browser_status", arguments: { browser: "chromium" } });
  check("指定未连接的浏览器时给出可用列表", toMissing.result.isError === true && textOf(toMissing).indexOf("没有名为 chromium 的扩展连接") !== -1, textOf(toMissing));
  chrome.close();
  edge.close();
  await sleep(200);

  section("输出纯净性");
  check("stdout 只有合法 JSON 行", client.badLines.length === 0, client.badLines.join(" | "));
  check("日志写在 stderr", client.stderr.some((l) => l.indexOf("[browser-bridge]") === 0));

  section("browser_launch（dry-run，不启动真实浏览器）");
  const edgeLaunch = await client.request("tools/call", {
    name: "browser_launch",
    arguments: { browser: "edge", profileDirectory: "Default", url: "https://example.com/", dryRun: true },
  });
  let edgePayload = {};
  try { edgePayload = JSON.parse(textOf(edgeLaunch)); } catch (e) { edgePayload = {}; }
  check("Edge dry-run 返回成功", edgeLaunch.result && edgeLaunch.result.isError === false, textOf(edgeLaunch));
  check("Edge dry-run 未启动浏览器", edgePayload.dryRun === true && edgePayload.launched === false, JSON.stringify(edgePayload));
  check("Edge 命中已核验路径", edgePayload.executablePath === "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", String(edgePayload.executablePath));
  check("Edge 命令行含 profile 与 url", String(edgePayload.commandLine).indexOf("--profile-directory=Default") !== -1 &&
    String(edgePayload.commandLine).indexOf("https://example.com/") !== -1, String(edgePayload.commandLine));
  check("browser_launch 默认 waitConnectMs=8000 且保留 profile/url", edgePayload.waitConnectMs === 8000 &&
    edgePayload.profileDirectory === "Default" && edgePayload.url === "https://example.com/", JSON.stringify(edgePayload));

  const chromeLaunch = await client.request("tools/call", {
    name: "browser_launch", arguments: { browser: "chrome", dryRun: true },
  });
  let chromePayload = {};
  try { chromePayload = JSON.parse(textOf(chromeLaunch)); } catch (e) { chromePayload = {}; }
  check("Chrome dry-run 命中已核验路径", chromePayload.ok === true &&
    chromePayload.executablePath === "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", String(chromePayload.executablePath));

  const inferredLaunch = await client.request("tools/call", {
    name: "browser_launch", arguments: { executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", dryRun: true },
  });
  let inferredPayload = {};
  try { inferredPayload = JSON.parse(textOf(inferredLaunch)); } catch (e) { inferredPayload = {}; }
  check("只给 executablePath 时按文件名推断 chrome", inferredPayload.ok === true && inferredPayload.browser === "chrome", JSON.stringify(inferredPayload));

  const customMissing = await client.request("tools/call", {
    name: "browser_launch", arguments: { browser: "custom", dryRun: true },
  });
  check("custom 缺少 executablePath 时报错", customMissing.result.isError === true && textOf(customMissing).indexOf("EXE_REQUIRED") !== -1, textOf(customMissing));

  const customBad = await client.request("tools/call", {
    name: "browser_launch", arguments: { browser: "custom", executablePath: "C:\\no\\such\\browser.exe", dryRun: true },
  });
  check("custom 路径不存在时报错", customBad.result.isError === true && textOf(customBad).indexOf("不存在") !== -1, textOf(customBad));

  section("Bridge 超时与令牌（单元级）");
  const { Bridge } = require(path.join(ROOT, "mcp-server", "bridge.js"));
  const b = new Bridge({ port: 8801, token: "secret", log: () => {} });
  await b.start();
  const wrong = await connectMock({ browser: "edge", token: "wrong", port: 8801 });
  check("令牌不匹配时拒绝连接", wrong.rejected === true, JSON.stringify(wrong.message));
  wrong.close();
  const okClient = await connectMock({ browser: "edge", token: "secret", port: 8801, silentTools: ["browser_status"] });

  const statusRes = await httpJson("GET", 8801, "/status");
  check("GET /status 自述 role=leader", statusRes.status === 200 && statusRes.json &&
    statusRes.json.server === "antigravity-browser-bridge" && statusRes.json.role === "leader", JSON.stringify(statusRes));
  const noToken = await httpJson("POST", 8801, "/rpc", { body: { tool: "browser_snapshot", args: {}, timeoutMs: 1000 } });
  check("POST /rpc 缺少 x-ag-token 返回 401", noToken.status === 401, JSON.stringify(noToken));
  const badToken = await httpJson("POST", 8801, "/rpc", { token: "wrong", body: { tool: "browser_snapshot", args: {}, timeoutMs: 1000 } });
  check("POST /rpc 错误 x-ag-token 返回 401", badToken.status === 401, JSON.stringify(badToken));
  const goodToken = await httpJson("POST", 8801, "/rpc", { token: "secret", body: { tool: "browser_snapshot", args: {}, timeoutMs: 2000 } });
  check("POST /rpc 正确令牌返回原始结果", goodToken.status === 200 && goodToken.json && goodToken.json.ok === true &&
    String(goodToken.json.result && goodToken.json.result.snapshot).indexOf("ref=e1") !== -1, JSON.stringify(goodToken.json));

  const t0 = Date.now();
  let timeoutErr = null;
  try { await b.call("browser_status", {}, 500); } catch (e) { timeoutErr = e; }
  check("超时返回 TIMEOUT", timeoutErr && timeoutErr.code === "TIMEOUT", timeoutErr && timeoutErr.message);
  check("超时耗时接近设定值", Date.now() - t0 < 3000, (Date.now() - t0) + "ms");
  okClient.close();
  b.stop();

  section("端口占用时自动成为 Follower 并中继");
  const follower = new McpClient({ AG_BRIDGE_PORT: String(PORT) });
  const becameFollower = await waitUntil(() => follower.stderr.some((l) => l.indexOf("Follower 模式") !== -1), 8000);
  check("第二个进程自动进入 Follower 模式", becameFollower, follower.stderr.join(" | "));
  check("Follower 不再报 LISTEN_FAILED / 桥接启动失败",
    !follower.stderr.some((l) => l.indexOf("LISTEN_FAILED") !== -1 || l.indexOf("桥接启动失败") !== -1),
    follower.stderr.join(" | "));

  const finit = await follower.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "self-test-follower", version: "1" } });
  check("Follower 的 initialize 说明包含 Follower", String(finit.result && finit.result.instructions).indexOf("Follower") !== -1, JSON.stringify(finit.result && finit.result.instructions));
  const flist = await follower.request("tools/list", {});
  check("Follower tools/list 与 Leader 一致（18 个）", ((flist.result && flist.result.tools) || []).length === 18);

  const relayMock = await connectMock({
    browser: "edge",
    overrides: { browser_status: () => ({ ok: true, browser: "edge", marker: "RELAY-OK" }) },
  });
  await sleep(250);
  const relayed = await follower.request("tools/call", { name: "browser_status", arguments: {} });
  check("Follower 调用经 POST /rpc 中继到 Leader 执行",
    relayed.result && relayed.result.isError === false && textOf(relayed).indexOf("RELAY-OK") !== -1, textOf(relayed));
  relayMock.close();
  follower.close();
  await sleep(200);
  client.close();

  console.log("\n结果：" + passed + " 通过 / " + failed + " 失败");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("自测异常终止：" + (e && e.stack || e));
  process.exit(1);
});
