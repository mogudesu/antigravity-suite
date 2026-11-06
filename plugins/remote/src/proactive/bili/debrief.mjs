/**
 * B 站"看懂视频"：字幕 + 弹幕高能 + 可选视觉（FFmpeg 九宫格 / 硬字幕竖拼）。
 *
 * 视觉部分要用 ffmpeg 拉流截图，失败就只给文本证据，绝不编造画面内容。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { decodeDanmakuBuffer, parseDanmakuXml, findHighlights, formatClock } from './danmaku.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

async function getText(url, { cookie = '', timeoutMs = 12000, binary = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', ...(cookie ? { cookie } : {}) },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    if (binary) return { ok: true, buffer: Buffer.from(await res.arrayBuffer()), encoding: res.headers.get('content-encoding') || '' };
    return { ok: true, text: await res.text() };
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function getCid(bvid, { cookie = '' } = {}) {
  const res = await getText(`https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`, { cookie });
  if (!res.ok) return { ok: false, reason: res.reason };
  try {
    const data = JSON.parse(res.text);
    const cid = data?.data?.[0]?.cid;
    return cid ? { ok: true, cid: String(cid) } : { ok: false, reason: '没有 cid' };
  } catch {
    return { ok: false, reason: '解析失败' };
  }
}

/** 字幕（需要登录 cookie，很多视频没有字幕轨）。 */
export async function fetchSubtitle({ bvid, cid, cookie = '' } = {}) {
  const res = await getText(`https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`, { cookie });
  if (!res.ok) return { ok: false, reason: res.reason, lines: [] };
  try {
    const data = JSON.parse(res.text);
    const tracks = data?.data?.subtitle?.subtitles || [];
    const track = tracks.find((t) => /zh|ai/i.test(t.lan)) || tracks[0];
    if (!track?.subtitle_url) return { ok: false, reason: '该视频没有字幕轨', lines: [] };
    const url = track.subtitle_url.startsWith('//') ? `https:${track.subtitle_url}` : track.subtitle_url;
    const body = await getText(url, { cookie });
    if (!body.ok) return { ok: false, reason: body.reason, lines: [] };
    const json = JSON.parse(body.text);
    const lines = (json?.body || []).map((line) => ({ at: Math.floor(line.from), text: String(line.content || '').trim() })).filter((l) => l.text);
    return { ok: true, lines, lang: track.lan };
  } catch (error) {
    return { ok: false, reason: error?.message || '字幕解析失败', lines: [] };
  }
}

/** 弹幕 + 高能时刻。 */
export async function fetchDanmaku(cid, { cookie = '' } = {}) {
  const res = await getText(`https://comment.bilibili.com/${encodeURIComponent(cid)}.xml`, { cookie, binary: true });
  if (!res.ok) return { ok: false, reason: res.reason, highlights: { moments: [], spamBuckets: [] } };
  const xml = decodeDanmakuBuffer(res.buffer, { encoding: res.encoding });
  const list = parseDanmakuXml(xml);
  return { ok: true, count: list.length, highlights: findHighlights(list) };
}

function runFfmpeg(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, reason: 'ffmpeg 超时' });
    }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `ffmpeg 不可用：${error?.message || error}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, reason: stderr.split('\n').slice(-3).join(' ').slice(0, 200) });
    });
  });
}

/** 3x3 关键帧九宫格（看界面/架构图/实机画面）。 */
export async function makeContactSheet({ videoUrl, outPath, duration = 0, referer = 'https://www.bilibili.com/' } = {}) {
  if (!videoUrl || !outPath) return { ok: false, reason: '缺少视频地址或输出路径' };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const span = Math.max(9, Math.min(duration || 120, 600));
  const step = Math.max(1, Math.floor(span / 9));
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-headers', `Referer: ${referer}\r\nUser-Agent: ${UA}\r\n`,
    '-i', videoUrl,
    '-vf', `fps=1/${step},scale=480:-1,tile=3x3`,
    '-frames:v', '1',
    outPath,
  ];
  const res = await runFfmpeg(args);
  return res.ok && fs.existsSync(outPath) ? { ok: true, path: outPath } : { ok: false, reason: res.reason };
}

/** 硬字幕竖拼图：裁画面下方 32% 字幕带，按间隔竖着拼成一张长图。 */
export async function makeSubStrip({ videoUrl, outPath, duration = 0, step = 6, maxFrames = 12, referer = 'https://www.bilibili.com/' } = {}) {
  if (!videoUrl || !outPath) return { ok: false, reason: '缺少视频地址或输出路径' };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const frames = Math.max(3, Math.min(maxFrames, Math.floor((duration || 60) / step) || 6));
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-headers', `Referer: ${referer}\r\nUser-Agent: ${UA}\r\n`,
    '-i', videoUrl,
    '-vf', `fps=1/${step},crop=iw:ih*0.32:0:ih*0.68,scale=720:-1,vstack=inputs=${frames}`,
    '-frames:v', '1',
    outPath,
  ];
  const res = await runFfmpeg(args, { timeoutMs: 90000 });
  return res.ok && fs.existsSync(outPath) ? { ok: true, path: outPath } : { ok: false, reason: res.reason };
}

/** 取可播放地址（低清即可，截图够用）。 */
export async function getStreamUrl({ bvid, cid, cookie = '' } = {}) {
  const res = await getText(`https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}&qn=16&fnval=1`, { cookie });
  if (!res.ok) return { ok: false, reason: res.reason };
  try {
    const data = JSON.parse(res.text);
    const url = data?.data?.durl?.[0]?.url;
    return url ? { ok: true, url } : { ok: false, reason: '没有播放地址（可能需要登录）' };
  } catch {
    return { ok: false, reason: '解析失败' };
  }
}

/**
 * 一条视频的深读。
 * @returns {{ok: boolean, timeline: Array<{at: string, text: string}>, highlights: object, images: string[], gaps: string[]}}
 */
export async function debriefVideo(video, { cookie = '', workDir, withVisual = true, visualLimit = 1 } = {}) {
  const gaps = [];
  const bvid = video.bvid;
  if (!bvid) return { ok: false, gaps: ['没有 BV 号'], timeline: [], highlights: { moments: [], spamBuckets: [] }, images: [] };

  const cidRes = await getCid(bvid, { cookie });
  if (!cidRes.ok) gaps.push(`拿不到 cid：${cidRes.reason}`);
  const cid = cidRes.cid;

  const [sub, dan] = await Promise.all([
    cid ? fetchSubtitle({ bvid, cid, cookie }) : Promise.resolve({ ok: false, reason: '无 cid', lines: [] }),
    cid ? fetchDanmaku(cid, { cookie }) : Promise.resolve({ ok: false, reason: '无 cid', highlights: { moments: [], spamBuckets: [] } }),
  ]);
  if (!sub.ok) gaps.push(`字幕：${sub.reason}`);
  if (!dan.ok) gaps.push(`弹幕：${dan.reason}`);

  const images = [];
  if (withVisual && cid && workDir && visualLimit > 0) {
    const stream = await getStreamUrl({ bvid, cid, cookie });
    if (!stream.ok) {
      gaps.push(`视觉截图跳过：${stream.reason}`);
    } else {
      const sheet = await makeContactSheet({ videoUrl: stream.url, outPath: path.join(workDir, `${bvid}-grid.jpg`), duration: video.duration });
      if (sheet.ok) images.push(sheet.path);
      else gaps.push(`九宫格失败：${sheet.reason}`);
    }
  }

  // 时间轴：字幕行 + 弹幕高能对齐
  const timeline = (sub.lines || []).slice(0, 40).map((line) => ({ at: formatClock(line.at), text: line.text }));
  for (const moment of dan.highlights?.moments || []) {
    timeline.push({ at: formatClock(moment.at), text: `🔥 弹幕高能（${moment.count} 条）：${moment.samples.join(' / ')}` });
  }
  timeline.sort((a, b) => a.at.localeCompare(b.at));

  return {
    ok: Boolean(sub.ok || dan.ok),
    timeline: timeline.slice(0, 24),
    highlights: dan.highlights,
    images,
    gaps,
    subtitleChars: (sub.lines || []).reduce((sum, l) => sum + l.text.length, 0),
  };
}
