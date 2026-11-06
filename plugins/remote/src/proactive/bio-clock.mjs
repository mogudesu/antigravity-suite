/**
 * 生物钟：多个作息窗口 + 窗口内随机时刻 + 有权利不打扰（skipChance）。
 *
 * 设计要点：
 *  - 每天第一次 tick 时按当天日期重算计划（跨天自动重置）；
 *  - 随机时刻而不是整点，避免"机器打卡"；
 *  - 掷 skipChance 决定"这趟不刷了"，但**不算错过**——当天还有别的窗口；
 *  - 配置变更调 invalidate() 立刻重算。
 */

const DAY_MS = 24 * 3600 * 1000;

/** "12:30-13:45" → {start:750, end:825}（分钟） */
export function parseWindow(text) {
  const m = String(text || '').trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (start >= end) return null;
  return { start, end, label: `${m[1]}:${m[2]}-${m[3]}:${m[4]}` };
}

/** 批量粘贴：支持换行/逗号/分号分隔，`12:30-13:45`、`12:30~13:45`、`12:30 13:45` 都认。 */
export function parseBatchWindows(text) {
  const tokens = String(text || '')
    .split(/[\n,，;；]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const out = [];
  for (const token of tokens) {
    const normalized = token
      .replace(/[~—–至到]/g, '-')
      .replace(/^(\d{1,2})[:：](\d{2})\s+(\d{1,2})[:：](\d{2})$/, '$1:$2-$3:$4')
      .replace(/^(\d{1,2})[:：](\d{2})-(\d{1,2})[:：](\d{2})$/, '$1:$2-$3:$4');
    const parsed = parseWindow(normalized);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function serializeWindows(windows = []) {
  return windows.map((w) => w.label || `${String(Math.floor(w.start / 60)).padStart(2, '0')}:${String(w.start % 60).padStart(2, '0')}-${String(Math.floor(w.end / 60)).padStart(2, '0')}:${String(w.end % 60).padStart(2, '0')}`).join(', ');
}

export function parseWindows(list = []) {
  const out = [];
  for (const item of list) {
    const parsed = typeof item === 'string' ? parseWindow(item) : item;
    if (parsed) out.push(parsed);
  }
  return out.sort((a, b) => a.start - b.start);
}

function dayStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function randomInt(max) {
  return Math.floor(Math.random() * Math.max(1, max));
}

export class BioClock {
  constructor({ windows = ['12:30-13:45', '20:30-23:30'], skipChance = 0.25, rng = Math.random } = {}) {
    this.windows = parseWindows(windows);
    this.skipChance = Math.max(0, Math.min(1, Number(skipChance) || 0));
    this.rng = rng;
    this.plan = null; // { day, wakes: [{at: Date, skipped: boolean}] }
  }

  /** 重新排当天计划（配置变更后调用）。 */
  invalidate(now = new Date()) {
    this.plan = null;
    return this.planFor(now);
  }

  planFor(now = new Date()) {
    const day = dayStart(now).getTime();
    if (this.plan && this.plan.day === day) return this.plan;
    const wakes = [];
    for (const win of this.windows) {
      const minute = win.start + randomInt(win.end - win.start);
      const at = new Date(day + minute * 60 * 1000);
      wakes.push({ at, window: win.label, skipped: this.rng() < this.skipChance });
    }
    this.plan = { day, wakes };
    return this.plan;
  }

  /** 下一个"要醒"的时刻（跳过被 skip 的），没有就返回明天第一个窗口。 */
  nextWake(now = new Date()) {
    const plan = this.planFor(now);
    const upcoming = plan.wakes.filter((w) => !w.skipped && w.at.getTime() > now.getTime());
    if (upcoming.length) return upcoming[0];
    const tomorrow = new Date(now.getTime() + DAY_MS);
    const nextPlan = this.planFor(tomorrow);
    const first = nextPlan.wakes.find((w) => !w.skipped) || nextPlan.wakes[0];
    return first || null;
  }

  /**
   * 是否该醒了。tick 频率建议 30-60s；同一次唤醒只返回一次 true。
   */
  due(now = new Date()) {
    const plan = this.planFor(now);
    for (const wake of plan.wakes) {
      if (wake.skipped || wake.fired) continue;
      if (wake.at.getTime() <= now.getTime()) {
        wake.fired = true;
        return { due: true, at: wake.at, window: wake.window };
      }
    }
    return { due: false };
  }

  describe(now = new Date()) {
    const plan = this.planFor(now);
    const next = this.nextWake(now);
    return {
      windows: this.windows.map((w) => w.label),
      skipChance: this.skipChance,
      today: plan.wakes.map((w) => ({ at: w.at.toTimeString().slice(0, 5), window: w.window, skipped: Boolean(w.skipped), fired: Boolean(w.fired) })),
      next: next ? { at: next.at.toISOString(), window: next.window } : null,
    };
  }
}
