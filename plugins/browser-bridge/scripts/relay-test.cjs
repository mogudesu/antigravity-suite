#!/usr/bin/env node
"use strict";

/**
 * Leader/Follower 双进程实测：
 *   1) 启动 A（Leader，监听 127.0.0.1:PORT）与 B（Follower，端口被占 -> 走 /rpc 中继）；
 *   2) 两个进程都执行 MCP initialize / tools/list；
 *   3) 模拟扩展只连 Leader，验证 B 的工具调用确实由 Leader 执行；
 *   4) 杀掉 Leader，模拟扩展自动重连，B 下次调用时接管端口并升级为新 Leader。
 *
 * 默认端口 8765（与正式配置一致）。若 8765 被其他程序占用，用 AG_RELAY_TEST_PORT 指定测试端口：
 *   set AG_RELAY_TEST_PORT=8773 && node scripts/relay-test.cjs
 */

const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const readline = require("readline");
const WebSocket = require("ws");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "mcp-server", "server.js");
const PORT = Number(process.env.AG_RELAY_TEST_PORT || process.env.AG_BRIDGE_PORT || 8765);
const MARKER = "antigravity-browser-bridge";
const HOST = "127.0.0.1";

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (detail ? "  —— " + detail : "")); }
}
function section(t) { console.log("\n" + t); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, timeoutMs = 8000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(stepMs);
  }
  return fn();
}

/* ------------------------------------------------------------- MCP 客户端 */

class McpClient {
  constructor(label, env) {
    this.label = label;
    this.child = spawn(process.execPath, [SERVER], {
      env: Object.assign({}, process.env, env || {}),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.pending = new Map();
    this.nextId = 1;
    this.badLines = [];
    this.stderr = [];
    this.exited = new Promise((resolve) => this.child.once("exit", (code) => resolve(code)));
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
  request(method, params, timeoutMs = 20000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label} MCP 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  close() {
    try { this.child.stdin.end(); } catch (e) { /* ignore */ }
    try { this.child.kill(); } catch (e) { /* ignore */ }
  }
}

function textOf(res) {
  const c = res && res.result && res.result.content;
  if (!Array.isArray(c)) return "";
  return c.filter((x) => x.type === "text").map((x) => x.text).join("\n");
}

/* ------------------------------------------------------- HTTP / 模拟扩展 */

function probePort() {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: "/status", agent: false, timeout: 2000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) { json = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

function getStatus() {
  return probePort();
}

function connectMock(browser, marker, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://" + HOST + ":" + PORT + "/bridge");
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.terminate(); } catch (e) { /* ignore */ }
      reject(new Error("模拟扩展握手超时"));
    }, timeoutMs);
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    };
    ws.on("open", () => {
      ws.send(JSON.stringify({ t: "hello", browser, version: "relay-test-1.0.0", token: "", ua: "mock/" + browser }));
    });
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch (e) { return; }
      if (msg.t === "welcome") return done(null, { ws, browser });
      if (msg.t === "error") return done(new Error(msg.message || "握手被拒绝"));
      if (msg.t === "ping") { ws.send(JSON.stringify({ t: "pong" })); return; }
      if (msg.t === "req") {
        let result;
        if (msg.tool === "browser_status") {
          result = { ok: true, browser, extensionVersion: "relay-test-1.0.0", marker, clients: 1 };
        } else if (msg.tool === "browser_snapshot") {
          result = { ok: true, browser, snapshotId: "relay-snap-1", marker, maxChars: (msg.args && msg.args.maxChars) || null, snapshot: '- button "中继按钮" [ref=e1]' };
        } else {
          result = { ok: false, error: "模拟扩展未实现 " + msg.tool };
        }
        ws.send(JSON.stringify({ t: "res", id: msg.id, ok: result.ok !== false, result }));
      }
    });
    ws.on("error", (e) => done(e));
  });
}

function reconnectMock(browser, marker, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = async () => {
      if (Date.now() > deadline) return reject(new Error("模拟扩展重连超时"));
      try {
        const m = await connectMock(browser, marker, 800);
        return resolve(m);
      } catch (e) {
        await sleep(200);
        return attempt();
      }
    };
    attempt();
  });
}

/* --------------------------------------------------------------- 主流程 */

async function main() {
  console.log(`Leader/Follower 双进程测试（${HOST}:${PORT}）`);

  const pre = await probePort();
  if (pre) {
    if (pre.json && pre.json.server === MARKER) {
      console.error(`端口 ${PORT} 上已有一个本桥接 Leader 在运行，请先关闭它，或用 AG_RELAY_TEST_PORT 换端口。`);
    } else {
      console.error(`端口 ${PORT} 被其他程序占用（HTTP ${pre.status}），请用 AG_RELAY_TEST_PORT 指定测试端口，例如：`);
      console.error(`  set AG_RELAY_TEST_PORT=8773 && node scripts/relay-test.cjs`);
    }
    process.exit(2);
  }

  section("启动 Leader 与 Follower");
  const leader = new McpClient("leader", { AG_BRIDGE_PORT: String(PORT) });
  const leaderReady = await waitUntil(() => leader.stderr.some((l) => l.indexOf("MCP 服务就绪") !== -1), 10000);
  check("Leader 已就绪并监听", leaderReady && leader.stderr.some((l) => l.indexOf("桥接已监听") !== -1), leader.stderr.join(" | "));

  const follower = new McpClient("follower", { AG_BRIDGE_PORT: String(PORT) });
  const followerReady = await waitUntil(() => follower.stderr.some((l) => l.indexOf("MCP 服务就绪") !== -1), 10000);
  check("Follower 已就绪", followerReady, follower.stderr.join(" | "));
  check("Follower 自动进入 Follower 模式", follower.stderr.some((l) => l.indexOf("Follower 模式") !== -1), follower.stderr.join(" | "));
  check("Follower 未出现 LISTEN_FAILED / 启动失败",
    !follower.stderr.some((l) => l.indexOf("LISTEN_FAILED") !== -1 || l.indexOf("桥接启动失败") !== -1),
    follower.stderr.join(" | "));

  section("双进程 MCP initialize / tools/list");
  const leaderInit = await leader.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "relay-leader", version: "1" } });
  const followerInit = await follower.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "relay-follower", version: "1" } });
  check("Leader initialize 成功", leaderInit.result && leaderInit.result.serverInfo && leaderInit.result.serverInfo.name === MARKER, JSON.stringify(leaderInit));
  check("Follower initialize 成功", followerInit.result && followerInit.result.serverInfo && followerInit.result.serverInfo.name === MARKER, JSON.stringify(followerInit));
  check("Leader instructions 标注 Leader", String(leaderInit.result.instructions).indexOf("Leader") !== -1);
  check("Follower instructions 标注 Follower", String(followerInit.result.instructions).indexOf("Follower") !== -1);

  const leaderList = await leader.request("tools/list", {});
  const followerList = await follower.request("tools/list", {});
  check("Leader tools/list 返回 18 个工具", ((leaderList.result && leaderList.result.tools) || []).length === 18);
  check("Follower tools/list 返回 18 个工具", ((followerList.result && followerList.result.tools) || []).length === 18);

  section("GET /status 自述");
  const st = await getStatus();
  check("/status 返回本桥接标识", !!st && st.status === 200 && st.json.server === MARKER && st.json.role === "leader", JSON.stringify(st));
  check("/status pid 指向 Leader 进程", !!st && st.json.pid === leader.child.pid, `status=${st && st.json.pid} leader=${leader.child.pid}`);

  section("Follower 调用经 Leader 执行");
  const mock1 = await connectMock("edge", "LEADER-EXECUTED");
  await waitUntil(() => leader.stderr.some((l) => l.indexOf("扩展已连接") !== -1), 3000);
  check("模拟扩展已连到 Leader", leader.stderr.some((l) => l.indexOf("扩展已连接") !== -1), leader.stderr.join(" | "));

  const viaFollower = await follower.request("tools/call", { name: "browser_status", arguments: { browser: "edge" } });
  check("Follower browser_status 由 Leader 执行", viaFollower.result && viaFollower.result.isError === false &&
    textOf(viaFollower).indexOf("LEADER-EXECUTED") !== -1, textOf(viaFollower));

  const snapViaFollower = await follower.request("tools/call", { name: "browser_snapshot", arguments: { maxChars: 500 } });
  check("Follower 工具参数原样中继", snapViaFollower.result && snapViaFollower.result.isError === false &&
    textOf(snapViaFollower).indexOf('"maxChars": 500') !== -1 && textOf(snapViaFollower).indexOf("relay-snap-1") !== -1,
    textOf(snapViaFollower));

  section("Leader 退出后 Follower 接管");
  leader.close();
  await Promise.race([leader.exited, sleep(5000)]);
  await sleep(400);
  check("Leader 进程已退出", leader.child.exitCode !== null || leader.child.killed, String(leader.child.exitCode));

  const mock2Promise = reconnectMock("edge", "TAKEOVER-EXECUTED", 15000);
  const afterKill = await follower.request("tools/call", { name: "browser_status", arguments: { browser: "edge" } }, 30000);
  const mock2 = await mock2Promise;
  check("Follower 接管后工具调用成功", afterKill.result && afterKill.result.isError === false &&
    textOf(afterKill).indexOf("TAKEOVER-EXECUTED") !== -1, textOf(afterKill));
  check("Follower 日志记录接管成功", follower.stderr.some((l) => l.indexOf("接管成功") !== -1) &&
    follower.stderr.some((l) => l.indexOf("成为新 Leader") !== -1), follower.stderr.join(" | "));
  check("接管过程中仍未出现 LISTEN_FAILED", !follower.stderr.some((l) => l.indexOf("LISTEN_FAILED") !== -1), follower.stderr.join(" | "));

  const st2 = await getStatus();
  check("接管后 /status 的 pid 是 Follower 进程", !!st2 && st2.status === 200 && st2.json.pid === follower.child.pid,
    `status=${st2 && st2.json.pid} follower=${follower.child.pid}`);

  const followerList2 = await follower.request("tools/list", {});
  check("接管后 tools/list 仍为 18 个", ((followerList2.result && followerList2.result.tools) || []).length === 18);

  const listenFailedCount = leader.stderr.concat(follower.stderr).filter((l) => l.indexOf("LISTEN_FAILED") !== -1).length;
  check("双进程全程零 LISTEN_FAILED", listenFailedCount === 0, String(listenFailedCount));

  mock1.ws.close();
  if (mock2) mock2.ws.close();
  follower.close();
  await sleep(300);

  console.log("\n结果：" + passed + " 通过 / " + failed + " 失败（端口 " + PORT + "）");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("测试异常终止：" + ((e && e.stack) || e));
  process.exit(1);
});
