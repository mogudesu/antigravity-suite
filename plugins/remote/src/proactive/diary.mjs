/**
 * 双日记：公开冲浪手记 + 私人品味校准账本。
 *
 * - 手记（companion-diary.md）：给人看的，记录每次漫游看了什么、推了什么、筛掉了什么；
 * - 校准（taste-calibration.md）：给机器看的，累积"喜欢/不喜欢"的信号，下次选题调权重。
 */
import fs from 'node:fs';
import path from 'node:path';

function appendLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${line}\n`, 'utf8');
}

export class DualDiary {
  constructor({ diaryFile, tasteFile, maxTasteEntries = 200 } = {}) {
    this.diaryFile = diaryFile;
    this.tasteFile = tasteFile;
    this.maxTasteEntries = maxTasteEntries;
  }

  /** 记一次漫游（无论推没推都记，方便事后复盘为什么没推）。 */
  logRoam({ at = new Date(), woke = '', candidates = [], pushed = [], skipped = [] } = {}) {
    if (!this.diaryFile) return;
    const stamp = at.toISOString().slice(0, 16).replace('T', ' ');
    const lines = [`\n## ${stamp} 漫游${woke ? `（${woke}）` : ''}`];
    if (pushed.length) {
      lines.push('**推了**：');
      for (const item of pushed) lines.push(`- [${item.score ?? '-'}] ${item.title || item.url}${item.reason ? ` —— ${item.reason}` : ''}`);
    } else {
      lines.push('**推了**：无（今天没刷到够格的东西）');
    }
    if (skipped.length) {
      lines.push('**筛掉**：');
      for (const item of skipped.slice(0, 8)) lines.push(`- ${item.title || item.url}（${item.reason}）`);
    }
    lines.push(`**候选数**：${candidates.length}`);
    appendLine(this.diaryFile, lines.join('\n'));
  }

  /** 记录口味信号：like / dislike / detail（追问细节，说明真感兴趣）。 */
  recordTaste({ signal = 'like', title = '', url = '', note = '', at = new Date() } = {}) {
    if (!this.tasteFile) return;
    const line = `- ${at.toISOString().slice(0, 16)} | ${signal} | ${String(title).slice(0, 60)} | ${url}${note ? ` | ${note}` : ''}`;
    appendLine(this.tasteFile, line);
  }

  /** 从校准账本统计偏好权重（signal → 次数），用于调选题。 */
  tasteWeights() {
    const weights = { like: 0, dislike: 0, detail: 0 };
    if (!this.tasteFile || !fs.existsSync(this.tasteFile)) return weights;
    const lines = fs.readFileSync(this.tasteFile, 'utf8').split('\n');
    for (const line of lines.slice(-this.maxTasteEntries)) {
      const m = line.match(/\|\s*(like|dislike|detail)\s*\|/);
      if (m) weights[m[1]] += 1;
    }
    return weights;
  }

  /** 读最近 N 条手记（给 /diary 用）。 */
  recentDiary(limit = 3) {
    if (!this.diaryFile || !fs.existsSync(this.diaryFile)) return '';
    const text = fs.readFileSync(this.diaryFile, 'utf8');
    const sections = text.split(/\n## /).filter(Boolean);
    return sections.slice(-limit).map((s) => `## ${s.trim()}`).join('\n\n');
  }
}
