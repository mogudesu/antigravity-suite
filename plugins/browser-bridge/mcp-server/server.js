#!/usr/bin/env node
"use strict";

/**
 * Antigravity Browser Bridge —— MCP stdio 服务。（浏览器扩展显示名：antigravity浏览器控制；品牌：谷谷嘎嘎）
 * 由 Antigravity 以子进程方式启动：stdin/stdout 走 MCP 的 JSON-RPC，日志一律写 stderr。
 *
 * 多会话：
 *   - 第一个进程绑定 127.0.0.1:<port>，成为 Leader（WS /bridge + GET /status + POST /rpc）。
 *   - 后来的进程遇到 EADDRINUSE 时先 GET /status 确认「是自己人」，然后作为 Follower
 *     把所有工具调用 POST /rpc 中继给 Leader；Leader 消失后下次调用自动尝试接管端口。
 */

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { Bridge, BridgeError, MARKER } = require("./bridge");
const { TOOLS, findTool, timeoutFor } = require("./tools");
const { runBrowserLaunch } = require("./launch");
const {
  getRecordingsDir,
  saveRecording,
  listRecordings,
  loadRecording,
  interpolateSteps,
} = require("./recordings");

const SERVER_NAME = "antigravity-browser-bridge";
const SERVER_VERSION = "1.7.0";
const ROOT = path.join(__dirname, "..");
const STATUS_TIMEOUT_MS = 1500;
const TAKEOVER_WAIT_MS = 1500;
const AUDIT_DIR = process.env.AG_BRIDGE_AUDIT_DIR || path.join(os.homedir(), ".gemini", "memory", "browser-bridge");

const USAGE = `
antigravity-browser-bridge —— 让 Antigravity 驱动本机 Edge / Chrome 的 MCP 服务

用法：
  node mcp-server/server.js [--port 8765] [--host 127.0.0.1] [--token <令牌>]
  node mcp-server/server.js --print-config   # 只打印解析后的配置（默认 127.0.0.1:8765），不启动服务

环境变量：
  AG_BRIDGE_PORT       桥接端口（默认 8765）
  AG_BRIDGE_HOST       监听地址（默认 127.0.0.1，只监听本机）
  AG_BRIDGE_TOKEN      可选访问令牌，需与扩展弹窗里填的一致
  AG_BRIDGE_DRY_RUN    设为 1 时 browser_launch 只返回命令行，不启动浏览器

多会话：第一个进程是 Leader；后续进程检测到本桥接的 /status 后自动成为 Follower，
工具调用经 POST /rpc 中继。Leader 退出后，Follower 在下次调用时自动接管端口。

本进程通过 stdio 与 Antigravity 通信，请勿手动运行后直接在里面输入命令。
`.trim();

function parseArgs(argv) {
  const out = {
    host: process.env.AG_BRIDGE_HOST || "127.0.0.1",
    port: Number(process.env.AG_BRIDGE_PORT || 8765),
    token: process.env.AG_BRIDGE_TOKEN || "",
    help: false,
    printConfig: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--token") out.token = argv[++i] || "";
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--print-config") out.printConfig = true;
  }
  if (!Number.isFinite(out.port) || out.port <= 0 || out.port > 65535) out.port = 8765;
  return out;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  process.stdout.write(USAGE + "\n");
  process.exit(0);
}
if (opts.printConfig) {
  process.stdout.write(JSON.stringify({
    server: SERVER_NAME,
    version: SERVER_VERSION,
    host: opts.host,
    port: opts.port,
    tokenRequired: !!opts.token,
    root: ROOT,
    serverJs: __filename,
  }, null, 2) + "\n");
  process.exit(0);
}

function log(...parts) {
  process.stderr.write("[browser-bridge] " + parts.join(" ") + "\n");
}

/** Security-relevant outcomes only: never write typed text, expressions or URLs. */
function auditBlocked(name, args, result) {
  if (!result || typeof result !== "object" || !result.blocked) return;
  const record = {
    ts: new Date().toISOString(),
    tool: name,
    blocked: result.blocked,
    reason: result.error || "",
    tabId: result.tabId != null ? result.tabId : (args.tabId != null ? args.tabId : null),
    target: args.ref || args.selector || (args.text ? "(text match)" : ""),
    action: args.action || "",
    key: typeof args.key === "string" && args.key.length <= 20 ? args.key : "",
  };
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const file = path.join(AUDIT_DIR, "audit-" + record.ts.slice(0, 10) + ".jsonl");
    fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
  } catch (e) {
    log("审计日志写入失败：" + ((e && e.message) || e));
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/** 把扩展 / 本地工具返回的结构转成 MCP content 数组 */
function toContent(result) {
  if (result && typeof result === "object" && result.image && result.image.data) {
    const out = [{ type: "image", data: result.image.data, mimeType: result.image.mimeType || "image/png" }];
    const meta = Object.assign({}, result);
    delete meta.image;
    out.push({ type: "text", text: JSON.stringify(meta, null, 2) });
    return out;
  }
  if (typeof result === "string") return [{ type: "text", text: result }];
  return [{ type: "text", text: JSON.stringify(result, null, 2) }];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 状态 */

let bridge = null;
let mode = "starting"; // starting | leader | follower | unavailable
let leaderInfo = null;
let bridgeError = "";

const GONE_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH",
  "LEADER_TIMEOUT", "LEADER_BAD_RESPONSE", "LEADER_GONE",
]);

function isLeaderGone(e) {
  return !!e && GONE_CODES.has(e.code);
}

function createBridge() {
  return new Bridge({
    host: opts.host,
    port: opts.port,
    token: opts.token,
    log,
    onChange: () => {
      const list = bridge ? bridge.list() : [];
      log(list.length ? "已连接扩展：" + list.map((c) => `${c.browser} v${c.version}`).join("、") : "当前没有扩展连接");
    },
    onRecordDone: (rawRec) => {
      try {
        const saved = saveRecording(rawRec);
        log(`收到浏览器 HUD 完成的录制：${saved.recordingId}（${saved.stepCount} 步），已保存至 ${saved.filePath}`);
      } catch (e) {
        log("保存 HUD 录制失败：" + ((e && e.message) || e));
      }
    },
    onToolCall: (name, args, timeoutMs) => executeLeaderTool(name, args, timeoutMs),
  });
}

async function executeLeaderTool(name, args, timeoutMs) {
  if (!bridge || !bridge.started) throw new BridgeError("BRIDGE_UNAVAILABLE", bridgeError || "桥接尚未就绪");

  if (name === "browser_record_stop") {
    const extRes = await bridge.call("browser_record_stop", args, timeoutMs);
    if (!extRes || extRes.ok === false || !extRes.recording) {
      return extRes;
    }
    if (args && args.save === false) {
      return extRes;
    }
    const saved = saveRecording(extRes.recording, { title: args && args.title });
    return {
      ok: true,
      status: extRes.status || "stopped",
      recordingId: saved.recordingId,
      title: saved.title,
      filePath: saved.filePath,
      stepCount: saved.stepCount,
      suggestedParameters: saved.suggestedParameters,
      userNotes: saved.userNotes,
      extractTargets: saved.extractTargets,
      recording: saved.recording,
    };
  }

  if (name === "browser_record_list") {
    const action = (args && args.action) || "status";
    if (action === "list") {
      const items = listRecordings(args && args.limit);
      return {
        ok: true,
        action: "list",
        recordingsDir: getRecordingsDir(),
        count: items.length,
        recordings: items,
      };
    }
    if (action === "get") {
      const targetId = (args && args.recordingId) || "latest";
      let rec = loadRecording(targetId);
      if (!rec && bridge.list().length > 0) {
        try {
          const ext = await bridge.call("browser_record_list", { browser: args && args.browser }, 5000);
          if (ext && ext.lastCompletedRecording) {
            rec = saveRecording(ext.lastCompletedRecording).recording;
          }
        } catch (e) { /* ignore */ }
      }
      if (!rec) {
        return { ok: false, error: "未找到指定的录制记录：" + targetId };
      }
      return {
        ok: true,
        action: "get",
        recordingId: rec.recordingId,
        recording: rec,
      };
    }
    // action === "status"
    let extStatus = null;
    if (bridge.list().length > 0) {
      try {
        extStatus = await bridge.call("browser_record_list", { browser: args && args.browser }, 5000);
        if (extStatus && extStatus.lastCompletedRecording) {
          const existing = loadRecording(extStatus.lastCompletedRecording.recordingId);
          if (!existing) saveRecording(extStatus.lastCompletedRecording);
        }
      } catch (e) { /* ignore */ }
    }
    const recent = listRecordings(5);
    return {
      ok: true,
      action: "status",
      recordingsDir: getRecordingsDir(),
      activeRecording: (extStatus && extStatus.activeRecording) || null,
      latestSaved: recent[0] || null,
      recentRecordings: recent,
    };
  }

  if (name === "browser_record_replay") {
    let rawSteps = Array.isArray(args && args.steps) ? args.steps : null;
    let paramDefs = {};
    let sourceTitle = "";
    if (!rawSteps || !rawSteps.length) {
      const idOrPath = (args && (args.workflowPath || args.recordingId)) || "latest";
      const loaded = loadRecording(idOrPath);
      if (!loaded || !Array.isArray(loaded.steps) || !loaded.steps.length) {
        return {
          ok: false,
          error: "找不到可回放的录制步骤（" + idOrPath + "）。请提供有效的 recordingId、workflowPath 或 steps 数组。",
        };
      }
      rawSteps = loaded.steps;
      paramDefs = loaded.parameters || loaded.suggestedParameters || {};
      sourceTitle = loaded.title || loaded.recordingId || "";
    }
    const interpolated = interpolateSteps(rawSteps, (args && args.vars) || {}, paramDefs);
    const replayRes = await bridge.call("browser_record_replay", Object.assign({}, args, { steps: interpolated }), timeoutMs);
    return Object.assign({
      sourceTitle: sourceTitle || undefined,
      appliedVars: (args && args.vars) || {},
    }, replayRes);
  }

  return bridge.call(name, args, timeoutMs);
}

/* ------------------------------------------------- 访问 Leader 的本地 HTTP */

/**
 * 只访问 127.0.0.1 的 Leader；返回值 { status, json }。
 * 传输失败时抛出带 code 的 Error（ECONNREFUSED 等），供 Follower 判断是否接管。
 */
function leaderRequest(method, pathname, options = {}) {
  const payload = options.body ? Buffer.from(JSON.stringify(options.body)) : null;
  const timeoutMs = Number(options.timeoutMs) || 3000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    const req = http.request({
      host: opts.host,
      port: opts.port,
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
        finish(resolve, { status: res.statusCode, json });
      });
      res.on("error", (e) => finish(reject, e));
    });

    timer = setTimeout(() => {
      try { req.destroy(); } catch (e) { /* ignore */ }
      finish(reject, new BridgeError("LEADER_TIMEOUT", `访问 Leader ${opts.host}:${opts.port} 超时（${timeoutMs} ms）`));
    }, timeoutMs);
    if (timer.unref) timer.unref();

    req.on("error", (e) => finish(reject, e));
    req.end(payload || undefined);
  });
}

async function fetchLeaderStatus(timeoutMs) {
  try {
    const r = await leaderRequest("GET", "/status", { timeoutMs: timeoutMs || STATUS_TIMEOUT_MS });
    if (r.status === 200 && r.json && r.json.server === MARKER) return r.json;
  } catch (e) { /* 端口没监听 / 超时 / 不是本服务 */ }
  return null;
}

async function relayCall(tool, args, timeoutMs) {
  const r = await leaderRequest("POST", "/rpc", {
    body: { tool, args, timeoutMs },
    token: opts.token,
    timeoutMs: Math.min(timeoutMs + 5000, 140000),
  });
  if (r.status === 401) {
    throw new BridgeError("LEADER_UNAUTHORIZED", "Leader 拒绝了本进程的 x-ag-token；请确认两个会话使用同一个 AG_BRIDGE_TOKEN");
  }
  if (r.status === 404) {
    throw new BridgeError("LEADER_GONE", "Leader 的 /rpc 不存在（端口可能已被其他程序占用）");
  }
  if (!r.json) {
    throw new BridgeError("LEADER_BAD_RESPONSE", `Leader 返回 HTTP ${r.status}，内容不是 JSON`);
  }
  if (r.json.ok) return r.json.result;
  throw new BridgeError(r.json.code || "LEADER_ERROR", r.json.error || "Leader 返回失败");
}

async function listClients() {
  if (mode === "follower") {
    const st = await fetchLeaderStatus(1200);
    return st ? (st.clients || []) : [];
  }
  if (bridge && bridge.started) return bridge.list();
  return [];
}

async function waitForAnyClient(ms) {
  const deadline = Date.now() + Math.max(0, ms);
  for (;;) {
    if (bridge && bridge.started && bridge.list().length) return true;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

/* ------------------------------------------------------------ Leader/Follower */

async function tryTakeover(reason) {
  log(`Follower：中继失败（${reason}），尝试接管 ${opts.host}:${opts.port} ...`);
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) await sleep(150);
    const candidate = createBridge();
    try {
      await candidate.start();
      bridge = candidate;
      mode = "leader";
      bridgeError = "";
      leaderInfo = null;
      log(`接管成功：本进程（pid ${process.pid}）成为新 Leader，等待扩展自动重连（最多 ${TAKEOVER_WAIT_MS} ms）`);
      await waitForAnyClient(TAKEOVER_WAIT_MS);
      log("接管完成，后续工具调用由本进程直接执行");
      return true;
    } catch (e) {
      lastError = e;
      const st = await fetchLeaderStatus(800);
      // 只有当 /status 来自「另一个进程」时才认定已被别人接管；
      // 若 pid 仍是刚才那个 Leader，可能只是它正在退出，继续重试绑定。
      if (st && st.pid !== process.pid && (!leaderInfo || st.pid !== leaderInfo.pid)) {
        mode = "follower";
        leaderInfo = st;
        log(`接管未成功：已有新的 Leader（pid ${st.pid}），继续以 Follower 中继`);
        return false;
      }
    }
  }
  throw new BridgeError("TAKEOVER_FAILED", `多次尝试接管 ${opts.host}:${opts.port} 失败：${(lastError && lastError.message) || "未知原因"}`);
}

async function callTool(name, args, timeoutMs) {
  if (mode === "leader") {
    return executeLeaderTool(name, args, timeoutMs);
  }
  if (mode === "follower") {
    try {
      return await relayCall(name, args, timeoutMs);
    } catch (e) {
      if (!isLeaderGone(e)) throw e;
      const tookOver = await tryTakeover(e.code || e.message);
      if (tookOver) return executeLeaderTool(name, args, timeoutMs);
      try {
        return await relayCall(name, args, timeoutMs);
      } catch (e2) {
        throw new BridgeError("LEADER_GONE", `无法连接 Leader：${(e2 && e2.message) || e2}`);
      }
    }
  }
  throw new BridgeError("BRIDGE_UNAVAILABLE", bridgeError || "桥接尚未就绪");
}

/* ------------------------------------------------------------------ 启动 */

async function main() {
  bridge = createBridge();
  try {
    await bridge.start();
    mode = "leader";
    log(`本进程成为 Leader（唯一监听 ${opts.host}:${opts.port} 的桥接中心）`);
  } catch (e) {
    const st = await fetchLeaderStatus(STATUS_TIMEOUT_MS);
    if (st) {
      mode = "follower";
      leaderInfo = st;
      log(`检测到已有 Leader（pid ${st.pid}，${(st.clients || []).length} 个扩展），本进程进入 Follower 模式：工具调用经 POST http://${opts.host}:${opts.port}/rpc 中继`);
    } else {
      mode = "unavailable";
      bridgeError = e.message + "（GET /status 未发现本桥接服务，端口可能被其他程序占用）";
      log("桥接启动失败：" + bridgeError);
      log("MCP 服务仍会继续运行，但每次工具调用都会返回这条错误。");
    }
  }

  log(`MCP 服务就绪（pid ${process.pid}，mode=${mode}），提供 ${TOOLS.length} 个工具，桥接端口 ${opts.port}`);

  if (mode === "leader") {
    setTimeout(() => {
      if (bridge && bridge.started && bridge.list().length === 0) {
        log("提示：还没有浏览器扩展连接。可用 browser_launch 启动 Edge，或在 Edge/Chrome 里加载 extension 目录；扩展弹窗端口应为 " + opts.port);
      }
    }, 8000).unref();
  }
}

const readyPromise = main().catch((e) => {
  mode = "unavailable";
  bridgeError = (e && e.message) || String(e);
  log("初始化异常：" + bridgeError);
});

/* ------------------------------------------------------------------ 工具 */

async function handleBrowserLaunch(id, args) {
  let result;
  try {
    result = await runBrowserLaunch(args, { rootDir: ROOT, port: opts.port, listClients });
  } catch (e) {
    result = { ok: false, stage: "error", code: (e && e.code) || "LAUNCH_ERROR", error: (e && e.message) || String(e) };
  }
  if (mode === "unavailable" && result && result.ok === false) {
    result.bridgeMode = mode;
    result.bridgeError = bridgeError;
    if (result.stage === "launched-without-extension" && result.message) {
      result.message += " 另外，本地桥接端口当前不可用：" + bridgeError;
    }
  }
  reply(id, { content: toContent(result), isError: result.ok === false });
}

async function handleToolCall(id, params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  const tool = findTool(name);
  if (!tool) {
    return reply(id, { content: [{ type: "text", text: "未知工具：" + name }], isError: true });
  }

  // browser_launch 完全由本地进程执行：不经过扩展，也不经过 Leader 中继。
  if (name === "browser_launch") {
    return await handleBrowserLaunch(id, args);
  }

  if (mode === "unavailable") {
    return reply(id, {
      content: [{ type: "text", text: "桥接不可用：" + bridgeError }],
      isError: true,
    });
  }

  try {
    const result = await callTool(name, args, timeoutFor(name, args));
    auditBlocked(name, args, result);
    // 扩展返回 ok:false 时（元素找不到、等待超时、密码框拒绝、无进展熔断等）统一按错误上报，
    // 让调用方能靠 isError 判断，不必再去解析正文。
    const failed = !!(result && typeof result === "object" && result.ok === false);
    reply(id, { content: toContent(result), isError: failed });
  } catch (e) {
    const code = e instanceof BridgeError ? e.code : ((e && e.code) || "ERROR");
    let hint = "";
    if (code === "NO_EXTENSION") {
      hint = `\n\n排查顺序：1) 先调用 browser_launch（browser="edge"）启动并等待扩展握手；2) 确认 Edge/Chrome 已加载并启用「antigravity浏览器控制」扩展（品牌：谷谷嘎嘎）；3) 打开扩展弹窗确认端口是 ${opts.port} 且状态为「已连接本地 MCP 服务」；4) 点弹窗里的「重连」。`;
    } else if (code === "TIMEOUT") {
      hint = "\n\n可以先用 browser_status 确认连接是否还在，或改用 browser_snapshot 重新读取页面状态。";
    } else if (code === "TAKEOVER_FAILED" || code === "LEADER_GONE") {
      hint = "\n\nLeader 已退出且端口接管失败；请确认没有其他程序占用 " + opts.port + "，再重试这次调用。";
    }
    reply(id, {
      content: [{ type: "text", text: `执行失败（${code}）：${e.message}${hint}` }],
      isError: true,
    });
  }
}

async function handleMessage(msg) {
  await readyPromise;

  const id = msg && msg.id;
  const method = msg && msg.method;
  const params = (msg && msg.params) || {};
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case "initialize": {
        let modeNote;
        if (mode === "follower") {
          modeNote = `当前会话是 Follower：工具调用自动中继到本机 Leader（pid ${leaderInfo && leaderInfo.pid}），多开窗口无需关心端口占用。`;
        } else if (mode === "leader") {
          modeNote = `当前会话是 Leader，独占 127.0.0.1:${opts.port}；其他会话会自动中继到本进程。`;
        } else {
          modeNote = "当前会话未获得本地桥接端口：" + bridgeError;
        }
        return reply(id, {
          protocolVersion: params.protocolVersion || "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            "本服务把浏览器控制权交给本机已安装的「antigravity浏览器控制」扩展（品牌：谷谷嘎嘎），直接操作用户日常在用的 Edge/Chrome（保留登录态）。" +
            "默认优先控制 Edge：先 browser_launch（browser=\"edge\"，必要时 profileDirectory / url）确保浏览器与扩展就绪，" +
            "再 browser_status 确认连接，然后 browser_snapshot 拿确定性 ref，执行 browser_click / browser_type，最后再 snapshot 验证结果。" +
            "控制默认发生在当前窗口内的「谷谷嘎嘎控制中」紫色标签组（leaseTab），会激活该标签页以便用户看到鼠标与原生提示条；用户原标签页保持打开且不被改写，需要指定其他标签时显式传 tabId。" +
            modeNote +
            "控制类工具首次触达专属标签页时会自动附加 CDP，浏览器会在该标签页显示标准调试提示条（扩展名已设为「谷谷嘎嘎正在控制你的浏览器」），并在页面内显示常驻可见鼠标；不再额外绘制页面顶栏。" +
            "鼠标层 pointer-events:none，不挡用户或页面的点击。提示条由浏览器原生控件管理，扩展无法改写它的模板文案或关闭按钮。",
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
      case "notifications/roots/list_changed":
        return;
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, {
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        });
      case "tools/call":
        return await handleToolCall(id, params);
      case "resources/list":
        return reply(id, { resources: [] });
      case "resources/templates/list":
        return reply(id, { resourceTemplates: [] });
      case "prompts/list":
        return reply(id, { prompts: [] });
      case "logging/setLevel":
        return reply(id, {});
      default:
        if (isNotification) return;
        return replyError(id, -32601, "Method not found: " + method);
    }
  } catch (e) {
    if (isNotification) {
      log("通知处理出错：" + ((e && e.message) || e));
      return;
    }
    replyError(id, -32603, (e && e.message) || String(e));
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch (e) {
    log("收到无法解析的行：" + s.slice(0, 200));
    return;
  }
  handleMessage(msg);
});

function shutdown(reason) {
  log("退出：" + reason);
  if (bridge) bridge.stop();
  process.exit(0);
}

rl.on("close", () => shutdown("stdin 已关闭"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (e) => log("未捕获异常：" + ((e && e.stack) || e)));
