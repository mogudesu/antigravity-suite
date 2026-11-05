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

function loadRecording(idOrPath) {
  const dir = getRecordingsDir();
  if (!idOrPath || idOrPath === "latest") {
    const list = listRecordings(1);
    if (!list.length) return null;
    return JSON.parse(fs.readFileSync(list[0].filePath, "utf8"));
  }
  if (fs.existsSync(idOrPath) && fs.statSync(idOrPath).isFile()) {
    return JSON.parse(fs.readFileSync(idOrPath, "utf8"));
  }
  const candidate = path.join(dir, sanitizeId(idOrPath).replace(/\.json$/i, "") + ".json");
  if (fs.existsSync(candidate)) {
    return JSON.parse(fs.readFileSync(candidate, "utf8"));
  }
  return null;
}

function interpolateString(str, vars, paramDefs) {
  if (typeof str !== "string") return str;
  return str.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
    if (vars && vars[key] !== undefined && vars[key] !== null) return String(vars[key]);
    if (paramDefs && paramDefs[key] && paramDefs[key].default !== undefined) return String(paramDefs[key].default);
    return "{{" + key + "}}";
  });
}

function interpolateSteps(steps, vars = {}, paramDefs = {}) {
  if (!Array.isArray(steps)) return [];
  return steps.map((s) => {
    const copy = JSON.parse(JSON.stringify(s));
    if (typeof copy.url === "string") copy.url = interpolateString(copy.url, vars, paramDefs);
    if (typeof copy.value === "string") copy.value = interpolateString(copy.value, vars, paramDefs);
    if (typeof copy.label === "string") copy.label = interpolateString(copy.label, vars, paramDefs);
    if (typeof copy.text === "string") copy.text = interpolateString(copy.text, vars, paramDefs);
    if (copy.locator && typeof copy.locator.selector === "string") {
      copy.locator.selector = interpolateString(copy.locator.selector, vars, paramDefs);
    }
    if (copy.locator && copy.locator.semantic && typeof copy.locator.semantic.text === "string") {
      copy.locator.semantic.text = interpolateString(copy.locator.semantic.text, vars, paramDefs);
    }
    return copy;
  });
}

module.exports = {
  getRecordingsDir,
  cleanAndCoalesceSteps,
  extractSuggestedParameters,
  saveRecording,
  listRecordings,
  loadRecording,
  interpolateSteps,
};
