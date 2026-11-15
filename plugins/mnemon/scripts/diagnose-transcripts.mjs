#!/usr/bin/env node
/**
 * diagnose-transcripts.mjs
 * 离线诊断 Antigravity transcript*.jsonl 中的缓存读取率、无缓存输入、上下文增长与可测阶段耗时。
 *
 * 严格离线运行：只读取本地日志并在 CLI stdout 输出报告，不挂载 hook，不向模型注入任何诊断文本。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const opts = {
    brainDir: path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
    file: '',
    limit: 10,
    json: false,
    largeUncachedThreshold: 100000,
    ttlMs: 5 * 60 * 1000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--brain-dir') opts.brainDir = argv[++i] || opts.brainDir;
    else if (a === '--file' || a === '-f') opts.file = argv[++i] || '';
    else if (a === '--limit' || a === '-n') opts.limit = Math.max(1, Number(argv[++i] || 10));
    else if (a === '--json') opts.json = true;
    else if (a === '--large-threshold') opts.largeUncachedThreshold = Math.max(1000, Number(argv[++i] || 100000));
  }
  return opts;
}

function toMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function summarizeNumbers(arr) {
  if (!arr.length) return { count: 0, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  return {
    count: sorted.length,
    avgMs: Math.round(sum / sorted.length),
    p50Ms: Math.round(pct(0.5)),
    p95Ms: Math.round(pct(0.95)),
    maxMs: Math.round(sorted[sorted.length - 1]),
  };
}

export function analyzeTranscriptFile(filePath, opts = {}) {
  const largeThreshold = Number(opts.largeUncachedThreshold || 100000);
  const ttlMs = Number(opts.ttlMs || 5 * 60 * 1000);
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const records = [];
  let parseErrors = 0;
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      parseErrors += 1;
    }
  }

  let ephemeralSteps = 0;
  let checkpointsSinceLastCall = false;
  let checkpointCount = 0;
  let userInputs = 0;
  let modelCalls = 0;
  let callsWithCacheRead = 0;
  let zeroCacheCalls = 0;
  let coldStartMisses = 0;
  let ttlGapMisses = 0;
  let compactionMisses = 0;
  let unexpectedShortGapMisses = 0;
  let largeUncachedCalls = 0;
  let consecutiveLargeUncached = 0;
  let maxConsecutiveLargeUncached = 0;

  let sumUncachedInput = 0;
  let sumCacheRead = 0;
  let sumOutput = 0;
  let peakContext = 0;
  let firstContext = null;
  let lastContext = null;

  const stepToPlannerMs = [];
  const plannerToPlannerSameTurnMs = [];
  const largeMissDetails = [];

  let prevRecord = null;
  let prevPlanner = null;

  for (const rec of records) {
    const type = String(rec.type || '');
    if (type === 'EPHEMERAL_MESSAGE') ephemeralSteps += 1;
    if (type === 'USER_INPUT') userInputs += 1;
    if (type === 'CHECKPOINT') {
      checkpointCount += 1;
      checkpointsSinceLastCall = true;
    }

    if (type === 'PLANNER_RESPONSE' && rec.input_tokens != null) {
      modelCalls += 1;
      const uncached = Number(rec.input_tokens || 0);
      const cacheRead = Number(rec.cache_read_tokens || 0);
      const totalCtx = uncached + cacheRead;
      const out = Number(rec.output_tokens || 0);

      if (firstContext === null) firstContext = totalCtx;
      lastContext = totalCtx;
      if (totalCtx > peakContext) peakContext = totalCtx;

      sumUncachedInput += uncached;
      sumCacheRead += cacheRead;
      sumOutput += out;

      if (cacheRead > 0) callsWithCacheRead += 1;
      else zeroCacheCalls += 1;

      const curMs = toMs(rec.created_at);
      const prevRecMs = prevRecord ? toMs(prevRecord.created_at) : null;
      const prevPlanMs = prevPlanner ? toMs(prevPlanner.created_at) : null;
      if (curMs !== null && prevRecMs !== null && curMs >= prevRecMs) {
        stepToPlannerMs.push(curMs - prevRecMs);
      }
      if (curMs !== null && prevPlanMs !== null && curMs >= prevPlanMs) {
        const dt = curMs - prevPlanMs;
        if (dt <= 120000) plannerToPlannerSameTurnMs.push(dt);
      }

      if (cacheRead === 0) {
        const gapFromPrevPlanner = curMs !== null && prevPlanMs !== null ? curMs - prevPlanMs : null;
        if (modelCalls === 1) coldStartMisses += 1;
        else if (checkpointsSinceLastCall) compactionMisses += 1;
        else if (gapFromPrevPlanner !== null && gapFromPrevPlanner >= ttlMs) ttlGapMisses += 1;
        else unexpectedShortGapMisses += 1;
      }

      if (uncached >= largeThreshold) {
        largeUncachedCalls += 1;
        consecutiveLargeUncached += 1;
        if (consecutiveLargeUncached > maxConsecutiveLargeUncached) {
          maxConsecutiveLargeUncached = consecutiveLargeUncached;
        }
        largeMissDetails.push({
          step: rec.step_index,
          createdAt: rec.created_at || null,
          uncachedInput: uncached,
          cacheRead,
          totalContext: totalCtx,
          gapSincePrevPlannerMs: (curMs !== null && prevPlanMs !== null) ? (curMs - prevPlanMs) : null,
          afterCheckpoint: checkpointsSinceLastCall,
        });
      } else {
        consecutiveLargeUncached = 0;
      }

      checkpointsSinceLastCall = false;
      prevPlanner = rec;
    }
    prevRecord = rec;
  }

  const totalContextProcessed = sumUncachedInput + sumCacheRead;
  const cacheReadRatio = totalContextProcessed > 0 ? sumCacheRead / totalContextProcessed : 0;

  return {
    file: filePath,
    conversationId: path.basename(path.resolve(filePath, '..', '..', '..')),
    records: records.length,
    parseErrors,
    userInputs,
    ephemeralSteps,
    checkpointCount,
    modelCalls,
    callsWithCacheRead,
    zeroCacheCalls,
    missBreakdown: {
      coldStart: coldStartMisses,
      ttlGapOver5m: ttlGapMisses,
      afterCompaction: compactionMisses,
      shortGapUnexpected: unexpectedShortGapMisses,
    },
    largeUncachedThreshold: largeThreshold,
    largeUncachedCalls,
    maxConsecutiveLargeUncached,
    largeMissDetails: largeMissDetails.slice(-10),
    tokens: {
      uncachedInput: sumUncachedInput,
      cacheRead: sumCacheRead,
      totalContextProcessed,
      output: sumOutput,
      cacheReadRatio: Number(cacheReadRatio.toFixed(4)),
      startContext: firstContext,
      peakContext,
      endContext: lastContext,
      contextGrowth: firstContext !== null && lastContext !== null ? lastContext - firstContext : null,
    },
    measurableDurations: {
      ttftAvailable: false,
      note: 'Transcript logs contain created_at timestamps per completed step without streaming TTFT; intervals reflect prev-step-to-planner-done wall duration.',
      prevStepToPlannerDone: summarizeNumbers(stepToPlannerMs),
      plannerToPlannerUnder120s: summarizeNumbers(plannerToPlannerSameTurnMs),
    },
  };
}

function findRecentTranscripts(brainDir, limit) {
  if (!fs.existsSync(brainDir)) return [];
  const found = [];
  for (const entry of fs.readdirSync(brainDir)) {
    const full = path.join(brainDir, entry, '.system_generated', 'logs', 'transcript_full.jsonl');
    const compact = path.join(brainDir, entry, '.system_generated', 'logs', 'transcript.jsonl');
    const target = fs.existsSync(full) ? full : (fs.existsSync(compact) ? compact : '');
    if (!target) continue;
    try {
      const st = fs.statSync(target);
      found.push({ path: target, mtimeMs: st.mtimeMs });
    } catch { /* ignore */ }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, limit).map((x) => x.path);
}

function printHumanReport(reports) {
  console.log(`=== Antigravity Offline Transcript Diagnostics (${reports.length} sessions, TTFT=unavailable in logs) ===`);
  let totalCalls = 0;
  let totalCacheCalls = 0;
  let totalUncached = 0;
  let totalCacheRead = 0;
  let totalEphemeral = 0;
  let totalShortMisses = 0;
  for (const r of reports) {
    totalCalls += r.modelCalls;
    totalCacheCalls += r.callsWithCacheRead;
    totalUncached += r.tokens.uncachedInput;
    totalCacheRead += r.tokens.cacheRead;
    totalEphemeral += r.ephemeralSteps;
    totalShortMisses += r.missBreakdown.shortGapUnexpected;
    const pct = (r.tokens.cacheReadRatio * 100).toFixed(1);
    const med = r.measurableDurations.prevStepToPlannerDone.p50Ms ?? '-';
    const p95 = r.measurableDurations.prevStepToPlannerDone.p95Ms ?? '-';
    console.log(
      `- ${r.conversationId}: calls=${r.modelCalls} (cacheHitCalls=${r.callsWithCacheRead}, zeroCache=${r.zeroCacheCalls}[shortUnexpected=${r.missBreakdown.shortGapUnexpected}, ttl=${r.missBreakdown.ttlGapOver5m}, compact=${r.missBreakdown.afterCompaction}]), ` +
      `cacheRatio=${pct}%, uncached=${r.tokens.uncachedInput}, ctx=${r.tokens.startContext ?? 0}->${r.tokens.peakContext} (end=${r.tokens.endContext ?? 0}), ephemeral=${r.ephemeralSteps}, stepToDoneMs p50=${med}/p95=${p95}`
    );
  }
  const aggPct = (totalUncached + totalCacheRead) > 0
    ? ((totalCacheRead / (totalUncached + totalCacheRead)) * 100).toFixed(2)
    : '0.00';
  console.log(`\nAggregate: calls=${totalCalls}, callsWithCacheRead=${totalCacheCalls}, cacheRatio=${aggPct}%, uncachedInput=${totalUncached}, cacheRead=${totalCacheRead}, ephemeralSteps=${totalEphemeral}, shortGapUnexpectedMisses=${totalShortMisses}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const files = opts.file ? [opts.file] : findRecentTranscripts(opts.brainDir, opts.limit);
  const reports = files.filter((f) => fs.existsSync(f)).map((f) => analyzeTranscriptFile(f, opts));
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ttftAvailable: false, count: reports.length, sessions: reports }, null, 2) + '\n');
  } else {
    printHumanReport(reports);
  }
}
