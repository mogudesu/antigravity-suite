#!/usr/bin/env node
"use strict";

/**
 * 独立无头双轨引擎端到端测试：
 *   - 默认 isolated 模式启动无头 Edge/Chrome（零黄条、不抢焦点）
 *   - 双会话并发隔离（subagent-a & subagent-b 经 Leader / Follower 同时跑独立页面）
 *   - iframe + open Shadow DOM 穿透快照与 ref 点击
 *   - 密码与敏感输入框拦截 + 中文输入 + Control+a 组合键
 *   - selector 容器精确滚动（browser_scroll）
 *   - 尺寸受控 JPEG 无头截图
 *   - browser_auth_sync export/status/import 闭环
 */

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "mcp-server", "server.js");
const BRIDGE_PORT = 8812;

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (detail ? "  —— " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class McpClient {
  constructor(env) {
    this.child = spawn(process.execPath, [SERVER], {
      env: Object.assign({}, process.env, env || {}),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = [];
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const res = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        res(msg);
      }
    });
    readline.createInterface({ input: this.child.stderr }).on("line", (l) => this.stderr.push(l));
  }
  request(method, params, timeoutMs = 45000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("MCP timeout: " + method));
      }, timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  close() {
    try { this.child.stdin.end(); } catch {}
    try { this.child.kill(); } catch {}
  }
}

function parseTool(res) {
  const txt = ((res && res.result && res.result.content) || []).find((c) => c.type === "text")?.text || "{}";
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

function startFixtureServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === "/frame.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(`<!doctype html><html><body>
          <button id="iframe-btn" onclick="document.body.dataset.fclicked='yes'">Iframe按钮</button>
        </body></html>`);
      }
      if (req.url === "/page-b.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(`<!doctype html><html><title>Session Beta Page</title><body>
          <h1>Beta 页面</h1>
          <input id="beta-input" type="text" placeholder="Beta输入框">
        </body></html>`);
      }
      if (req.url === "/captcha") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(`<!doctype html><html><title>Just a moment...</title><body>
          <div class="cf-turnstile">请完成安全验证</div>
        </body></html>`);
      }
      if (req.url === "/private") {
        res.writeHead(302, { Location: "/login" });
        return res.end("");
      }
      if (req.url === "/login") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(`<!doctype html><html><title>Sign In</title><body><h1>Please log in</h1></body></html>`);
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><title>Session Alpha Page</title>
        <style>#scrollbox{height:120px;overflow:auto;border:1px solid #ccc;} .tall{height:800px;}</style>
        <body>
          <h1>Alpha 主页</h1>
          <input id="kw" type="text" placeholder="搜索关键词">
          <input id="pwd" type="password" placeholder="密码">
          <div id="shadow-host"></div>
          <iframe src="/frame.html" title="内嵌框"></iframe>
          <div id="scrollbox"><div class="tall">长内容列表</div></div>
          <script>
            const host = document.getElementById('shadow-host');
            const sr = host.attachShadow({ mode: 'open' });
            sr.innerHTML = '<button id="shadow-btn">Shadow按钮</button><div id="shadow-status">idle</div>';
            sr.getElementById('shadow-btn').onclick = () => { sr.getElementById('shadow-status').textContent = 'shadow-clicked'; };
          </script>
        </body></html>`);
    });
    srv.listen(0, "127.0.0.1", () => {
      resolve({ srv, port: srv.address().port });
    });
  });
}

async function main() {
  const { srv, port } = await startFixtureServer();
  const baseUrl = `http://127.0.0.1:${port}`;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agbb-iso-"));
  const tmpProfile = path.join(tmpRoot, "profile");
  const leader = new McpClient({ AG_BRIDGE_PORT: String(BRIDGE_PORT), AG_BRIDGE_PROFILE_DIR: tmpProfile });
  await sleep(600);
  const follower = new McpClient({ AG_BRIDGE_PORT: String(BRIDGE_PORT), AG_BRIDGE_PROFILE_DIR: tmpProfile });
  await sleep(600);

  try {
    console.log("\n1. 默认 isolated 模式无头启动（Leader & Follower 自动隔离会话）");
    const launchA = await leader.request("tools/call", { name: "browser_launch", arguments: { browser: "edge", url: baseUrl + "/" } });
    const dataA = parseTool(launchA);
    check("Leader 无头启动成功 (mode=isolated, headless=true, instanceReused=false)",
      dataA.ok === true && dataA.mode === "isolated" && dataA.headless === true && dataA.instanceReused === false, JSON.stringify(dataA));

    const relaunchA = await leader.request("tools/call", { name: "browser_launch", arguments: { browser: "edge" } });
    const relaunchDataA = parseTool(relaunchA);
    check("重复后台 browser_launch 复用实例并标记 instanceReused=true",
      relaunchDataA.ok === true && relaunchDataA.mode === "isolated" && relaunchDataA.headless === true && relaunchDataA.instanceReused === true, JSON.stringify(relaunchDataA));

    const openB = await follower.request("tools/call", { name: "browser_open", arguments: { url: baseUrl + "/page-b.html" } });
    const dataB = parseTool(openB);
    check("Follower 并发打开不同页面成功且获得独立 sessionId", dataB.ok === true && dataB.sessionId !== dataA.sessionId && dataB.url.includes("/page-b.html"), JSON.stringify(dataB));

    const statusA = parseTool(await leader.request("tools/call", { name: "browser_status", arguments: {} }));
    check("Leader 页面未受 Follower 导航覆盖", statusA.activeTab && !statusA.activeTab.url.includes("/page-b.html"), JSON.stringify(statusA));

    console.log("\n2. iframe + Shadow DOM 穿透快照与交互");
    const snap = parseTool(await leader.request("tools/call", { name: "browser_snapshot", arguments: {} }));
    check("快照穿透 open Shadow DOM ([shadow])", snap.snapshot && snap.snapshot.includes("[shadow]") && snap.snapshot.includes("Shadow按钮"), snap.snapshot);
    check("快照穿透 iframe ([frame src=...])", snap.snapshot && snap.snapshot.includes("Iframe按钮"), snap.snapshot);

    const shadowRef = (snap.snapshot.match(/- button "Shadow按钮" \[ref=(e\d+)\]/) || [])[1];
    check("拿到 Shadow DOM 元素 ref", !!shadowRef, snap.snapshot);
    const clickShadow = parseTool(await leader.request("tools/call", { name: "browser_click", arguments: { ref: shadowRef } }));
    check("通过 ref 点击 Shadow DOM 内按钮成功", clickShadow.ok === true, JSON.stringify(clickShadow));

    console.log("\n3. 中文输入 + 组合键 Control+a + 密码拦截");
    const typeOk = parseTool(await leader.request("tools/call", { name: "browser_type", arguments: { selector: "#kw", text: "测试中文IME" } }));
    check("中文输入成功", typeOk.ok === true && typeOk.value.includes("测试中文IME"), JSON.stringify(typeOk));

    const pwdBlock = await leader.request("tools/call", { name: "browser_type", arguments: { selector: "#pwd", text: "123456" } });
    const pwdData = parseTool(pwdBlock);
    check("密码输入框自动拦截 (blocked=password-field)", pwdBlock.result.isError === true && pwdData.blocked === "password-field", JSON.stringify(pwdData));

    await leader.request("tools/call", { name: "browser_press", arguments: { selector: "#kw", key: "Control+a" } });
    await leader.request("tools/call", { name: "browser_press", arguments: { key: "Backspace" } });
    const afterClr = parseTool(await leader.request("tools/call", { name: "browser_evaluate", arguments: { expression: "document.getElementById('kw').value" } }));
    check("Control+a + Backspace 组合键清空生效", afterClr.ok === true && afterClr.value === "", JSON.stringify(afterClr));

    console.log("\n4. 指定容器滚动 browser_scroll(selector) & 无头截图尺寸受控");
    const sc = parseTool(await leader.request("tools/call", { name: "browser_scroll", arguments: { selector: "#scrollbox", direction: "down", amount: 240 } }));
    check("browser_scroll 精确滚动 #scrollbox 容器", sc.ok === true && sc.container === true && sc.scrollTop > 0, JSON.stringify(sc));

    const shot = await leader.request("tools/call", { name: "browser_screenshot", arguments: { format: "jpeg" } });
    const imgBlock = (shot.result && shot.result.content || []).find((c) => c.type === "image");
    check("无头截图返回 JPEG 且头字节合法", !!imgBlock && imgBlock.mimeType === "image/jpeg" && Buffer.from(imgBlock.data, "base64").slice(0, 2).toString("hex") === "ffd8");

    console.log("\n5. browser_auth_sync 登录态导出/状态查询/导入");
    const exp = parseTool(await leader.request("tools/call", { name: "browser_auth_sync", arguments: { action: "export", name: "test-auth" } }));
    check("导出 storageState 成功", exp.ok === true && fs.existsSync(exp.filePath), JSON.stringify(exp));
    const st = parseTool(await leader.request("tools/call", { name: "browser_auth_sync", arguments: { action: "status" } }));
    check("status 列出已保存档案 test-auth", st.ok === true && Array.isArray(st.savedProfiles) && st.savedProfiles.includes("test-auth"), JSON.stringify(st));
    const imp = parseTool(await leader.request("tools/call", { name: "browser_auth_sync", arguments: { action: "import", cookies: [{ name: "ag_test", value: "1", url: baseUrl }] } }));
    check("导入测试 Cookie 成功", imp.ok === true && imp.importedCookies === 1, JSON.stringify(imp));

    console.log("\n6. 导航失败 / 验证码 / 登录失效边界（不自动弹可见窗）");
    const capRes = parseTool(await follower.request("tools/call", { name: "browser_open", arguments: { url: baseUrl + "/captcha" } }));
    check("遇到验证码返回 pending_captcha 且不自动弹窗",
      capRes.ok === true && capRes.status === "pending_captcha" && capRes.requiresUserAction === true && capRes.autoOpenedAuthWindow === false,
      JSON.stringify(capRes));
    const authRes = parseTool(await follower.request("tools/call", { name: "browser_open", arguments: { url: baseUrl + "/private" } }));
    check("登录失效跳转返回 awaiting_user_login 且不自动弹窗",
      authRes.ok === true && authRes.status === "awaiting_user_login" && authRes.autoOpenedAuthWindow === false,
      JSON.stringify(authRes));
    const navFail = await follower.request("tools/call", { name: "browser_open", arguments: { url: "http://127.0.0.1:1/unreachable" } });
    const navFailData = parseTool(navFail);
    check("普通导航失败返回 NAVIGATION_FAILED 且不切可见模式",
      navFail.result && navFail.result.isError === true && navFailData.code === "NAVIGATION_FAILED" && navFailData.autoOpenedAuthWindow === false && navFailData.switchedEngine === false,
      JSON.stringify(navFailData));
    const authWinCheck = parseTool(await follower.request("tools/call", { name: "browser_open_auth_window", arguments: { action: "status" } }));
    check("异常后未自动拉起认证窗口", authWinCheck.authWindowOpen === false, JSON.stringify(authWinCheck));

    console.log("\n7. 可见实例冲突检查（MODE_CONFLICT，不关闭其他任务窗口）");
    const { IsolatedEngine } = require(path.join(ROOT, "mcp-server", "isolated-engine.js"));
    const conflictEng = new IsolatedEngine({ profileDir: path.join(tmpRoot, "conflict-prof") });
    let closedCalled = false;
    conflictEng.context = { pages: () => [], close: async () => { closedCalled = true; } };
    conflictEng.headless = false;
    conflictEng.ensureSession("vis-owner").explicitVisible = true;
    let conflictErr = null;
    try { await conflictEng.browser_launch({ headless: true, sessionId: "bg-worker" }); } catch (e) { conflictErr = e; }
    check("已有可见实例时请求 headless:true 返回 MODE_CONFLICT",
      !!conflictErr && conflictErr.code === "MODE_CONFLICT" && conflictErr.payload && conflictErr.payload.currentHeadless === false && conflictErr.payload.requestedHeadless === true && !closedCalled,
      conflictErr ? JSON.stringify(conflictErr.payload || conflictErr.message) : "未抛错");
    let bgOpenErr = null;
    try { await conflictEng.browser_open({ url: baseUrl + "/", sessionId: "bg-worker" }); } catch (e) { bgOpenErr = e; }
    check("已有可见实例时后台 session browser_open 不得复用可见实例",
      !!bgOpenErr && bgOpenErr.code === "MODE_CONFLICT" && !closedCalled,
      bgOpenErr ? bgOpenErr.code : "未抛错");
    conflictEng.context = null;
    conflictEng.authWindowContext = { close: async () => { closedCalled = true; } };
    let authConflictErr = null;
    try { await conflictEng.ensureLaunched({ sessionId: "bg-worker" }); } catch (e) { authConflictErr = e; }
    check("认证窗口开启时后台请求返回 MODE_CONFLICT (awaiting_auth_window)",
      !!authConflictErr && authConflictErr.code === "MODE_CONFLICT" && authConflictErr.payload && authConflictErr.payload.status === "awaiting_auth_window" && !closedCalled,
      authConflictErr ? JSON.stringify(authConflictErr.payload || authConflictErr.message) : "未抛错");
  } finally {
    follower.close();
    leader.close();
    srv.close();
    await sleep(500);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }

  console.log(`\nisolated-test 结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("isolated-test 异常：", e);
  process.exit(1);
});
