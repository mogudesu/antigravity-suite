/**
 * 三维兴趣画像：面板偏好词 + 近期工作区特征 + （可选）Mnemon 记忆。
 *
 * 只读，不改任何东西；产出用于选题的 query 列表和 affinity 打分参考。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 从路径里提炼技术关键词（AE/PS/React/Node…），用于判断"和你近期做的事有没有交集"。 */
export function keywordsFromPath(filePath) {
  const text = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  const dict = [
    ['ae', 'AE 脚本'], ['after effects', 'AE 脚本'], ['photoshop', 'PS 插件'], ['cep', 'CEP 扩展'],
    ['react', 'React'], ['vue', 'Vue'], ['node', 'Node.js'], ['python', 'Python'], ['rust', 'Rust'],
    ['electron', 'Electron'], ['canvas', 'Canvas'], ['webgl', 'WebGL'], ['shader', 'Shader'],
    ['llm', '大模型'], ['agent', 'Agent'], ['mcp', 'MCP'], ['rag', 'RAG'], ['tts', 'TTS'],
    ['ui', 'UI 设计'], ['design', '设计'], ['video', '视频'], ['ffmpeg', 'FFmpeg'],
  ];
  const hits = new Set();
  for (const [needle, label] of dict) {
    if (text.includes(needle)) hits.add(label);
  }
  return [...hits];
}

/** 读 Mnemon 记忆（存在才读，格式不认识就跳过，绝不报错）。 */
export function readMnemonHints(memoryFile) {
  try {
    if (!memoryFile || !fs.existsSync(memoryFile)) return [];
    const raw = fs.readFileSync(memoryFile, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.replace(/^[-*#\s]+/, '').trim())
      .filter((line) => line.length >= 4 && line.length <= 40)
      .slice(-40);
  } catch {
    return [];
  }
}

export class InterestProfiler {
  constructor({ state, index, mnemonFile, logger = console } = {}) {
    this.state = state;
    this.index = index;
    this.mnemonFile = mnemonFile;
    this.logger = logger;
  }

  /** 汇总一次画像快照。 */
  snapshot(bot = {}) {
    const panelKeywords = Array.isArray(bot.interests) ? bot.interests.filter(Boolean) : [];
    const blocked = Array.isArray(bot.blockedWords) ? bot.blockedWords.filter(Boolean) : [];

    const recent = this.index?.list?.({ limit: 12, workspace: bot.defaultWorkspace || '' }) || [];
    const workspaceWords = new Set();
    for (const item of recent) {
      for (const word of keywordsFromPath(`${item.title} ${item.workspace || ''}`)) workspaceWords.add(word);
    }
    const mnemon = readMnemonHints(this.mnemonFile);

    const queries = [...new Set([...panelKeywords, ...workspaceWords])].slice(0, 6);
    return {
      panelKeywords,
      workspaceKeywords: [...workspaceWords],
      mnemonHints: mnemon.slice(-6),
      blockedWords: blocked,
      queries,
      // 偏好词越多说明画像越明确，用于 affinity 打分时给一点基础分
      confidence: Math.min(4, Math.round((panelKeywords.length + workspaceWords.size) / 2)),
    };
  }

  /** 内容是否命中屏蔽词（命中直接不推）。 */
  isBlocked(item, blockedWords = []) {
    const text = `${item.title || ''} ${item.desc || ''}`.toLowerCase();
    return blockedWords.some((word) => word && text.includes(String(word).toLowerCase()));
  }
}
