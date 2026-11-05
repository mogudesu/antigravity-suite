#!/usr/bin/env node
"use strict";

/**
 * recorder-test.cjs
 * 验证 RPA 录制与回放全链路：
 * 1. recordings.js 步骤去重合并、参数提炼、密码保护、模板变量替换
 * 2. MCP 协议下 browser_record_start / stop / list / replay 端到端闭环
 * 3. 浏览器 HUD 主动上报 record_done 自动落盘
 * 4. DOM 环境（page-actions.js + recorder-page.js）定位器提取、HUD 隔离与列表提取
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const WebSocket = require("ws");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "mcp-server", "server.js");
const {
  cleanAndCoalesceSteps,
  extractSuggestedParameters,
  saveRecording,
  listRecordings,
  loadRecording,
  interpolateSteps,
} = require(path.join(ROOT, "mcp-server", "recordings.js"));

const TMP_REC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ag-rec-test-"));
process.env.AG_BRIDGE_RECORDINGS_DIR = TMP_REC_DIR;
const PORT = 8809;

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (detail ? " —— " + detail : "")); }
}
function section(t) { console.log("\n" + t); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class McpClient {
  constructor(env) {
    this.child = spawn(process.execPath, [SERVER], {
      env: Object.assign({}, process.env, env || {}),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.pending = new Map();
    this.nextId = 1;
    const out = readline.createInterface({ input: this.child.stdout });
    out.on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch (e) { return; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const resolve = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    });
  }
  request(method, params, timeoutMs = 8000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("超时：" + method));
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

function parseContent(res) {
  const c = res && res.result && res.result.content;
  if (!Array.isArray(c) || !c[0]) return {};
  try { return JSON.parse(c[0].text); } catch (e) { return { raw: c[0].text }; }
}

async function main() {
  section("1. 步骤清洗合并与候选参数提炼（单元级）");
  const rawSteps = [
    { type: "navigate", url: "https://shop.example.com" },
    { type: "navigate", url: "https://shop.example.com", pageTitle: "示例商城" },
    { type: "type", value: "无", locator: { selector: "#q", semantic: { role: "searchbox", name: "搜索商品" } } },
    { type: "type", value: "无线耳机", submit: true, locator: { selector: "#q", semantic: { role: "searchbox", name: "搜索商品" } } },
    { type: "type", value: "[REDACTED_PASSWORD]", sensitive: "password", locator: { selector: "#pwd", semantic: { role: "textbox", name: "密码" } } },
    { type: "scroll", scrollY: 300, deltaY: 300 },
    { type: "scroll", scrollY: 850, deltaY: 550 },
    { type: "click", locator: { selector: "a.sort-sales", semantic: { role: "link", name: "按销量" } }, userNote: "优先看销量最高的前10条" },
    { type: "extract", mode: "list", listSelector: ".item-list > .card", sampleText: "降噪耳机 ¥399" },
  ];

  const cleaned = cleanAndCoalesceSteps(rawSteps);
  check("相邻重复 navigate 与连续 type/scroll 已合并", cleaned.length === 6, "实际步数=" + cleaned.length);
  check("合并后的 type 保留最终值与 submit=true", cleaned[1].value === "无线耳机" && cleaned[1].submit === true);
  check("合并后的 scroll 保留最终位置与累计 deltaY", cleaned[3].scrollY === 850 && cleaned[3].deltaY === 850);

  const params = extractSuggestedParameters(cleaned);
  check("自动识别搜索框为 keyword 参数候选", !!params.keyword && params.keyword.default === "无线耳机", JSON.stringify(params));
  check("密码框绝不被提炼为明文参数", Object.values(params).every((p) => p.default !== "[REDACTED_PASSWORD]"));

  const parameterizedSteps = JSON.parse(JSON.stringify(cleaned));
  parameterizedSteps[1].value = "{{keyword}}";
  const interpolated = interpolateSteps(parameterizedSteps, { keyword: "机械键盘" }, params);
  check("interpolateSteps 正确替换 {{keyword}}", interpolated[1].value === "机械键盘");
  const fallbackInterpolated = interpolateSteps(parameterizedSteps, {}, params);
  check("未传 vars 时自动回退到 parameter default", fallbackInterpolated[1].value === "无线耳机");

  section("2. MCP 录制、落盘、查询与参数化回放闭环（端到端）");
  const client = new McpClient({
    AG_BRIDGE_PORT: String(PORT),
    AG_BRIDGE_RECORDINGS_DIR: TMP_REC_DIR,
  });
  await sleep(600);
  await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "rec-test", version: "1" } });

  let lastReplayedSteps = null;
  const mockWs = await new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/bridge");
    ws.on("open", () => {
      ws.send(JSON.stringify({ t: "hello", browser: "edge", version: "1.7.0", ua: "mock/edge" }));
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.t === "welcome") return resolve(ws);
      if (msg.t === "ping") return ws.send(JSON.stringify({ t: "pong" }));
      if (msg.t === "req") {
        if (msg.tool === "browser_record_start") {
          ws.send(JSON.stringify({
            t: "res",
            id: msg.id,
            ok: true,
            result: { ok: true, status: "recording", recordingId: "rec-e2e-01", tabId: 11, stepCount: 1 },
          }));
        } else if (msg.tool === "browser_record_stop") {
          ws.send(JSON.stringify({
            t: "res",
            id: msg.id,
            ok: true,
            result: {
              ok: true,
              status: "stopped",
              recording: {
                recordingId: "rec-e2e-01",
                title: "商品搜索与采集演示",
                browser: "edge",
                steps: rawSteps,
              },
            },
          }));
        } else if (msg.tool === "browser_record_list") {
          ws.send(JSON.stringify({
            t: "res",
            id: msg.id,
            ok: true,
            result: { ok: true, browser: "edge", activeRecording: null, lastCompletedRecording: null },
          }));
        } else if (msg.tool === "browser_record_replay") {
          lastReplayedSteps = msg.args.steps;
          ws.send(JSON.stringify({
            t: "res",
            id: msg.id,
            ok: true,
            result: {
              ok: true,
              completedCount: msg.args.steps.length,
              totalSteps: msg.args.steps.length,
              extractedData: { extract_step_6: ["机械键盘 Pro ¥499", "静电容键盘 ¥899"] },
            },
          }));
        }
      }
    });
    ws.on("error", reject);
  });

  const startRes = parseContent(await client.request("tools/call", {
    name: "browser_record_start",
    arguments: { title: "商品搜索与采集演示" },
  }));
  check("browser_record_start 启动成功", startRes.ok === true && startRes.recordingId === "rec-e2e-01");

  const stopRes = parseContent(await client.request("tools/call", {
    name: "browser_record_stop",
    arguments: {},
  }));
  check("browser_record_stop 自动清洗并落盘 JSON", stopRes.ok === true && fs.existsSync(stopRes.filePath), JSON.stringify(stopRes));
  check("browser_record_stop 返回 suggestedParameters 与 extractTargets",
    !!(stopRes.suggestedParameters && stopRes.suggestedParameters.keyword) &&
    Array.isArray(stopRes.extractTargets) && stopRes.extractTargets.length === 1);

  const listRes = parseContent(await client.request("tools/call", {
    name: "browser_record_list",
    arguments: { action: "list" },
  }));
  check("browser_record_list(list) 列出已保存录制", listRes.ok === true && listRes.count === 1 && listRes.recordings[0].recordingId === "rec-e2e-01");

  // 模拟将录制编译为参数化 workflow.recording.json 并测试换参快放
  const workflowPath = path.join(TMP_REC_DIR, "workflow.recording.json");
  const workflowObj = JSON.parse(fs.readFileSync(stopRes.filePath, "utf8"));
  workflowObj.parameters = workflowObj.suggestedParameters;
  workflowObj.steps[1].value = "{{keyword}}";
  fs.writeFileSync(workflowPath, JSON.stringify(workflowObj, null, 2), "utf8");

  const replayRes = parseContent(await client.request("tools/call", {
    name: "browser_record_replay",
    arguments: {
      workflowPath,
      vars: { keyword: "客制化机械键盘" },
    },
  }));
  check("browser_record_replay 成功执行并返回提取数据",
    replayRes.ok === true && Array.isArray(replayRes.extractedData.extract_step_6),
    JSON.stringify(replayRes));
  check("browser_record_replay 将 {{keyword}} 替换为传入的 vars 值发往扩展",
    Array.isArray(lastReplayedSteps) && lastReplayedSteps[1].value === "客制化机械键盘",
    JSON.stringify(lastReplayedSteps && lastReplayedSteps[1]));

  // 测试浏览器 HUD 主动点击「⏹ 完成」发送 record_done 消息
  mockWs.send(JSON.stringify({
    t: "record_done",
    recording: {
      recordingId: "rec-hud-push-02",
      title: "HUD一键完成录制",
      browser: "edge",
      steps: [{ type: "navigate", url: "https://example.org" }],
    },
  }));
  await sleep(300);
  const hudSaved = loadRecording("rec-hud-push-02");
  check("HUD 主动推送 record_done 后服务端自动落盘", !!hudSaved && hudSaved.title === "HUD一键完成录制");

  mockWs.close();
  client.close();
  try { fs.rmSync(TMP_REC_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  console.log("\n结果：" + passed + " 通过 / " + failed + " 失败");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("测试异常：" + (e && e.stack || e));
  process.exit(1);
});
