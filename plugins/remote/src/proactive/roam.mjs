/**
 * 漫游引擎：生物钟醒来 → 画像 → 选题 → 深读 → 打分 → 闸门 → 推送。
 *
 * 分工很明确：
 *  - 选题/深读交给 scouts（可替换，失败就记缺口）；
 *  - 能不能推，**只由 gate 决定**（它不看内容好不好看，只看分数/额度/去重）；
 *  - 推完写双日记；用户回话由 hub 调 markEngaged 重置沉默。
 */
import { formatClock } from './bili/danmaku.mjs';
import { enabledPlatforms, scoutPlatform, PLATFORMS } from './scouts/platform-scouts.mjs';

const MARKETING_RE = /(震惊|速看|必看|最后一天|限时|爆款|月入|躺赚|0 基础|小白也能)/;

/** 把深读结果转成一条推送文案（飞书/微信/QQ 通用纯文本）。 */
export function formatShare(item, debrief = {}) {
  const lines = [`📺 ${item.title}`];
  const meta = [item.author && `UP：${item.author}`, item.duration && `时长 ${Math.round(item.duration / 60)} 分钟`, item.stats?.view && `播放 ${fmt(item.stats.view)}`]
    .filter(Boolean)
    .join(' · ');
  if (meta) lines.push(meta);
  if (item.desc) lines.push('', item.desc.slice(0, 160));
  const moments = (debrief.highlights?.moments || []).slice(0, 3);
  if (moments.length) {
    lines.push('', '🔥 高能时刻：');
    for (const moment of moments) lines.push(`  [${formatClock(moment.at)}] ${moment.samples.slice(0, 2).join(' / ')}`);
  }
  const timeline = (debrief.timeline || []).filter((t) => t.text && !t.text.startsWith('🔥')).slice(0, 3);
  if (timeline.length) {
    lines.push('', '📌 看点：');
    for (const point of timeline) lines.push(`  [${point.at}] ${point.text.slice(0, 80)}`);
  }
  if (debrief.gaps?.length) lines.push('', `⚠️ 缺口：${debrief.gaps.slice(0, 2).join('；')}`);
  lines.push('', item.url || '');
  return lines.join('\n');
}

function fmt(n) {
  const value = Number(n) || 0;
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  return String(value);
}

/** 五维启发式打分（没有大模型也能跑；有模型时可以覆盖）。 */
export function heuristicScores(item, { profile = {}, debrief = {}, now = Date.now() } = {}) {
  const text = `${item.title || ''} ${item.desc || ''}`.toLowerCase();
  const keywordHits = (profile.queries || []).filter((word) => word && text.includes(String(word).toLowerCase())).length;

  const density = Math.min(4, Math.round((debrief.subtitleChars || 0) / 1500) + (debrief.timeline?.length ? 1 : 0));
  const affinity = Math.min(4, keywordHits * 2 + (profile.confidence ? 1 : 0));
  const ageDays = item.pubdate ? (now - item.pubdate * 1000) / 86400000 : 30;
  let freshness = ageDays < 2 ? 4 : ageDays < 7 ? 3 : ageDays < 30 ? 2 : 1;
  if (MARKETING_RE.test(item.title || '')) freshness = Math.max(0, freshness - 2);
  const engagement = (item.stats?.like || 0) / Math.max(1, item.stats?.view || 1);
  const community = Math.min(4, Math.round(engagement * 40) + (item.stats?.danmaku > 200 ? 2 : 0));
  const timeliness = 3;
  return { density, affinity, freshness, community, timeliness };
}

export class RoamEngine {
  constructor({ clock, gate, profiler, diary, feed, debrief, logger = console, config = {} } = {}) {
    this.clock = clock;
    this.gate = gate;
    this.profiler = profiler;
    this.diary = diary;
    this.feed = feed;
    this.debrief = debrief;
    this.logger = logger;
    this.config = {
      keywords: [],
      cookie: '',
      upMids: [],
      deepRead: 2,
      withVisual: true,
      platforms: {},
      ...config,
    };
  }

  /**
   * 跑一轮。
   * @param {{reason?: string, bot?: object, send?: (text: string, item: object) => Promise<void>}} options
   */
  async runOnce({ reason = 'manual', bot = {}, send } = {}) {
    const profile = this.profiler?.snapshot?.(bot) || { queries: [], blockedWords: [], confidence: 0 };
    const queries = [...new Set([...(this.config.keywords || []), ...(profile.queries || [])])].slice(0, 3);

    const active = enabledPlatforms(this.config.platforms);
    const sources = {};
    let candidates = [];

    // B 站：走官方接口（有 cookie 才能看关注/排行）
    if (active.includes('bili')) {
      const collected = await this.feed.collectCandidates({
        keywords: queries,
        cookie: this.config.cookie,
        upMids: this.config.upMids,
      });
      Object.assign(sources, collected.sources || {});
      candidates.push(...(collected.items || []));
    }

    // 其它平台：站内检索（不依赖登录），拿标题+链接，需要正文再深读
    for (const platform of active.filter((p) => p !== 'bili')) {
      const res = await scoutPlatform(platform, queries, { limit: 5 });
      sources[platform] = { ok: Boolean(res.ok), reason: res.reason || '', count: (res.items || []).length };
      candidates.push(...(res.items || []));
    }

    candidates = candidates.filter((item) => !this.profiler?.isBlocked?.(item, profile.blockedWords));

    const skipped = [];
    const pushed = [];
    // 先按粗分排序，只对前几条做深读（深读要拉字幕/弹幕/截图，成本高）
    const ranked = candidates.slice(0, Math.max(3, this.config.deepRead * 2));
    for (const item of ranked) {
      const deep = item.platform === 'bili'
        ? await this.debrief.debriefVideo(item, {
        cookie: this.config.cookie,
        withVisual: this.config.withVisual && pushed.length < this.config.deepRead,
          workDir: this.config.workDir,
          visualLimit: 1,
        })
        : { ok: true, timeline: [], highlights: { moments: [], spamBuckets: [] }, images: [], gaps: [], subtitleChars: 0 };
      const scores = heuristicScores(item, { profile, debrief: deep });
      // 画了偏好词却完全没交集 → 别拿随机热门凑数
      if (profile.queries?.length && scores.affinity === 0) {
        skipped.push({ title: item.title, reason: 'no-affinity', score: scores.density + scores.freshness + scores.community + scores.timeliness });
        continue;
      }
      const verdict = this.gate.judge({ ...item, scores });
      if (!verdict.ok) {
        skipped.push({ title: item.title, reason: verdict.reason, score: verdict.total });
        continue;
      }
      const text = formatShare(item, deep);
      if (send) await send(text, { ...item, deep });
      this.gate.markSent(item, { title: item.title, platform: 'bili' });
      pushed.push({ title: item.title, score: verdict.total, reason: verdict.reason, url: item.url, images: deep.images });
      if (pushed.length >= Math.max(1, this.gate.remainingToday())) break;
    }

    this.diary?.logRoam?.({ woke: reason, candidates, pushed, skipped });
    return { ok: true, reason, pushed, skipped, sources, platforms: active, profile: { queries, confidence: profile.confidence } };
  }

  status(now = new Date()) {
    return {
      clock: this.clock?.describe?.(now) || null,
      gate: this.gate?.status?.(now) || null,
    };
  }
}
