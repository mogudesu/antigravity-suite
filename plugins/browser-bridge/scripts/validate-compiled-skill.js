#!/usr/bin/env node
'use strict';
/**
 * 编译产物一致性校验 —— 体检 browser-record-replay 生成的 Skill。
 *
 * 目的：拦截「SKILL.md 写得很完整、但 workflow.recording.json 里根本没有对应步骤」
 * 的幻觉式编译产物（文档与可执行轨迹脱节，回放必然跑不完目标）。
 *
 * 用法：
 *   node scripts/validate-compiled-skill.js <skill-dir> [--recording <原始录制.json>] [--json]
 * 退出码：0 = 无 ERROR（可有 WARN）；1 = 存在 ERROR；2 = 入参/文件错误
 */
const fs = require('fs');
const path = require('path');

// 与 extension/background.js -> browser_record_replay 的分支保持一致。
const SUPPORTED_STEP_TYPES = new Set([
  'navigate', 'click', 'type', 'select', 'press', 'scroll', 'extract', 'wait', 'note',
  'loop', 'forEach', 'if', 'evaluate', 'assert', 'verify', 'throttle', 'retry',
  'setVar', 'newTab', 'selectTab',
]);

const results = [];
function add(level, code, message, detail) {
  results.push({ level, code, message, ...(detail === undefined ? {} : { detail }) });
}
const ERROR = (code, message, detail) => add('ERROR', code, message, detail);
const WARN = (code, message, detail) => add('WARN', code, message, detail);
const OK = (code, message) => add('OK', code, message);

function normUrl(raw) {
  try {
    const u = new URL(raw);
    return u.origin + u.pathname.replace(/\/$/, '');
  } catch (e) {
    return null;
  }
}
function urlsIn(text) {
  const found = (text.match(/https?:\/\/[^\s)"'`<>,]+/g) || [])
    .map((s) => s.replace(/[.,;:)}\]]+$/, ''))
    .map(normUrl)
    .filter(Boolean);
  return Array.from(new Set(found));
}
function placeholdersIn(obj) {
  const keys = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/\{\{\s*([\w.-]+)\s*(?:\|\s*[\w.-]+\s*)?\}\}/g)) keys.add(m[1]);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(obj);
  return keys;
}

function main() {
  const argv = process.argv.slice(2);
  const skillDir = argv.find((a) => !a.startsWith('--'));
  const recIdx = argv.indexOf('--recording');
  const recordingPath = recIdx >= 0 ? argv[recIdx + 1] : null;
  const asJson = argv.includes('--json');

  if (!skillDir) {
    console.error('用法: node scripts/validate-compiled-skill.js <skill-dir> [--recording <原始录制.json>] [--json]');
    process.exit(2);
  }
  const root = path.resolve(skillDir);
  const skillMd = path.join(root, 'SKILL.md');
  const workflowPath = path.join(root, 'workflow.recording.json');
  if (!fs.existsSync(skillMd) || !fs.existsSync(workflowPath)) {
    console.error('缺少 SKILL.md 或 workflow.recording.json: ' + root);
    process.exit(2);
  }
  const md = fs.readFileSync(skillMd, 'utf8');
  let wf;
  try {
    wf = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  } catch (e) {
    console.error('workflow.recording.json 不是合法 JSON: ' + e.message);
    process.exit(2);
  }
  const steps = Array.isArray(wf.steps) ? wf.steps : [];
  const params = wf.parameters || {};

  // 递归展平 loop/if/retry 的子步骤，校验也要覆盖嵌套层。
  function flatten(list, acc = []) {
    for (const s of list || []) {
      if (!s || typeof s !== 'object') continue;
      acc.push(s);
      flatten(s.steps, acc);
      flatten(s.then, acc);
      flatten(s.else, acc);
    }
    return acc;
  }
  const allSteps = flatten(steps);

  // 运行时变量由 loop / evaluate.saveAs / setVar 声明，不算「未定义参数」。
  const runtimeVars = new Set();
  for (const s of allSteps) {
    if (s.type === 'loop' || s.type === 'forEach') {
      runtimeVars.add(s.var || 'item');
      runtimeVars.add(s.indexVar || 'index');
    }
    if (s.saveAs) runtimeVars.add(s.saveAs);
    if (s.type === 'setVar' && s.name) runtimeVars.add(s.name);
  }

  // ---- 1. 可执行轨迹 ----
  if (!steps.length) ERROR('STEPS_EMPTY', 'workflow.steps 为空，没有任何可回放步骤');
  else OK('STEPS_NONEMPTY', `workflow.steps 共 ${steps.length} 步（含嵌套共 ${allSteps.length} 步）`);

  const badTypes = allSteps.filter((s) => !SUPPORTED_STEP_TYPES.has(s.type)).map((s) => `${s.index}:${s.type}`);
  if (badTypes.length) ERROR('STEP_TYPE_UNSUPPORTED', '存在回放引擎不支持的步骤类型', badTypes);
  else OK('STEP_TYPE', '所有步骤类型都被 browser_record_replay 支持');

  const unbounded = allSteps
    .filter((s) => (s.type === 'loop' || s.type === 'forEach') && !Number.isInteger(s.maxIterations))
    .map((s) => s.index);
  if (unbounded.length) WARN('LOOP_UNBOUNDED', 'loop 未声明 maxIterations（引擎默认上限 200，建议显式写出）', unbounded);

  const usedVars = placeholdersIn(allSteps);
  const paramOnly = new Set(Object.keys(params));
  const definedVars = new Set([...paramOnly, ...runtimeVars]);
  const undefinedVars = [...usedVars].filter((v) => !definedVars.has(v));
  const unusedParams = [...paramOnly].filter((v) => !usedVars.has(v));
  if (undefinedVars.length) ERROR('PARAM_UNDEFINED', '步骤里使用了未在 parameters 或运行时变量中定义的占位符', undefinedVars);
  if (unusedParams.length) ERROR('PARAM_UNUSED', 'parameters 定义了但没有任何步骤引用的变量（参数与执行脱节）', unusedParams);
  if (!undefinedVars.length && !unusedParams.length) OK('PARAM_BINDING', '参数定义与 {{占位符}} 一一对应');

  // SKILL.md 参数表里声明的名字，必须在 workflow.parameters 里真的存在。
  const mdParams = new Set();
  for (const m of md.matchAll(/^\|\s*`([A-Za-z][\w.-]*)`\s*\|/gm)) mdParams.add(m[1]);
  const ghostParams = [...mdParams].filter((p) => !paramOnly.has(p));
  if (ghostParams.length) ERROR('SKILL_PARAM_UNDEFINED', 'SKILL.md 参数表声明了 workflow 中不存在的参数', ghostParams);

  // ---- 2. 可追溯性（编译必须能回溯到原始录制）----
  let recording = null;
  if (recordingPath) {
    try {
      recording = JSON.parse(fs.readFileSync(path.resolve(recordingPath), 'utf8'));
    } catch (e) {
      ERROR('RECORDING_UNREADABLE', '无法读取原始录制: ' + e.message);
    }
  }
  // 规则合成步骤（循环/校验/限速）不是录制动作，必须显式标 synthesized。
  const synthesized = allSteps.filter((s) => s.synthesized === true);
  if (synthesized.length) OK('SYNTHESIZED_LABELLED', `${synthesized.length} 个规则合成步骤已显式标注 synthesized`);
  const untraced = allSteps
    .filter((s) => !Number.isInteger(s.sourceStepIndex) && !s.synthesized)
    .map((s) => s.index);
  if (untraced.length) {
    (recording ? ERROR : WARN)(
      'SOURCE_TRACE_MISSING',
      '步骤既无 sourceStepIndex 也无 synthesized 标记，无法区分「清洗」与「凭空补写」',
      untraced,
    );
  } else {
    OK('SOURCE_TRACE', '每个步骤都可回溯到原始录制，或已标注为规则合成');
  }
  if (recording && Array.isArray(recording.steps)) {
    const srcIndexes = new Set(recording.steps.map((s) => s.index));
    const bogus = allSteps
      .filter((s) => Number.isInteger(s.sourceStepIndex) && !srcIndexes.has(s.sourceStepIndex))
      .map((s) => s.sourceStepIndex);
    if (bogus.length) ERROR('SOURCE_INDEX_INVALID', 'sourceStepIndex 在原始录制中不存在', bogus);
    else if (!untraced.length) OK('SOURCE_INDEX', 'sourceStepIndex 均能在原始录制中找到');
    if (recording.stepCount && steps.length < recording.stepCount) {
      WARN(
        'STEPS_TRIMMED',
        `编译保留 ${steps.length} 步 / 原始 ${recording.stepCount} 步；被删除的步骤应在 SKILL.md 说明清洗理由`,
        { kept: steps.length, recorded: recording.stepCount },
      );
    }
  }

  // ---- 3. SKILL.md 与轨迹的一致性 ----
  if (!/browser_record_replay/.test(md) || !/workflowPath/.test(md)) {
    ERROR('FAST_PATH_MISSING', 'SKILL.md 没有首选快放指令（browser_record_replay + workflowPath），执行只能靠 Agent 临场发挥');
  } else OK('FAST_PATH', 'SKILL.md 提供了确定性快放入口');
  if (!/failedStepIndex|browser_snapshot/.test(md)) {
    WARN('SELF_HEAL_MISSING', 'SKILL.md 缺少断点自愈说明（failedStepIndex / browser_snapshot）');
  }

  // 关键：只有 workflow.steps 里的 URL 才会被回放执行；原始录制里出现过、
  // 但被编译删掉的步骤，SKILL.md 仍然引用就等于「写了但不会跑」。
  const wfUrls = new Set(allSteps.filter((s) => s.url).map((s) => normUrl(s.url)).filter(Boolean));
  const recordedUrls = new Set();
  if (recording && Array.isArray(recording.steps)) {
    recording.steps.filter((s) => s.url).forEach((s) => {
      const n = normUrl(s.url);
      if (n) recordedUrls.add(n);
    });
  }
  const mdUrls = urlsIn(md);
  const droppedUrls = mdUrls.filter((u) => !wfUrls.has(u) && recordedUrls.has(u));
  const inventedUrls = mdUrls.filter((u) => !wfUrls.has(u) && !recordedUrls.has(u));
  if (droppedUrls.length) {
    WARN('URL_STEP_DROPPED', 'SKILL.md 依赖的页面在原始录制里出现过，但已被编译删除，回放不会执行到', droppedUrls);
  }
  if (inventedUrls.length) {
    WARN('URL_NOT_RECORDED', 'SKILL.md 引用了从未录制过的 URL（凭常识补写的 SOP）', inventedUrls);
  }
  if (!droppedUrls.length && !inventedUrls.length) OK('URLS_TRACED', 'SKILL.md 中的 URL 都能在可回放步骤中找到');

  // ---- 4. 伴随脚本必须真的被调用 ----
  const scriptsDir = path.join(root, 'scripts');
  if (fs.existsSync(scriptsDir)) {
    const files = fs.readdirSync(scriptsDir).filter((f) => /\.(js|mjs|cjs|py|json)$/.test(f));
    const orphans = files.filter((f) => !md.includes(f));
    if (orphans.length) {
      WARN('ORPHAN_SCRIPTS', 'scripts/ 下的文件没有被 SKILL.md 引用，也没有执行入口（死代码）', orphans);
    } else OK('SCRIPTS_REFERENCED', '伴随脚本都在 SKILL.md 中被引用');
  }

  // ---- 5. 验证闭环 ----
  if (!/试跑|实测|回归|validated|验证结果|CHANGELOG/.test(md)) {
    WARN('NO_VERIFICATION', 'SKILL.md 没有试跑/回归验证记录，无法证明流程真的达成目标');
  }
  if (!/validated|success|失败|错误码/.test(md)) {
    WARN('NO_RESULT_CONTRACT', 'SKILL.md 没有定义成功/失败判定与结果校验字段');
  }

  const errors = results.filter((r) => r.level === 'ERROR');
  const warns = results.filter((r) => r.level === 'WARN');
  const report = {
    skillDir: root,
    recording: recordingPath ? path.resolve(recordingPath) : null,
    summary: { errors: errors.length, warnings: warns.length, ok: results.filter((r) => r.level === 'OK').length },
    results,
  };
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('编译产物一致性校验: ' + root);
    for (const r of results) {
      const d = r.detail === undefined ? '' : '  -- ' + JSON.stringify(r.detail, null, 0);
      console.log(`  [${r.level}] ${r.code}: ${r.message}${d}`);
    }
    console.log(`\nRESULT: ${errors.length} error / ${warns.length} warning`);
  }
  process.exit(errors.length ? 1 : 0);
}

main();
