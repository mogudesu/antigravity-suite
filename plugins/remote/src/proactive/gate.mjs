/**
 * 克制闸门：主动推送的唯一出口。
 *
 * 三条硬规则（代码级 fail-closed，坏账本宁可不推）：
 *  1. 每天跨平台合计不超过 shareDaily 条（按本地时区切天）；
 *  2. 同一内容（BV 号 / 规范化 URL / owner/repo）7 天内不重复推；
 *  3. 20 分制评分不到 minScore 不推。
 * 外加沉默衰减：连续 N 天没互动，额度逐日递减到 0。
 */
import fs from 'node:fs';
import path from 'node:path';

export const SCORE_DIMENSIONS = [
  ['density', '信息密度', 4],
  ['affinity', '与你近期项目/偏好交集', 4],
  ['freshness', '新鲜度与非营销号', 4],
  ['community', '社区验证（弹幕/评论/Star）', 4],
  ['timeliness', '此刻打断你的价值', 4],
];

/** 本地日期键 YYYY-MM-DD（不要用 UTC，否则会跨天错位）。 */
export function localDayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 内容指纹：同一内容在不同平台/不同链接形态下尽量归一。 */
export function fingerprint(item = {}) {
  if (item.bvid) return `bili:${item.bvid}`;
  if (item.repo) return `gh:${String(item.repo).toLowerCase()}`;
  if (item.noteId) return `xhs:${item.noteId}`;
  if (item.url) return `url:${normalizeUrl(item.url)}`;
  return `title:${String(item.title || '').trim().toLowerCase().slice(0, 60)}`;
}

export function normalizeUrl(url) {
  try {
    const u = new URL(String(url));
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|spm|from|share_|vd_source|track|ref)/i.test(key)) u.searchParams.delete(key);
    }
    let out = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    const query = u.searchParams.toString();
    if (query) out += `?${query}`;
    return out.toLowerCase();
  } catch {
    return String(url || '').trim().toLowerCase();
  }
}

/** 打分：五维各 0-4，返回 {total, breakdown, reasons}。 */
export function scoreItem(item = {}, dimensions = {}) {
  const breakdown = {};
  const reasons = [];
  for (const [key, label, max] of SCORE_DIMENSIONS) {
    const raw = Number(dimensions[key] ?? item.scores?.[key] ?? 0);
    const value = Math.max(0, Math.min(max, Number.isFinite(raw) ? raw : 0));
    breakdown[key] = { label, value, max };
    if (value >= 3) reasons.push(`${label}+${value}`);
  }
  const total = Object.values(breakdown).reduce((sum, d) => sum + d.value, 0);
  return { total, breakdown, reasons };
}

/** 沉默衰减：连续 silentDays 天没互动，额度递减；>= decayToZeroDays 归零。 */
export function effectiveDailyLimit({ shareDaily = 3, silentDays = 0, decayToZeroDays = 7, decayStartDays = 3 } = {}) {
  if (silentDays < decayStartDays) return shareDaily;
  if (silentDays >= decayToZeroDays) return 0;
  const span = decayToZeroDays - decayStartDays;
  const remaining = decayToZeroDays - silentDays;
  return Math.max(0, Math.floor((shareDaily * remaining) / span));
}

export class ProactiveGate {
  constructor({ ledgerFile, config = {}, logger = console } = {}) {
    this.file = ledgerFile;
    this.logger = logger;
    this.config = {
      shareDaily: 3,
      minScore: 13,
      dedupeDays: 7,
      decayStartDays: 3,
      decayToZeroDays: 7,
      ...config,
    };
    this.state = this._load();
  }

  _empty() {
    return { days: {}, recent: {}, lastEngagedAt: '', history: [] };
  }

  _load() {
    if (!this.file) return this._empty();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        days: raw.days && typeof raw.days === 'object' ? raw.days : {},
        recent: raw.recent && typeof raw.recent === 'object' ? raw.recent : {},
        lastEngagedAt: typeof raw.lastEngagedAt === 'string' ? raw.lastEngagedAt : '',
        history: Array.isArray(raw.history) ? raw.history : [],
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return this._empty();
      // 账本坏了：熔断，今天一条都不推，避免失控刷屏
      this.logger.warn?.('[gate] 账本损坏，本次熔断停推：', error?.message || error);
      this.broken = true;
      return this._empty();
    }
  }

  _save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`);
      fs.renameSync(tmp, this.file);
    } catch (error) {
      this.logger.warn?.('[gate] 账本写入失败：', error?.message || error);
    }
  }

  /** 今天已经推了几条（跨平台合计）。 */
  sentToday(now = new Date()) {
    const key = localDayKey(now);
    return Number(this.state.days[key]?.count || 0);
  }

  /** 今天还剩几条额度（含沉默衰减）。 */
  remainingToday(now = new Date()) {
    if (this.broken) return 0;
    const limit = effectiveDailyLimit({
      shareDaily: this.config.shareDaily,
      silentDays: this.silentDays(now),
      decayStartDays: this.config.decayStartDays,
      decayToZeroDays: this.config.decayToZeroDays,
    });
    return Math.max(0, limit - this.sentToday(now));
  }

  /** 连续多少天没有互动（没有记录就算 0）。 */
  silentDays(now = new Date()) {
    if (!this.state.lastEngagedAt) return 0;
    const last = new Date(this.state.lastEngagedAt);
    if (Number.isNaN(last.getTime())) return 0;
    const diff = Math.floor((now - last) / (24 * 3600 * 1000));
    return Math.max(0, diff);
  }

  /** 7 天内是否推过。 */
  seenRecently(item, now = new Date()) {
    const fp = fingerprint(item);
    const at = this.state.recent[fp];
    if (!at) return false;
    const days = (now - new Date(at)) / (24 * 3600 * 1000);
    return days < this.config.dedupeDays;
  }

  /**
   * 判定一条候选能不能推。
   * @returns {{ok: boolean, reason: string, total: number, breakdown: object}}
   */
  judge(item, now = new Date()) {
    const { total, breakdown, reasons } = scoreItem(item);
    if (this.broken) return { ok: false, reason: 'ledger-broken', total, breakdown };
    if (this.seenRecently(item, now)) return { ok: false, reason: 'duplicate-7d', total, breakdown };
    if (total < this.config.minScore) return { ok: false, reason: `low-score(${total}<${this.config.minScore})`, total, breakdown };
    if (this.remainingToday(now) <= 0) {
      const silent = this.silentDays(now);
      return { ok: false, reason: silent >= this.config.decayStartDays ? 'silence-decay' : 'daily-limit', total, breakdown };
    }
    return { ok: true, reason: reasons.join(' / ') || 'pass', total, breakdown };
  }

  /** 记账：真正推出去之后调用。 */
  markSent(item, { platform = '', title = '', now = new Date() } = {}) {
    const key = localDayKey(now);
    const fp = fingerprint(item);
    const day = this.state.days[key] || { count: 0, items: [] };
    day.count += 1;
    day.items = [...(day.items || []), fp].slice(-20);
    this.state.days[key] = day;
    this.state.recent[fp] = now.toISOString();
    this.state.history = [...this.state.history, { at: now.toISOString(), fp, platform, title }].slice(-200);
    this._prune(now);
    this._save();
  }

  /** 用户有互动（回话/点赞/追问）：重置沉默 + 记录口味反馈。 */
  markEngaged({ signal = 'reply', detail = '', now = new Date() } = {}) {
    this.state.lastEngagedAt = now.toISOString();
    this.state.history = [...this.state.history, { at: now.toISOString(), signal, detail }].slice(-200);
    this._save();
  }

  _prune(now) {
    const cutoff = now - this.config.dedupeDays * 24 * 3600 * 1000;
    for (const [fp, at] of Object.entries(this.state.recent)) {
      if (new Date(at).getTime() < cutoff) delete this.state.recent[fp];
    }
    const keepDays = 30;
    const dayCutoff = localDayKey(new Date(now - keepDays * 24 * 3600 * 1000));
    for (const key of Object.keys(this.state.days)) {
      if (key < dayCutoff) delete this.state.days[key];
    }
  }

  status(now = new Date()) {
    return {
      sentToday: this.sentToday(now),
      remaining: this.remainingToday(now),
      silentDays: this.silentDays(now),
      limit: effectiveDailyLimit({
        shareDaily: this.config.shareDaily,
        silentDays: this.silentDays(now),
        decayStartDays: this.config.decayStartDays,
        decayToZeroDays: this.config.decayToZeroDays,
      }),
      minScore: this.config.minScore,
      broken: Boolean(this.broken),
    };
  }
}
