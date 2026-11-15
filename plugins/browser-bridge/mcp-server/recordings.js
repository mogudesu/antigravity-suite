"use strict";

/**
 * recordings.js
 * 负责 RPA 录制轨迹的清洗合并、候选参数提炼、本地落盘、历史列表查询，以及回放时的 {{变量}} 模板注入。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

function getRecordingsDir() {
  return process.env.AG_BRIDGE_RECORDINGS_DIR ||
    path.join(os.homedir(), ".gemini", "memory", "browser-bridge", "recordings");
}

function resolveReal(p) {
  const abs = path.resolve(String(p || ""));
  try { return fs.realpathSync(abs); } catch (e) {
    const parent = path.dirname(abs);
    try { return path.join(fs.realpathSync(parent), path.basename(abs)); } catch (e2) { return abs; }
  }
}

function canonicalInside(baseDir, targetPath) {
  if (!baseDir || !targetPath) return false;
  const base = resolveReal(baseDir);
  const target = resolveReal(targetPath);
  const rel = process.platform === "win32"
    ? path.relative(base.toLowerCase(), target.toLowerCase())
    : path.relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function sanitizeId(id) {
  return String(id || "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * 清洗并合并相邻冗余步骤：
 * 1. 相邻相同 URL 的 navigate 去重
 * 2. 同一输入框连续多次 type 合并为最后一次（保留 submit 标记）
 * 3. 相邻多次 scroll 合并为最终位置
 */
function cleanAndCoalesceSteps(rawSteps) {
  if (!Array.isArray(rawSteps)) return [];
  const out = [];

  for (let i = 0; i < rawSteps.length; i++) {
    const cur = Object.assign({}, rawSteps[i]);
    if (!cur || !cur.type) continue;
    const prev = out.length ? out[out.length - 1] : null;

    if (cur.type === "navigate" && prev && prev.type === "navigate" && prev.url === cur.url) {
      if (cur.pageTitle && !prev.pageTitle) prev.pageTitle = cur.pageTitle;
      if (cur.userNote) prev.userNote = prev.userNote ? (prev.userNote + "；" + cur.userNote) : cur.userNote;
      continue;
    }

    if (
      cur.type === "type" &&
      prev &&
      prev.type === "type" &&
      prev.locator &&
      cur.locator &&
      prev.locator.selector === cur.locator.selector &&
      !prev.submit
    ) {
      prev.value = cur.value;
      prev.at = cur.at || prev.at;
      if (cur.submit) prev.submit = true;
      if (cur.userNote) prev.userNote = prev.userNote ? (prev.userNote + "；" + cur.userNote) : cur.userNote;
      continue;
    }

    if (cur.type === "scroll" && prev && prev.type === "scroll") {
      prev.scrollY = cur.scrollY;
      prev.deltaY = (prev.deltaY || 0) + (cur.deltaY || 0);
      prev.amount = Math.abs(prev.deltaY);
      prev.direction = prev.deltaY >= 0 ? "down" : "up";
      prev.at = cur.at || prev.at;
      if (cur.userNote) prev.userNote = prev.userNote ? (prev.userNote + "；" + cur.userNote) : cur.userNote;
      continue;
    }

    out.push(cur);
  }

  return out.map((s, idx) => Object.assign({}, s, { index: idx + 1 }));
}

/**
 * 从录制步骤中自动识别可参数化的输入变量候选，辅助 Agent 快速生成参数化 Skill。
 */
function extractSuggestedParameters(steps) {
  const params = {};
  let inputCounter = 1;

  for (const s of (steps || [])) {
    if (s.type === "type" && s.value && s.value !== "[REDACTED_PASSWORD]" && !s.sensitive) {
      const sem = (s.locator && s.locator.semantic) || {};
      const isSearch = sem.role === "searchbox" || /search|搜索|关键词|query|keyword/i.test((sem.name || "") + " " + (sem.placeholder || ""));
      const key = isSearch && !params.keyword ? "keyword" : ("input_" + (inputCounter++));
      params[key] = {
        stepIndex: s.index,
        type: "string",
        default: s.value,
        description: sem.name || sem.placeholder || ("第 " + s.index + " 步输入内容"),
      };
    } else if (s.type === "select" && (s.value || s.label)) {
      const sem = (s.locator && s.locator.semantic) || {};
      const key = "select_" + (inputCounter++);
      params[key] = {
        stepIndex: s.index,
        type: "string",
        default: s.label || s.value,
        description: sem.name || ("第 " + s.index + " 步下拉选择项"),
      };
    }
  }
  return params;
}

function saveRecording(rawRecording, opts = {}) {
  if (!rawRecording || typeof rawRecording !== "object") {
    throw new Error("无效的录制数据对象");
  }
  const dir = getRecordingsDir();
  fs.mkdirSync(dir, { recursive: true });

  const recordingId = sanitizeId(rawRecording.recordingId || ("rec-" + Date.now().toString(36)));
  const cleanedSteps = cleanAndCoalesceSteps(rawRecording.steps || []);
  const suggestedParameters = extractSuggestedParameters(cleanedSteps);
  const userNotes = cleanedSteps
    .filter((s) => s.type === "note" || s.userNote)
    .map((s) => ({ stepIndex: s.index, type: s.type, note: s.note || s.userNote }));
  const extractTargets = cleanedSteps
    .filter((s) => s.type === "extract")
    .map((s) => ({
      stepIndex: s.index,
      mode: s.mode,
      listSelector: s.listSelector,
      selector: s.locator && s.locator.selector,
      sampleText: s.sampleText,
      userNote: s.userNote,
    }));

  const normalized = {
    schemaVersion: "1.0",
    recordingId,
    title: opts.title || rawRecording.title || "浏览器操作录制",
    browser: rawRecording.browser || "edge",
    startedAt: rawRecording.startedAt || new Date().toISOString(),
    stoppedAt: rawRecording.stoppedAt || new Date().toISOString(),
    initialUrl: rawRecording.initialUrl || (cleanedSteps[0] && cleanedSteps[0].url) || "",
    initialTitle: rawRecording.initialTitle || (cleanedSteps[0] && cleanedSteps[0].pageTitle) || "",
    stepCount: cleanedSteps.length,
    suggestedParameters,
    userNotes,
    extractTargets,
    steps: cleanedSteps,
  };

  const filePath = path.join(dir, recordingId + ".json");
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), "utf8");
  return {
    recordingId,
    filePath,
    title: normalized.title,
    stepCount: normalized.stepCount,
    suggestedParameters,
    userNotes,
    extractTargets,
    recording: normalized,
  };
}

function listRecordings(limit = 20) {
  const dir = getRecordingsDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const full = path.join(dir, f);
      let stat = null;
      try { stat = fs.statSync(full); } catch (e) { return null; }
      return { name: f, full, mtimeMs: stat ? stat.mtimeMs : 0 };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(1, Number(limit || 20)));

  const items = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(f.full, "utf8"));
      items.push({
        recordingId: data.recordingId || path.basename(f.name, ".json"),
        title: data.title || "",
        browser: data.browser || "edge",
        startedAt: data.startedAt,
        stoppedAt: data.stoppedAt,
        initialUrl: data.initialUrl || "",
        stepCount: Array.isArray(data.steps) ? data.steps.length : (data.stepCount || 0),
        filePath: f.full,
      });
    } catch (e) { /* skip broken json */ }
  }
  return items;
}

function loadRecording(idOrPath, opts = {}) {
  const dir = getRecordingsDir();
  if (!idOrPath || idOrPath === "latest") {
    const list = listRecordings(1);
    if (!list.length) return null;
    return JSON.parse(fs.readFileSync(list[0].filePath, "utf8"));
  }
  const raw = String(idOrPath).trim();
  const hasPathSyntax = raw.includes("/") || raw.includes("\\") || raw.includes("..") || path.isAbsolute(raw);
  if (hasPathSyntax) {
    const resolved = resolveReal(raw);
    const insideRec = canonicalInside(dir, resolved);
    const isWorkflowFile = !!opts.allowWorkflowFile && path.basename(resolved).toLowerCase() === "workflow.recording.json";
    if (!insideRec && !isWorkflowFile) {
      throw new Error("安全策略拒绝读取录制目录之外的 JSON 文件：" + raw);
    }
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return JSON.parse(fs.readFileSync(resolved, "utf8"));
    }
    return null;
  }
  const candidate = path.join(dir, sanitizeId(raw).replace(/\.json$/i, "") + ".json");
  if (!canonicalInside(dir, candidate)) {
    throw new Error("安全策略拒绝非法录制 ID：" + raw);
  }
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return JSON.parse(fs.readFileSync(candidate, "utf8"));
  }
  return null;
}

function applyFilter(value, filter) {
  switch (filter) {
    case "url":
    case "encodeURIComponent": return encodeURIComponent(String(value));
    case "upper": return String(value).toUpperCase();
    case "lower": return String(value).toLowerCase();
    case "json": return JSON.stringify(value);
    case "trim": return String(value).trim();
    default: return String(value);
  }
}

/** 支持 {{key}} 与 {{key|url}}、{{key|json}} 等过滤器；未定义变量原样保留给运行时解析。 */
function interpolateString(str, vars, paramDefs) {
  if (typeof str !== "string") return str;
  return str.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*(?:\|\s*([a-zA-Z0-9_]+)\s*)?\}\}/g, (whole, key, filter) => {
    let v;
    if (vars && vars[key] !== undefined && vars[key] !== null) v = vars[key];
    else if (paramDefs && paramDefs[key] && paramDefs[key].default !== undefined) v = paramDefs[key].default;
    else return whole; // 运行时变量：连过滤器一起原样留给 SW 阶段解析
    return filter ? applyFilter(v, filter) : String(v);
  });
}

/**
 * 深度插值：递归处理 loop/if/retry 的嵌套 steps、expression、items 等所有字段。
 * 整串恰好是 {{arrayVar}} 且值为数组/对象时保留原类型，避免 loop.items 被
 * String(array) 拍成 "a,b"。
 */
function interpolateValue(value, vars, paramDefs) {
  if (typeof value === "string") {
    const m = /^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/.exec(value);
    if (m) {
      const k = m[1];
      const v = (vars && vars[k] !== undefined && vars[k] !== null)
        ? vars[k]
        : (paramDefs && paramDefs[k] && paramDefs[k].default !== undefined ? paramDefs[k].default : undefined);
      if (v !== undefined && typeof v === "object") return v;
    }
    return interpolateString(value, vars, paramDefs);
  }
  if (Array.isArray(value)) return value.map((x) => interpolateValue(x, vars, paramDefs));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateValue(v, vars, paramDefs);
    return out;
  }
  return value;
}

function interpolateSteps(steps, vars = {}, paramDefs = {}) {
  if (!Array.isArray(steps)) return [];
  return steps.map((s) => interpolateValue(s, vars, paramDefs));
}

module.exports = {
  getRecordingsDir,
  canonicalInside,
  cleanAndCoalesceSteps,
  extractSuggestedParameters,
  saveRecording,
  listRecordings,
  loadRecording,
  interpolateString,
  interpolateValue,
  interpolateSteps,
};
