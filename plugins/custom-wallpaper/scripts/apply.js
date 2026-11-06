const http = require('http');
const fs = require('fs');
const path = require('path');

function getDevToolsPort() {
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Roaming');
  const portFile = path.join(appData, 'Antigravity', 'DevToolsActivePort');

  if (!fs.existsSync(portFile)) return null;

  try {
    const lines = fs.readFileSync(portFile, 'utf8').trim().split('\n');
    return parseInt(lines[0].trim(), 10);
  } catch (e) {
    return null;
  }
}

function humanizePluginName(name) {
  return String(name || '')
    .replace(/-plugin$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function readPluginCatalog(pluginDir) {
  const root = path.dirname(pluginDir);
  const plugins = [];

  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const manifestPath = path.join(root, entry.name, 'plugin.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const id = manifest.name || entry.name;
        const displayName = manifest.displayName || humanizePluginName(id);
        let skillName = '';
        let skillPath = '';
        try {
          const skillsDir = path.join(root, entry.name, 'skills');
          if (fs.existsSync(skillsDir)) {
            const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true });
            for (const skillDir of skillDirs) {
              if (!skillDir.isDirectory()) continue;
              const candidate = path.join(skillsDir, skillDir.name, 'SKILL.md');
              if (fs.existsSync(candidate)) {
                skillName = skillDir.name;
                skillPath = candidate;
                break;
              }
            }
          }
        } catch (error) {}
        plugins.push({
          id,
          name: displayName,
          displayName,
          description: String(manifest.description || '').replace(/\s+/g, ' ').trim(),
          version: manifest.version || '',
          suggestedPrompt: Array.isArray(manifest.suggestedPrompts) && manifest.suggestedPrompts.length
            ? String(manifest.suggestedPrompts[0])
            : '',
          skillName,
          skillPath,
          path: path.join(root, entry.name)
        });
      } catch (error) {
        console.warn('[Wallpaper] Failed to read plugin manifest:', manifestPath, error.message);
      }
    }
  } catch (error) {
    console.warn('[Wallpaper] Failed to scan installed plugins:', error.message);
  }

  return plugins.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function readSkillPathMap(pluginDir) {
  const home = process.env.USERPROFILE || '';
  const roots = [
    path.join(home, '.gemini', 'config', 'skills'),
    path.join(home, '.gemini', 'antigravity', 'builtin', 'skills'),
    path.join(home, '.gemini', 'config', 'plugins'),
    path.join(home, '.gemini', 'antigravity-ide', 'plugins')
  ];
  const map = {};
  const walk = (dir, depth) => {
    if (depth > 7) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        const name = path.basename(path.dirname(full));
        map[name] = full;
        map[name.toLowerCase()] = full;
        map[name.toLowerCase().replace(/_/g, '-')] = full;
      }
    }
  };
  roots.forEach((root) => walk(root, 0));
  return map;
}

function readSkillCatalog(pluginDir) {
  const home = process.env.USERPROFILE || '';
  const roots = [
    { dir: path.join(home, '.gemini', 'config', 'skills'), source: 'personal' },
    { dir: path.join(home, '.gemini', 'config', 'plugins'), source: 'plugin' },
    { dir: path.join(home, '.gemini', 'antigravity', 'builtin', 'skills'), source: 'builtin' },
    { dir: path.join(home, '.gemini', 'antigravity-ide', 'plugins'), source: 'plugin' }
  ];

  const parseManifest = (file, fallbackName) => {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8').slice(0, 6000);
    } catch (error) {
      return { title: fallbackName, description: '' };
    }
    let title = '';
    let description = '';
    if (text.startsWith('---')) {
      const end = text.indexOf('\n---', 3);
      const front = end >= 0 ? text.slice(3, end) : '';
      front.split(/\r?\n/).forEach((line) => {
        const match = line.match(/^([A-Za-z_-]+)\s*:\s*(.+)$/);
        if (!match) return;
        const key = match[1].toLowerCase();
        const value = match[2].replace(/^['"]|['"]$/g, '').trim();
        if (key === 'name' || key === 'title') title = value;
        if (key === 'description') description = value;
      });
    }
    const heading = text.match(/^\s*#\s+(.+)$/m);
    if (!title && heading) title = heading[1].trim();
    if (!description) {
      const body = text.replace(/^---[\s\S]*?---/, '');
      const paragraph = body.split(/\r?\n\r?\n/).find((block) => {
        const line = block.trim();
        return line && !line.startsWith('#') && !line.startsWith('```') && !line.startsWith('>');
      });
      if (paragraph) description = paragraph.replace(/[#*`_>\[\]]/g, '').replace(/\s+/g, ' ').trim();
    }
    return {
      title: String(title || fallbackName).slice(0, 80),
      description: String(description || '').replace(/\s+/g, ' ').trim().slice(0, 160)
    };
  };

  const byName = new Map();
  const walk = (dir, source, depth) => {
    if (depth > 7) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, source, depth + 1);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        const name = path.basename(path.dirname(full));
        const key = name.toLowerCase().replace(/_/g, '-');
        const existing = byName.get(key);
        if (existing && existing.source === 'personal') continue;
        const meta = parseManifest(full, name);
        byName.set(key, {
          name,
          title: meta.title,
          description: meta.description,
          path: full,
          source
        });
      }
    }
  };
  roots.forEach((root) => walk(root.dir, root.source, 0));

  const rank = { personal: 0, plugin: 1, builtin: 2 };
  return Array.from(byName.values())
    .sort((a, b) => (rank[a.source] - rank[b.source]) || a.title.localeCompare(b.title))
    .slice(0, 300);
}

function findUsageEndpoints() {
  const appDir = process.env.ANTIGRAVITY_APP_DATA_DIR || path.join(process.env.USERPROFILE || '', '.gemini', 'antigravity');
  const candidates = [
    path.join(appDir, 'sidecar_data', 'gemini-hakimi-widget', 'hakimi_panel', 'data', 'server_info.json'),
    path.join(appDir, 'sidecar_data', 'hakimi_panel', 'data', 'server_info.json')
  ];
  let detectedPort = null;

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const info = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (Number.isInteger(info.port) && info.port > 0) {
        detectedPort = info.port;
        break;
      }
    } catch (error) {}
  }

  const ports = Array.from(new Set([detectedPort, 54716, 39282].filter((port) => Number.isInteger(port) && port > 0)));
  return ports.map((port) => `http://127.0.0.1:${port}/api/stats`);
}

function generateThemeCss(dataUri, cfg) {
  const opacity = cfg.opacity !== undefined ? cfg.opacity : 0.58;
  const celestialOpacity = Math.max(0.35, Math.min(0.92, Number(opacity) || 0.58));
  const leftMaskAlpha = Math.max(0.42, Math.min(0.70, 0.86 - celestialOpacity * 0.40)).toFixed(2);
  const midMaskAlpha = Math.max(0.30, Math.min(0.58, 0.74 - celestialOpacity * 0.50)).toFixed(2);
  const rightMaskAlpha = Math.max(0.12, Math.min(0.40, 0.55 - celestialOpacity * 0.50)).toFixed(2);

  const pickColor = (value, fallback) => {
    const text = String(value || '').trim();
    return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
  };
  const palette = cfg.palette && typeof cfg.palette === 'object' ? cfg.palette : {};
  const brandAccent = pickColor(cfg.brandAccent, '#F6D893');
  const accentAlt = pickColor(palette.highlight, '#C4B5FD');
  const accentCool = pickColor(palette.accent, '#7DD3FC');
  const wallOpacity = Math.max(0, Math.min(1, Number(cfg.opacity !== undefined ? cfg.opacity : 0.58) || 0));
  const wallTint = Math.max(0, Math.min(0.92, Number(cfg.darkTint !== undefined ? cfg.darkTint : 0.6) || 0));
  const glassBlur = Math.max(0, Math.min(60, Number(cfg.blur !== undefined ? cfg.blur : 24) || 0));
  const focusX = Math.max(0, Math.min(100, Number(cfg.focusX !== undefined ? cfg.focusX : 50) || 0));
  const focusY = Math.max(0, Math.min(100, Number(cfg.focusY !== undefined ? cfg.focusY : 26) || 0));

  return `
    /* ==========================================================================
       Antigravity Theme: Starlight Obsidian Glass (星夜流金·微晶玻璃 v2.0)
       解决：药丸泛滥、字画打架、滚动穿透重影、高饱和荧光紫廉价感
       ========================================================================== */

    :root {
      --ag-bg-deep: #090b16;
      --ag-sidebar-surface: rgba(11, 13, 26, 0.74);
      --ag-chat-pad: rgba(14, 17, 34, 0.52);
      --ag-card-elevated: rgba(22, 25, 48, 0.92);
      --ag-border-hairline: rgba(255, 255, 255, 0.07);
      --ag-border-highlight: rgba(165, 180, 252, 0.32);
      --ag-text-primary: #F1F5F9;
      --ag-text-secondary: #94A3B8;
      --ag-text-muted: #64748B;
      --ag-accent-starlight: #A5B4FC;
      --ag-accent-nebula: rgba(139, 92, 246, 0.22);
    }

    /* 1. 全局非对称星云遮罩（左深保阅读，右透保原画） */
    #antigravity-custom-bg-layer {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      background-image:
        linear-gradient(90deg, rgba(9, 11, 22, 0.84) 0%, rgba(9, 11, 22, 0.65) 45%, rgba(9, 11, 22, 0.38) 100%),
        radial-gradient(circle at 68% 35%, rgba(139, 92, 246, 0.06) 0%, rgba(9, 11, 22, 0.75) 85%),
        url('${dataUri}') !important;
      background-size: cover !important;
      background-position: center 28% !important;
      background-repeat: no-repeat !important;
      z-index: 0 !important;
      pointer-events: none !important;
      opacity: ${opacity} !important;
      transition: opacity 0.35s ease !important;
    }

    /* 基础透明化与主骨架穿透 */
    body, #root, #root > div, .agy-shell {
      background-color: transparent !important;
    }

    .agy-shell {
      position: relative !important;
      z-index: 1 !important;
    }

    main, [role="main"], .group\\/pane {
      background-color: transparent !important;
    }

    /* 2. 左侧边栏：沉稳亚克力 + 去药丸化极简悬浮树 */
    .bg-sidebar {
      background: var(--ag-sidebar-surface) !important;
      backdrop-filter: blur(24px) saturate(160%) !important;
      -webkit-backdrop-filter: blur(24px) saturate(160%) !important;
      border-right: 1px solid var(--ag-border-hairline) !important;
    }

    /* 移除所有粗紫边框与默认胶囊色，改为轻盈极简态 */
    .agy-sidebar-row {
      background: transparent !important;
      border: 1px solid transparent !important;
      border-radius: 8px !important;
      box-shadow: none !important;
      margin: 2px 6px !important;
      padding: 6px 10px !important;
      transition: background-color 160ms ease-out, color 160ms ease-out, transform 160ms ease-out !important;
    }

    /* 默认文本：柔和冷灰，标题保持足够对比度 */
    .agy-sidebar-row,
    .agy-sidebar-row span,
    .agy-sidebar-row div {
      color: var(--ag-text-secondary) !important;
    }

    .agy-sidebar-row > div:first-of-type span {
      color: #A7B5C8 !important;
    }

    /* 侧栏分组标题：小字号、宽字距，建立安静的结构层级 */
    .bg-sidebar h2 {
      color: #7E8FA7 !important;
      font-size: 10.5px !important;
      font-weight: 600 !important;
      letter-spacing: 0.08em !important;
    }

    /* 原生分组折叠入口：箭头常显，展开/收起有方向与透明度反馈 */
    .bg-sidebar h2 > button[aria-expanded] > svg {
      opacity: 0.52 !important;
      transform: rotate(90deg) !important;
      transition: transform 180ms ease, opacity 180ms ease !important;
    }

    .bg-sidebar h2 > button[aria-expanded="false"] > svg {
      opacity: 0.42 !important;
      transform: rotate(0deg) !important;
    }

    .bg-sidebar h2 > button[aria-expanded]:hover > svg,
    .bg-sidebar h2 > button[aria-expanded]:focus-visible > svg {
      opacity: 0.92 !important;
    }

    .bg-sidebar h2 > button[aria-expanded="false"] {
      color: #93A4BA !important;
    }

    /* 时间戳缩小弱化，去除视觉杂质 */
    .agy-sidebar-row .text-xs,
    .agy-sidebar-row [class*="tabular-nums"],
    .agy-sidebar-row [data-screenshot-volatile="true"] {
      font-size: 11px !important;
      opacity: 0.45 !important;
    }

    .agy-sidebar-row > div:first-of-type span {
      opacity: 1 !important;
    }

    /* 悬停态：轻量微白透光，无刺眼色边 */
    .agy-sidebar-row:hover {
      background: rgba(255, 255, 255, 0.05) !important;
      border-color: transparent !important;
      transform: translateX(2px) !important;
    }

    .agy-sidebar-row:hover,
    .agy-sidebar-row:hover span,
    .agy-sidebar-row:hover div {
      color: var(--ag-text-primary) !important;
    }

    /* 选中激活态：彩色极光呼吸 + 左侧星轨指示条 */
    .agy-sidebar-row.bg-sidebar-secondary,
    .agy-sidebar-row[style*="var(--sidebar-secondary)"],
    .agy-sidebar-row[data-selected="true"] {
      position: relative !important;
      background:
        linear-gradient(90deg, rgba(139, 92, 246, 0.26) 0%, rgba(99, 102, 241, 0.10) 52%, rgba(252, 211, 77, 0.055) 100%) !important;
      border-left: 1px solid transparent !important;
      border-radius: 8px !important;
      box-shadow:
        inset 0 0 0 1px rgba(165, 180, 252, 0.07),
        inset 0 0 22px rgba(139, 92, 246, 0.13),
        0 4px 18px -10px rgba(125, 211, 252, 0.45) !important;
      animation: ag-selected-aurora 4.8s ease-in-out infinite !important;
    }

    .agy-sidebar-row[data-selected="true"]::before {
      content: "" !important;
      position: absolute !important;
      inset: 0 !important;
      border-radius: 8px !important;
      padding: 1px !important;
      background: linear-gradient(100deg, rgba(165, 180, 252, 0.52), rgba(125, 211, 252, 0.18) 48%, rgba(252, 211, 77, 0.28) 100%) 0 0 / 220% 100% !important;
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0) !important;
      -webkit-mask-composite: xor !important;
      mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0) !important;
      mask-composite: exclude !important;
      opacity: 0.82 !important;
      pointer-events: none !important;
      animation: ag-selected-border-flow 6.5s linear infinite !important;
    }

    .agy-sidebar-row[data-selected="true"]::after {
      content: "" !important;
      position: absolute !important;
      left: 1px !important;
      top: 8px !important;
      bottom: 8px !important;
      width: 3px !important;
      border-radius: 999px !important;
      background: linear-gradient(180deg, #A5B4FC 0%, #7DD3FC 52%, #FCD34D 100%) !important;
      box-shadow: 0 0 10px rgba(165, 180, 252, 0.72) !important;
      pointer-events: none !important;
      animation: ag-selected-rail 4.8s ease-in-out infinite !important;
    }

    @keyframes ag-selected-aurora {
      0%, 100% { box-shadow: inset 0 0 0 1px rgba(165, 180, 252, 0.07), inset 0 0 22px rgba(139, 92, 246, 0.13), 0 4px 18px -10px rgba(125, 211, 252, 0.38); }
      50% { box-shadow: inset 0 0 0 1px rgba(165, 180, 252, 0.12), inset 0 0 30px rgba(139, 92, 246, 0.18), 0 4px 22px -10px rgba(125, 211, 252, 0.58); }
    }

    @keyframes ag-selected-border-flow {
      to { background-position: 220% 0; }
    }

    @keyframes ag-selected-rail {
      0%, 100% { opacity: 0.72; transform: scaleY(0.88); }
      50% { opacity: 1; transform: scaleY(1); }
    }

    .agy-sidebar-row.bg-sidebar-secondary span,
    .agy-sidebar-row.bg-sidebar-secondary div,
    .agy-sidebar-row[style*="var(--sidebar-secondary)"] span,
    .agy-sidebar-row[style*="var(--sidebar-secondary)"] div,
    .agy-sidebar-row[data-selected="true"] span,
    .agy-sidebar-row[data-selected="true"] div {
      color: #FFFFFF !important;
      font-weight: 500 !important;
    }

    .agy-sidebar-row[data-selected="true"] > div:first-of-type span {
      opacity: 1 !important;
    }

    /* 顶部按钮瘦身：只命中真正的 "+ New Conversation"，避免污染会话与文件夹行 */
    .bg-sidebar [data-testid="new-conversation-button"] {
      background: linear-gradient(135deg, rgba(139, 92, 246, 0.18), rgba(56, 189, 248, 0.10)) !important;
      border: 1px solid rgba(165, 180, 252, 0.25) !important;
      border-radius: 9px !important;
      color: #E0E7FF !important;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12), 0 4px 12px rgba(0, 0, 0, 0.2) !important;
      transition: all 0.2s ease !important;
    }

    .bg-sidebar [data-testid="new-conversation-button"]:hover {
      background: linear-gradient(135deg, rgba(139, 92, 246, 0.28), rgba(56, 189, 248, 0.18)) !important;
      border-color: rgba(165, 180, 252, 0.45) !important;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.2), 0 4px 18px rgba(139, 92, 246, 0.25) !important;
      transform: translateY(-1px) !important;
    }

    /* 文件夹标题去胶囊化，用字号与灰度建立树状层级 */
    .bg-sidebar [data-testid="project-header"] {
      background: transparent !important;
      border: 1px solid transparent !important;
      border-radius: 8px !important;
      box-shadow: none !important;
      color: #8394AA !important;
      transform: none !important;
    }

    .bg-sidebar [data-testid="project-header"] span {
      color: #8394AA !important;
      font-size: 12px !important;
      font-weight: 600 !important;
      letter-spacing: 0.03em !important;
    }

    .bg-sidebar [data-testid="project-header"]:hover {
      background: rgba(255, 255, 255, 0.04) !important;
      color: var(--ag-text-secondary) !important;
    }

    .bg-sidebar [data-testid="project-header"]:hover span {
      color: var(--ag-text-secondary) !important;
    }

    /* 侧边栏底部留白，彻底防止左下角看板娘遮挡 "See all" 与底部项目 */
    .bg-sidebar .overflow-y-auto {
      padding-bottom: 140px !important;
    }

    /* 3. 主对话滚动区：顶部渐隐防穿帮 + AI 回复微晶底衬 */
    .isolate.h-full.overflow-y-auto,
    main > div[style*="overflow"] {
      mask-image: linear-gradient(to bottom, transparent 0px, #000 36px, #000 calc(100% - 20px), transparent 100%) !important;
      -webkit-mask-image: linear-gradient(to bottom, transparent 0px, #000 36px, #000 calc(100% - 20px), transparent 100%) !important;
    }

    /* AI 回复正文容器：微透毛玻璃底衬，彻底解决白字与壁纸打架 */
    .scroll-mt-4 > [role="article"][aria-label="Agent response"] {
      background: var(--ag-chat-pad) !important;
      backdrop-filter: blur(14px) saturate(140%) !important;
      -webkit-backdrop-filter: blur(14px) saturate(140%) !important;
      border: 1px solid var(--ag-border-hairline) !important;
      border-radius: 14px !important;
      padding: 16px 22px !important;
      margin-top: 6px !important;
      margin-bottom: 8px !important;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.26) !important;
      color: var(--ag-text-primary) !important;
      line-height: 1.68 !important;
    }

    /* Markdown 排版层级：标题、正文、列表与强调统一到冷白阅读色 */
    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] {
      font-size: 14px !important;
      line-height: 1.72 !important;
      letter-spacing: 0.002em !important;
    }

    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] h1,
    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] h2,
    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] h3,
    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] h4 {
      color: #F8FAFC !important;
      font-weight: 600 !important;
      letter-spacing: -0.012em !important;
    }

    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] h1 { font-size: 20px !important; }
    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] h2 { font-size: 18px !important; }
    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] h3 { font-size: 15.5px !important; }
    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] h4 { font-size: 14px !important; }

    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] p,
    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] li {
      color: #E2E8F0 !important;
    }

    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] li {
      margin: 3px 0 !important;
    }

    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] strong,
    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] b {
      color: #F8FAFC !important;
    }

    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] a {
      color: var(--ag-accent-starlight) !important;
      text-decoration: underline !important;
      text-decoration-color: rgba(165, 180, 252, 0.35) !important;
      text-underline-offset: 2px !important;
    }

    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] blockquote {
      background: rgba(148, 163, 184, 0.07) !important;
      border-left: 2px solid rgba(165, 180, 252, 0.65) !important;
      border-radius: 0 8px 8px 0 !important;
      padding: 10px 14px !important;
      color: #CBD5E1 !important;
    }

    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] mark {
      background: rgba(252, 211, 77, 0.18) !important;
      color: #FDE68A !important;
      border-radius: 3px !important;
      padding: 1px 3px !important;
    }

    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] th {
      background: rgba(148, 163, 184, 0.10) !important;
      color: #CBD5E1 !important;
      font-weight: 600 !important;
      border-bottom: 1px solid rgba(255, 255, 255, 0.10) !important;
    }

    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] td {
      color: #DDE5EF !important;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06) !important;
    }

    /* 思考过程/折叠栏微光按钮 */
    .scroll-mt-4 > [role="article"][aria-label="Agent response"] button.group {
      background: rgba(255, 255, 255, 0.04) !important;
      border: 1px solid rgba(255, 255, 255, 0.06) !important;
      border-radius: 8px !important;
      margin-bottom: 8px !important;
      color: var(--ag-text-secondary) !important;
    }

    .scroll-mt-4 > [role="article"][aria-label="Agent response"] button.group:hover {
      background: rgba(255, 255, 255, 0.08) !important;
      color: var(--ag-text-primary) !important;
    }

    /* 4. 用户提问气泡：右对齐自适应宽度 + 高遮蔽毛玻璃，防重影并收敛体量 */
    .sticky.top-0.z-10,
    .md-sticky-message-bleed {
      background: transparent !important;
      border-radius: 14px !important;
    }

    /* 默认不吸顶：提问气泡随内容滚走 */
    [data-testid="autoscroll-viewport"] .sticky.top-0.z-10:has([data-testid="user-input-step"]) {
      position: relative !important;
      top: auto !important;
    }

    /* 可选紧凑吸顶：控制面板开启后才恢复 sticky，并在吸顶时压成一行 */
    html.ag-prompt-sticky [data-testid="autoscroll-viewport"] .sticky.top-0.z-10:has([data-testid="user-input-step"]) {
      position: sticky !important;
      top: 0 !important;
    }

    html.ag-prompt-sticky [data-testid="autoscroll-viewport"] .sticky.top-0.z-10.ag-prompt-stuck:has([data-testid="user-input-step"]) {
      display: flex !important;
      align-items: center !important;
      height: 38px !important;
      max-height: 38px !important;
      padding: 0 12px !important;
      margin-bottom: 8px !important;
      overflow: hidden !important;
      background: rgba(13, 10, 26, 0.92) !important;
      border: 1px solid rgba(246, 216, 147, 0.14) !important;
      border-radius: 12px !important;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35) !important;
      backdrop-filter: blur(18px) saturate(140%) !important;
      -webkit-backdrop-filter: blur(18px) saturate(140%) !important;
      transition: background-color 180ms ease, border-color 180ms ease !important;
    }

    html.ag-prompt-sticky [data-testid="autoscroll-viewport"] .sticky.top-0.z-10.ag-prompt-stuck:has([data-testid="user-input-step"]) > * {
      display: none !important;
    }

    html.ag-prompt-sticky [data-testid="autoscroll-viewport"] .sticky.top-0.z-10.ag-prompt-stuck:has([data-testid="user-input-step"])::before {
      content: "✦  " attr(data-ag-prompt-preview);
      display: block !important;
      width: 100% !important;
      overflow: hidden !important;
      color: var(--ag-text-primary, #E7E2F3) !important;
      font-size: 11px !important;
      line-height: 36px !important;
      white-space: nowrap !important;
      text-overflow: ellipsis !important;
    }

    .md-sticky-message-bleed::before,
    .md-sticky-message-bleed::after {
      display: none !important;
      background: transparent !important;
    }

    .absolute.bottom-0.z-10.pointer-events-none.left-4 {
      background: transparent !important;
      background-image: none !important;
    }

    [data-testid="title-menu-bar"] {
      position: relative !important;
      z-index: 9000 !important;
    }

    [data-testid="title-menu-bar"] .absolute.top-full.left-0.mt-1 {
      min-width: 232px !important;
      padding: 5px !important;
      background: #0D1020 !important;
      border: 1px solid rgba(165, 180, 252, 0.18) !important;
      border-radius: 9px !important;
      box-shadow:
        0 18px 42px rgba(0, 0, 0, 0.52),
        inset 0 1px 0 rgba(255, 255, 255, 0.06) !important;
      backdrop-filter: blur(20px) saturate(1.5) !important;
      -webkit-backdrop-filter: blur(20px) saturate(1.5) !important;
      opacity: 1 !important;
    }

    [data-testid="title-menu-bar"] [data-testid="title-menu-bar-option"] {
      min-height: 29px !important;
      padding: 6px 9px !important;
      border-radius: 6px !important;
      color: #CBD7E7 !important;
      font-size: 11.5px !important;
      line-height: 1.3 !important;
      opacity: 1 !important;
      transition: background-color 120ms ease, color 120ms ease !important;
    }

    [data-testid="title-menu-bar"] [data-testid="title-menu-bar-option"]:hover {
      background: rgba(165, 180, 252, 0.10) !important;
      color: #F1F5F9 !important;
    }

    [data-testid="title-menu-bar"] [data-testid="title-menu-bar-option"] span:not(:only-child):last-child {
      color: #6F8198 !important;
      font-size: 9.5px !important;
      font-weight: 400 !important;
    }

    [data-testid="title-menu-bar"] .absolute.top-full.left-0.mt-1 .border-t,
    [data-testid="title-menu-bar"] .absolute.top-full.left-0.mt-1 [role="separator"] {
      margin: 4px 5px !important;
      border-color: rgba(255, 255, 255, 0.07) !important;
    }

    .group\\/user-input-step {
      width: fit-content !important;
      max-width: min(88%, 720px) !important;
      min-width: 0 !important;
      align-self: flex-end !important;
      margin-left: auto !important;
      margin-bottom: 0px !important;
      background: var(--ag-card-elevated) !important;
      backdrop-filter: blur(28px) saturate(180%) !important;
      -webkit-backdrop-filter: blur(28px) saturate(180%) !important;
      border: 1px solid rgba(165, 180, 252, 0.2) !important;
      border-radius: 14px !important;
      padding: 10px 16px !important;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.12),
        0 10px 30px -5px rgba(5, 7, 18, 0.65) !important;
      color: var(--ag-text-primary) !important;
    }

    .group\\/user-input-step > * {
      max-width: 100% !important;
    }

    .group\\/user-input-step p {
      color: #EAF1F8 !important;
      line-height: 1.65 !important;
    }

    /* 用户气泡内图片附件 */
    .group\\/user-input-step img {
      border-radius: 8px !important;
      border: 1px solid rgba(255, 255, 255, 0.15) !important;
    }

    /* 5. 行内代码与代码块：消除“紫斑效应” */
    :not(pre) > code {
      background: rgba(148, 163, 184, 0.14) !important;
      border: 1px solid rgba(255, 255, 255, 0.08) !important;
      color: #C7D2FE !important;
      border-radius: 5px !important;
      padding: 2px 6px !important;
      font-size: 0.88em !important;
      box-shadow: none !important;
    }

    pre,
    .code-block {
      background: rgba(9, 11, 22, 0.82) !important;
      backdrop-filter: blur(16px) !important;
      -webkit-backdrop-filter: blur(16px) !important;
      border: 1px solid rgba(255, 255, 255, 0.08) !important;
      border-radius: 10px !important;
      padding: 14px 16px !important;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 8px 24px rgba(0, 0, 0, 0.35) !important;
    }

    pre code {
      background: transparent !important;
      border: 0 !important;
      color: #D6E2F0 !important;
      font-size: 12.5px !important;
      line-height: 1.65 !important;
      padding: 0 !important;
      box-shadow: none !important;
    }

    /* 6. 底部悬浮输入岛：星轨流光边框 + 光学玻璃底 */
    @property --ag-composer-angle {
      syntax: "<angle>";
      inherits: false;
      initial-value: 0deg;
    }

    #antigravity\\.agentSidePanelInputBox,
    .surface-composer {
      position: relative !important;
      isolation: isolate !important;
      background:
        radial-gradient(120% 160% at 12% 0%, rgba(165, 180, 252, 0.07) 0%, transparent 55%),
        rgba(16, 19, 36, 0.88) !important;
      backdrop-filter: blur(24px) saturate(180%) !important;
      -webkit-backdrop-filter: blur(24px) saturate(180%) !important;
      border: 1px solid rgba(255, 255, 255, 0.1) !important;
      border-radius: 16px !important;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.14),
        0 12px 32px rgba(0, 0, 0, 0.45) !important;
      transition:
        border-color 200ms ease-out,
        box-shadow 200ms ease-out,
        background-color 240ms ease-out !important;
    }

    /* 仅描边区域显示，避免流光覆盖输入内容 */
    #antigravity\\.agentSidePanelInputBox::before,
    .surface-composer::before {
      content: "" !important;
      position: absolute !important;
      inset: -1.5px !important;
      z-index: 5 !important;
      padding: 1.5px !important;
      border-radius: 17.5px !important;
      background: conic-gradient(
        from var(--ag-composer-angle),
        rgba(255, 255, 255, 0.04) 0deg,
        rgba(165, 180, 252, 0.98) 42deg,
        rgba(125, 211, 252, 0.86) 64deg,
        rgba(252, 211, 77, 0.72) 84deg,
        rgba(255, 255, 255, 0.28) 104deg,
        rgba(255, 255, 255, 0.04) 128deg,
        rgba(255, 255, 255, 0.04) 360deg
      ) !important;
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0) !important;
      -webkit-mask-composite: xor !important;
      mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0) !important;
      mask-composite: exclude !important;
      filter:
        drop-shadow(0 0 5px rgba(165, 180, 252, 0.32))
        drop-shadow(0 0 12px rgba(125, 211, 252, 0.14)) !important;
      opacity: 0 !important;
      pointer-events: none !important;
      transition: opacity 220ms ease-out !important;
      animation: ag-composer-orbit 3.8s linear infinite !important;
      animation-play-state: paused !important;
    }

    #antigravity\\.agentSidePanelInputBox:hover::before,
    .surface-composer:hover::before {
      opacity: 0.34 !important;
    }

    #antigravity\\.agentSidePanelInputBox:focus-within::before,
    .surface-composer:focus-within::before {
      opacity: 1 !important;
      animation-play-state: running !important;
    }

    @keyframes ag-composer-orbit {
      to {
        --ag-composer-angle: 360deg;
      }
    }

    #antigravity\\.agentSidePanelInputBox:focus-within,
    .surface-composer:focus-within {
      background:
        radial-gradient(115% 150% at 16% 0%, rgba(165, 180, 252, 0.13) 0%, transparent 56%),
        radial-gradient(90% 130% at 90% 100%, rgba(252, 211, 77, 0.055) 0%, transparent 62%),
        rgba(16, 19, 36, 0.92) !important;
      border-color: rgba(165, 180, 252, 0.16) !important;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.2),
        0 14px 40px rgba(0, 0, 0, 0.55),
        0 0 28px -6px rgba(165, 180, 252, 0.24),
        0 0 30px -10px rgba(252, 211, 77, 0.10) !important;
    }

    .surface-composer-card {
      background: transparent !important;
    }

    #antigravity\\.agentSidePanelInputBox [contenteditable="true"],
    #antigravity\\.agentSidePanelInputBox textarea {
      color: var(--ag-text-primary) !important;
      caret-color: var(--ag-accent-starlight) !important;
    }

    #antigravity\\.agentSidePanelInputBox p.pointer-events-none.absolute,
    #antigravity\\.agentSidePanelInputBox textarea::placeholder {
      color: rgba(148, 163, 184, 0.78) !important;
      opacity: 1 !important;
    }

    #antigravity\\.agentSidePanelInputBox ::selection,
    .surface-composer ::selection {
      background: rgba(165, 180, 252, 0.34) !important;
      color: #FFFFFF !important;
    }

    .surface-composer [class*="input-footer"] {
      margin-top: 3px !important;
      padding-top: 5px !important;
      border-top: 1px solid rgba(255, 255, 255, 0.05) !important;
    }

    .surface-composer button[aria-label="Add context"] {
      background: rgba(255, 255, 255, 0.035) !important;
      border: 1px solid rgba(255, 255, 255, 0.055) !important;
      color: #AAB8CC !important;
      transition: background-color 160ms ease-out, color 160ms ease-out !important;
    }

    .surface-composer button[aria-label="Add context"]:hover {
      background: rgba(255, 255, 255, 0.075) !important;
      color: #F1F5F9 !important;
    }

    .surface-composer [data-testid="model-selector-trigger"] {
      color: #B9C6D8 !important;
      border-radius: 6px !important;
      transition: background-color 160ms ease-out, color 160ms ease-out !important;
    }

    .surface-composer [data-testid="model-selector-trigger"]:hover {
      background: rgba(255, 255, 255, 0.05) !important;
      color: #F1F5F9 !important;
    }

    /* 图片附件：长按拖动排序的抬升与落点反馈 */
    .surface-composer [data-testid="input-attachment"] {
      position: relative !important;
      cursor: grab !important;
      transition: transform 160ms ease, box-shadow 160ms ease, opacity 160ms ease !important;
      -webkit-touch-callout: none !important;
      -webkit-user-drag: none !important;
      user-select: none !important;
      touch-action: none !important;
    }

    .surface-composer [data-testid="input-attachment"] img,
    .surface-composer [data-testid="input-attachment"] a {
      -webkit-user-drag: none !important;
      user-select: none !important;
      pointer-events: auto;
    }

    .surface-composer [data-testid="input-attachment"].ag-attachment-lifted {
      z-index: 30 !important;
      opacity: 0.88 !important;
      box-shadow:
        0 10px 26px rgba(0, 0, 0, 0.50),
        0 0 16px -4px rgba(165, 180, 252, 0.55) !important;
      transition: none !important;
    }

    .surface-composer [data-testid="input-attachment"][data-ag-drop-target="true"]::after {
      content: "" !important;
      position: absolute !important;
      inset: -4px !important;
      border: 1px dashed rgba(165, 180, 252, 0.92) !important;
      border-radius: 8px !important;
      box-shadow: 0 0 12px -2px rgba(125, 211, 252, 0.55) !important;
      pointer-events: none !important;
    }

    html.ag-attachment-reordering,
    html.ag-attachment-reordering * {
      cursor: grabbing !important;
      user-select: none !important;
    }

    @media (prefers-reduced-motion: reduce) {
      #antigravity\\.agentSidePanelInputBox::before,
      .surface-composer::before,
      .agy-sidebar-row[data-selected="true"],
      .agy-sidebar-row[data-selected="true"]::before,
      .agy-sidebar-row[data-selected="true"]::after,
      [role="menu"],
      [role="listbox"] {
        animation: none !important;
      }
    }

    /* 7. /、@、模型选择菜单：统一的星夜浮层、入场展开与键盘选中态 */
    [role="menu"],
    [role="listbox"] {
      background:
        radial-gradient(120% 160% at 12% 0%, rgba(165, 180, 252, 0.08) 0%, transparent 58%),
        linear-gradient(180deg, rgba(18, 21, 40, 0.97) 0%, rgba(10, 13, 26, 0.96) 100%) !important;
      color: #DDE5F0 !important;
      border: 1px solid rgba(165, 180, 252, 0.15) !important;
      border-radius: 12px !important;
      box-shadow:
        0 20px 56px rgba(0, 0, 0, 0.58),
        0 0 30px -18px rgba(125, 211, 252, 0.38),
        inset 0 1px 0 rgba(255, 255, 255, 0.08) !important;
      backdrop-filter: blur(26px) saturate(165%) !important;
      -webkit-backdrop-filter: blur(26px) saturate(165%) !important;
      animation: ag-menu-reveal 180ms cubic-bezier(0.2, 0.8, 0.2, 1) !important;
    }

    [role="menu"] [role="menuitem"],
    [role="listbox"] [role="option"] {
      color: #C3CFDF !important;
      border-radius: 7px !important;
      border: 1px solid transparent !important;
      transition: background-color 130ms ease-out, color 130ms ease-out, box-shadow 130ms ease-out !important;
    }

    /* 选项内部的原生灰底不遮住星云选中层 */
    [role="menu"] [role="menuitem"] > div,
    [role="listbox"] [role="option"] > div {
      background-color: transparent !important;
    }

    [role="menu"] [role="menuitem"][aria-selected="true"] [data-testid="menu-option-label"],
    [role="listbox"] [role="option"][aria-selected="true"] [data-testid="menu-option-label"],
    [role="listbox"] [role="option"]:hover [data-testid="menu-option-label"] {
      color: #FFFFFF !important;
    }

    [role="listbox"] [role="option"][aria-selected="true"] [data-testid="menu-option-description"],
    [role="listbox"] [role="option"]:hover [data-testid="menu-option-description"] {
      color: rgba(203, 213, 225, 0.66) !important;
      opacity: 1 !important;
    }

    [role="menu"] [role="menuitem"]:hover,
    [role="menu"] [role="menuitem"]:focus,
    [role="menu"] [role="menuitem"][data-highlighted],
    [role="menu"] [role="menuitem"][aria-selected="true"],
    [role="listbox"] [role="option"]:hover,
    [role="listbox"] [role="option"]:focus,
    [role="listbox"] [role="option"][data-highlighted],
    [role="listbox"] [role="option"][aria-selected="true"] {
      background: linear-gradient(90deg, rgba(165, 180, 252, 0.16) 0%, rgba(125, 211, 252, 0.055) 62%, rgba(252, 211, 77, 0.035) 100%) !important;
      color: #FFFFFF !important;
      border-color: rgba(165, 180, 252, 0.08) !important;
      box-shadow: inset 2px 0 0 rgba(165, 180, 252, 0.90) !important;
      outline: none !important;
    }

    [role="menu"] [role="menuitem"]:hover svg,
    [role="menu"] [role="menuitem"]:focus svg,
    [role="menu"] [role="menuitem"][data-highlighted] svg,
    [role="menu"] [role="menuitem"][aria-selected="true"] svg,
    [role="listbox"] [role="option"]:hover svg,
    [role="listbox"] [role="option"]:focus svg,
    [role="listbox"] [role="option"][data-highlighted] svg,
    [role="listbox"] [role="option"][aria-selected="true"] svg {
      color: #A5B4FC !important;
    }

    [role="menu"] [role="separator"],
    [role="listbox"] [role="separator"] {
      height: 1px !important;
      margin: 4px 6px !important;
      background: rgba(255, 255, 255, 0.07) !important;
    }

    [role="menu"] [role="group"] > [role="presentation"],
    [role="menu"] [data-slot="label"],
    [role="listbox"] [data-slot="label"] {
      color: #7E8FA7 !important;
      font-size: 10.5px !important;
      font-weight: 600 !important;
      letter-spacing: 0.06em !important;
    }

    @keyframes ag-menu-reveal {
      from {
        opacity: 0;
        clip-path: inset(8px 0 0 0 round 12px);
        filter: blur(3px);
      }
      to {
        opacity: 1;
        clip-path: inset(0 0 0 0 round 12px);
        filter: blur(0);
      }
    }

    /* 8. 文件改动与 Diff 工具栏；时间戳保持轻量，不套玻璃卡片 */
    .scroll-mt-4 > div.pt-3 {
      background: transparent !important;
      border: 0 !important;
      box-shadow: none !important;
      padding: 6px 4px !important;
      color: var(--ag-text-muted) !important;
    }

    .scroll-mt-4 [data-testid*="file-change"],
    .scroll-mt-4 [class*="file-changes"] {
      background: rgba(15, 17, 32, 0.75) !important;
      backdrop-filter: blur(12px) !important;
      border: 1px solid var(--ag-border-hairline) !important;
      border-radius: 10px !important;
      padding: 6px 12px !important;
      margin-top: 4px !important;
    }

    /* Review 按钮微光胶囊 */
    .scroll-mt-4 [data-testid*="file-change"] button:hover,
    .scroll-mt-4 [class*="file-changes"] button:hover {
      background: linear-gradient(135deg, rgba(139, 92, 246, 0.22) 0%, rgba(99, 102, 241, 0.15) 100%) !important;
      border: 1px solid rgba(165, 180, 252, 0.28) !important;
      border-radius: 8px !important;
    }

    /* 8. 滚动条与选中文本 */
    ::-webkit-scrollbar {
      width: 4px !important;
      height: 4px !important;
    }

    ::-webkit-scrollbar-thumb {
      background: rgba(148, 163, 184, 0.22) !important;
      border-radius: 999px !important;
    }

    ::-webkit-scrollbar-thumb:hover {
      background: rgba(165, 180, 252, 0.48) !important;
    }

    ::selection {
      background: rgba(129, 140, 248, 0.32) !important;
      color: #FFFFFF !important;
    }

    /* 9. 顶部标题栏磨砂 */
    header, [class*="titlebar"], [class*="header"] {
      background: rgba(10, 12, 22, 0.55) !important;
      backdrop-filter: blur(16px) !important;
      -webkit-backdrop-filter: blur(16px) !important;
    }

    /* 10. 看板娘防遮挡穿透与投影 */
    [class*="mascot"],
    [class*="pet-widget"],
    img[src*="mascot"],
    img[src*="chibi"],
    iframe[src*="hakimi"],
    iframe[src*="mascot"],
    iframe[src*="chibi"] {
      pointer-events: none !important;
      filter: drop-shadow(0 8px 20px rgba(5, 7, 18, 0.75)) !important;
    }

    /* 11. 侧栏顶部导航：与选中会话使用同一套星云层级 */
    .bg-sidebar > .px-2 a:not([data-testid="new-conversation-button"]),
    .bg-sidebar > .px-2 button:not([data-testid="new-conversation-button"]) {
      background: transparent !important;
      border: 1px solid transparent !important;
      border-radius: 8px !important;
      color: #9AABC1 !important;
      transition: background-color 160ms ease, color 160ms ease, box-shadow 160ms ease !important;
    }

    .bg-sidebar > .px-2 a:not([data-testid="new-conversation-button"]):hover,
    .bg-sidebar > .px-2 button:not([data-testid="new-conversation-button"]):hover {
      background: rgba(255, 255, 255, 0.05) !important;
      color: #F1F5F9 !important;
    }

    .bg-sidebar > .px-2 a.bg-sidebar-secondary,
    .bg-sidebar > .px-2 button.bg-sidebar-secondary,
    .bg-sidebar > .px-2 [aria-current="page"] {
      background: linear-gradient(90deg, rgba(139, 92, 246, 0.26) 0%, rgba(56, 189, 248, 0.10) 100%) !important;
      border-color: rgba(165, 180, 252, 0.16) !important;
      color: #F8FAFC !important;
      box-shadow: inset 2px 0 0 #A5B4FC, 0 4px 18px -12px rgba(125, 211, 252, 0.55) !important;
    }

    /* 12. 选中会话强化：更明显的渐变填充、外晕与流光边 */
    .agy-sidebar-row[data-selected="true"] {
      background:
        linear-gradient(90deg, rgba(139, 92, 246, 0.36) 0%, rgba(56, 189, 248, 0.16) 54%, rgba(252, 211, 77, 0.085) 100%) !important;
      box-shadow:
        inset 0 0 0 1px rgba(255, 255, 255, 0.075),
        inset 0 0 30px rgba(139, 92, 246, 0.20),
        0 5px 24px -12px rgba(125, 211, 252, 0.66) !important;
      animation: ag-selected-aurora 3.8s ease-in-out infinite !important;
    }

    .agy-sidebar-row[data-selected="true"]::before {
      opacity: 1 !important;
      animation-duration: 5s !important;
    }

    .agy-sidebar-row[data-selected="true"] > div:first-of-type span {
      font-weight: 600 !important;
      color: #FFFFFF !important;
    }

    /* 13. 智能体思考态：彩虹旋转描边 + 呼吸光带 */
    @property --ag-thinking-angle {
      syntax: "<angle>";
      inherits: false;
      initial-value: 0deg;
    }

    .agy-sidebar-row:has([class*="animate-spin"]),
    .agy-sidebar-row:has([aria-label="Stop execution"]),
    .agy-sidebar-row:has([data-testid*="conversation-stop"]),
    .agy-sidebar-row[aria-busy="true"],
    .agy-sidebar-row[data-streaming="true"] {
      background:
        linear-gradient(90deg, rgba(139, 92, 246, 0.30) 0%, rgba(56, 189, 248, 0.15) 48%, rgba(252, 211, 77, 0.09) 100%) !important;
      box-shadow:
        inset 0 0 0 1px rgba(255, 255, 255, 0.08),
        inset 0 0 24px rgba(56, 189, 248, 0.12),
        0 0 22px -12px rgba(165, 180, 252, 0.85) !important;
    }

    .agy-sidebar-row:has([class*="animate-spin"])::before,
    .agy-sidebar-row:has([aria-label="Stop execution"])::before,
    .agy-sidebar-row:has([data-testid*="conversation-stop"])::before,
    .agy-sidebar-row[aria-busy="true"]::before,
    .agy-sidebar-row[data-streaming="true"]::before {
      background: conic-gradient(
        from var(--ag-thinking-angle),
        rgba(165, 180, 252, 0.95),
        rgba(125, 211, 252, 0.62),
        rgba(252, 211, 77, 0.72),
        rgba(240, 171, 252, 0.58),
        rgba(165, 180, 252, 0.95)
      ) !important;
      opacity: 1 !important;
      animation: ag-thinking-orbit 2.4s linear infinite !important;
    }

    .agy-sidebar-row:has([class*="animate-spin"])::after,
    .agy-sidebar-row:has([aria-label="Stop execution"])::after,
    .agy-sidebar-row:has([data-testid*="conversation-stop"])::after,
    .agy-sidebar-row[aria-busy="true"]::after,
    .agy-sidebar-row[data-streaming="true"]::after {
      background: linear-gradient(180deg, #A5B4FC 0%, #7DD3FC 38%, #FCD34D 72%, #F0ABFC 100%) !important;
      box-shadow: 0 0 12px rgba(125, 211, 252, 0.88) !important;
    }

    .agy-sidebar-row .animate-spin,
    .agy-sidebar-row [aria-label="Stop execution"] svg {
      color: #C7D2FE !important;
      filter: drop-shadow(0 0 5px rgba(165, 180, 252, 0.75)) drop-shadow(0 0 9px rgba(125, 211, 252, 0.28)) !important;
    }

    .agy-sidebar-row [aria-label="Stop execution"] svg {
      animation: ag-thinking-hue 3s linear infinite !important;
    }

    @keyframes ag-thinking-orbit {
      to { --ag-thinking-angle: 360deg; }
    }

    @keyframes ag-thinking-hue {
      to { filter: hue-rotate(360deg) drop-shadow(0 0 6px rgba(165, 180, 252, 0.72)); }
    }

    /* 14. Automations / 自定义配置等 sidecar 页面 */
    [data-testid="sidecars-view"] {
      background:
        radial-gradient(80% 110% at 88% 12%, rgba(139, 92, 246, 0.085) 0%, transparent 62%),
        linear-gradient(90deg, rgba(9, 11, 22, 0.72) 0%, rgba(9, 11, 22, 0.52) 100%) !important;
      backdrop-filter: blur(4px) saturate(130%) !important;
      -webkit-backdrop-filter: blur(4px) saturate(130%) !important;
    }

    [data-testid="sidecars-view"] [data-testid="sidecar-list-empty"] {
      opacity: 0.82 !important;
    }

    [data-testid="sidecars-view"] h1 {
      color: #F8FAFC !important;
      font-weight: 600 !important;
      letter-spacing: -0.01em !important;
    }

    [data-testid="sidecars-view"] .bg-muted {
      background: rgba(13, 16, 30, 0.68) !important;
      border-color: rgba(255, 255, 255, 0.08) !important;
    }

    [data-testid="sidecars-view"] .bg-secondary {
      background: rgba(255, 255, 255, 0.055) !important;
      color: #B9C6D8 !important;
    }

    [data-testid="sidecars-view"] .bg-secondary:hover {
      background: rgba(255, 255, 255, 0.09) !important;
      color: #F1F5F9 !important;
    }

    [data-testid="sidecars-view"] .border-border {
      border-color: rgba(255, 255, 255, 0.08) !important;
    }

    [data-testid="sidecars-view"] .text-muted-foreground {
      color: #8FA0B6 !important;
    }

    [data-testid="sidecars-view"] input::placeholder {
      color: rgba(148, 163, 184, 0.66) !important;
    }

    /* 15. 设置弹层 */
    .settings-modal-backdrop {
      background: rgba(4, 6, 14, 0.56) !important;
      backdrop-filter: blur(9px) saturate(120%) !important;
      -webkit-backdrop-filter: blur(9px) saturate(120%) !important;
    }

    .settings-modal-container {
      background:
        radial-gradient(120% 150% at 8% 0%, rgba(165, 180, 252, 0.10) 0%, transparent 56%),
        linear-gradient(180deg, rgba(15, 18, 34, 0.95) 0%, rgba(8, 10, 20, 0.96) 100%) !important;
      border: 1px solid rgba(255, 255, 255, 0.10) !important;
      border-radius: 18px !important;
      box-shadow:
        0 30px 80px rgba(0, 0, 0, 0.66),
        inset 0 1px 0 rgba(255, 255, 255, 0.08) !important;
      backdrop-filter: blur(30px) saturate(160%) !important;
      -webkit-backdrop-filter: blur(30px) saturate(160%) !important;
    }

    .settings-modal-container .bg-background {
      background: transparent !important;
    }

    .settings-modal-container .bg-sidebar {
      background: rgba(10, 13, 26, 0.52) !important;
      border-right: 1px solid rgba(255, 255, 255, 0.06) !important;
      backdrop-filter: blur(18px) !important;
    }

    .settings-modal-container [data-testid^="settings-nav-item-"] {
      color: #95A6BD !important;
      border: 1px solid transparent !important;
      border-radius: 8px !important;
      transition: background-color 150ms ease, color 150ms ease, box-shadow 150ms ease !important;
    }

    .settings-modal-container [data-testid^="settings-nav-item-"]:hover {
      background: rgba(255, 255, 255, 0.05) !important;
      color: #F1F5F9 !important;
    }

    .settings-modal-container [data-testid^="settings-nav-item-"].bg-sidebar-muted,
    .settings-modal-container [data-testid^="settings-nav-item-"].bg-sidebar-secondary,
    .settings-modal-container [data-testid^="settings-nav-item-"].bg-secondary {
      background: linear-gradient(90deg, rgba(139, 92, 246, 0.26) 0%, rgba(56, 189, 248, 0.09) 100%) !important;
      border-color: rgba(165, 180, 252, 0.12) !important;
      color: #FFFFFF !important;
      box-shadow: inset 2px 0 0 #A5B4FC !important;
    }

    .settings-modal-container h1,
    .settings-modal-container h2,
    .settings-modal-container h3 {
      color: #F1F5F9 !important;
      letter-spacing: -0.01em !important;
    }

    .settings-modal-container .text-muted-foreground {
      color: #8FA0B6 !important;
    }

    .settings-modal-container select,
    .settings-modal-container input[type="text"],
    .settings-modal-container [role="combobox"] {
      background: rgba(255, 255, 255, 0.045) !important;
      border-color: rgba(255, 255, 255, 0.09) !important;
      color: #E2E8F0 !important;
      border-radius: 8px !important;
    }

    .settings-modal-container .bg-card {
      background: rgba(17, 20, 36, 0.72) !important;
    }

    .settings-modal-container button.bg-secondary {
      background: rgba(255, 255, 255, 0.045) !important;
      border: 1px solid rgba(255, 255, 255, 0.065) !important;
      color: #AEBCCD !important;
      transition: background-color 150ms ease, color 150ms ease, border-color 150ms ease !important;
    }

    .settings-modal-container button.bg-secondary:hover {
      background: rgba(255, 255, 255, 0.085) !important;
      border-color: rgba(165, 180, 252, 0.14) !important;
      color: #F1F5F9 !important;
    }

    /* 设置 Skill 列表：两列卡片 */
    .settings-modal-container .ag-skill-grid {
      display: grid !important;
      grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
      gap: 10px !important;
      border: 0 !important;
      border-radius: 0 !important;
      overflow: visible !important;
    }

    .settings-modal-container .ag-skill-card {
      min-height: 124px !important;
      padding: 10px 11px !important;
      border: 1px solid rgba(255, 255, 255, 0.075) !important;
      border-radius: 11px !important;
      background:
        radial-gradient(120% 150% at 10% 0%, rgba(165, 180, 252, 0.055) 0%, transparent 56%),
        rgba(255, 255, 255, 0.022) !important;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035) !important;
      transition: border-color 160ms ease, background-color 160ms ease, transform 160ms ease !important;
    }

    .settings-modal-container .ag-skill-card:hover {
      border-color: rgba(165, 180, 252, 0.22) !important;
      background:
        radial-gradient(120% 150% at 10% 0%, rgba(165, 180, 252, 0.09) 0%, transparent 58%),
        rgba(255, 255, 255, 0.035) !important;
      transform: translateY(-1px) !important;
    }

    .settings-modal-container .ag-skill-card .line-clamp-2 {
      display: -webkit-box !important;
      overflow: hidden !important;
      -webkit-line-clamp: 3 !important;
      -webkit-box-orient: vertical !important;
      line-height: 1.45 !important;
    }

    .ag-skill-folder {
      width: 20px !important;
      height: 20px !important;
      padding: 0 !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      border: 0 !important;
      border-radius: 5px !important;
      background: transparent !important;
      color: #7E90A6 !important;
      cursor: pointer !important;
      opacity: 0.65 !important;
      transition: opacity 140ms ease, background-color 140ms ease, color 140ms ease !important;
    }

    .ag-skill-card:hover .ag-skill-folder,
    .ag-skill-folder:focus-visible {
      opacity: 1 !important;
    }

    .ag-skill-folder:hover {
      color: #C7D2FE !important;
      background: rgba(165, 180, 252, 0.10) !important;
    }

    .ag-skill-folder svg {
      width: 14px !important;
      height: 14px !important;
    }

    /* 自定义配置（插件市场 / Skills & Rules） */
    body.ag-customizations-page .flex-1.flex.flex-col.overflow-hidden.h-full.min-h-0.bg-background {
      background:
        radial-gradient(115% 90% at 72% 8%, rgba(139, 92, 246, 0.10) 0%, transparent 55%),
        linear-gradient(180deg, rgba(8, 10, 20, 0.48) 0%, rgba(8, 10, 20, 0.30) 100%) !important;
    }

    body.ag-customizations-page [data-testid="plugins-tabs"] {
      background: rgba(13, 16, 30, 0.76) !important;
      border-color: rgba(255, 255, 255, 0.08) !important;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04) !important;
    }

    body.ag-customizations-page [data-testid="plugins-tabs"] a {
      color: #91A3B9 !important;
    }

    body.ag-customizations-page [data-testid="plugins-tabs"] a:hover {
      color: #E2EAF5 !important;
      background: rgba(165, 180, 252, 0.08) !important;
    }

    body.ag-customizations-page [data-testid="customization-card"] {
      background:
        radial-gradient(120% 150% at 8% 0%, rgba(165, 180, 252, 0.055) 0%, transparent 58%),
        rgba(14, 17, 34, 0.58) !important;
      border: 1px solid rgba(255, 255, 255, 0.07) !important;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.04),
        0 10px 26px rgba(0, 0, 0, 0.16) !important;
      transition: border-color 150ms ease, background-color 150ms ease, transform 150ms ease !important;
    }

    body.ag-customizations-page [data-testid="customization-card"]:hover {
      background:
        radial-gradient(120% 150% at 8% 0%, rgba(165, 180, 252, 0.09) 0%, transparent 60%),
        rgba(18, 21, 40, 0.70) !important;
      border-color: rgba(165, 180, 252, 0.22) !important;
      transform: translateY(-1px) !important;
    }

    body.ag-customizations-page input[placeholder*="Search customizations"],
    body.ag-customizations-page input[placeholder*="搜索"] {
      background: rgba(13, 16, 30, 0.72) !important;
      border-color: rgba(255, 255, 255, 0.08) !important;
      color: #D5DFEC !important;
    }

    body.ag-customizations-page .group.relative.flex.items-center.rounded-lg {
      border-bottom: 1px solid rgba(255, 255, 255, 0.045) !important;
      border-radius: 7px !important;
    }

    body.ag-customizations-page .group.relative.flex.items-center.rounded-lg:hover {
      background: rgba(165, 180, 252, 0.065) !important;
    }

    body.ag-customizations-page .text-sm.font-medium.flex-shrink-0.text-foreground {
      color: #D6E0EE !important;
    }

    body.ag-customizations-page [role="menu"] {
      background: #0D1020 !important;
      border: 1px solid rgba(165, 180, 252, 0.16) !important;
      border-radius: 9px !important;
      box-shadow:
        0 16px 38px rgba(0, 0, 0, 0.50),
        inset 0 1px 0 rgba(255, 255, 255, 0.05) !important;
      padding: 4px !important;
    }

    body.ag-customizations-page [role="menu"] [role="menuitem"] {
      border-radius: 6px !important;
      color: #C5D2E2 !important;
      transition: background-color 120ms ease, color 120ms ease !important;
    }

    body.ag-customizations-page [role="menu"] [role="menuitem"]:hover {
      background: rgba(165, 180, 252, 0.10) !important;
      color: #F1F5F9 !important;
    }

    /* 顶部标题/搜索栏：玻璃化，融入壁纸 */
    body.ag-customizations-page .flex-1.flex.flex-col.min-w-0.min-h-0 > div.shrink-0[style*="min-height: 40px"] {
      background: linear-gradient(180deg, rgba(7, 9, 19, 0) 0%, rgba(7, 9, 19, 0.55) 48%, rgba(7, 9, 19, 0.86) 100%) !important;
    }

    body.ag-customizations-page .sticky.top-0.z-20.bg-background:has(input[placeholder*="Search customizations"], input[placeholder*="搜索"]) {
      background:
        radial-gradient(120% 180% at 16% 0%, rgba(246, 216, 147, 0.05) 0%, transparent 55%),
        linear-gradient(180deg, rgba(7, 9, 19, 0.86) 0%, rgba(7, 9, 19, 0.52) 68%, rgba(7, 9, 19, 0.22) 100%) !important;
      -webkit-backdrop-filter: blur(22px) saturate(1.18) !important;
      backdrop-filter: blur(22px) saturate(1.18) !important;
      border-bottom: 1px solid rgba(255, 255, 255, 0.055) !important;
      box-shadow: 0 18px 40px -34px rgba(0, 0, 0, 0.90) !important;
    }

    body.ag-customizations-page .sticky.top-0.z-20.bg-background:has(input[placeholder*="Search customizations"], input[placeholder*="搜索"]) h1 {
      color: #EEF3FA !important;
      font-weight: 600 !important;
      letter-spacing: 0.01em !important;
    }

    body.ag-customizations-page input[placeholder*="Search customizations"] {
      height: 38px !important;
      border-radius: 10px !important;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.045),
        0 8px 22px rgba(0, 0, 0, 0.18) !important;
    }

    /* Skills & Rules：与设置窗口一致的两列卡片 */
    body.ag-customizations-page section:has([data-testid="skills-rules-filter"]) > div.flex.flex-col.gap-1 > div.flex.flex-col {
      display: grid !important;
      grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
      gap: 10px !important;
      padding-top: 2px !important;
    }

    body.ag-customizations-page section:has([data-testid="skills-rules-filter"]) > div.flex.flex-col.gap-1 > div.flex.flex-col > .group {
      position: relative !important;
      display: block !important;
      min-height: 108px !important;
      border: 1px solid rgba(255, 255, 255, 0.07) !important;
      border-radius: 12px !important;
      background:
        radial-gradient(120% 150% at 10% 0%, rgba(165, 180, 252, 0.055) 0%, transparent 58%),
        rgba(14, 17, 34, 0.58) !important;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.04),
        0 10px 26px rgba(0, 0, 0, 0.16) !important;
      overflow: hidden !important;
      transition: border-color 160ms ease, background-color 160ms ease, transform 160ms ease !important;
    }

    body.ag-customizations-page section:has([data-testid="skills-rules-filter"]) > div.flex.flex-col.gap-1 > div.flex.flex-col > .group:hover {
      border-color: rgba(165, 180, 252, 0.22) !important;
      background:
        radial-gradient(120% 150% at 10% 0%, rgba(165, 180, 252, 0.09) 0%, transparent 60%),
        rgba(18, 21, 40, 0.70) !important;
      transform: translateY(-1px) !important;
    }

    body.ag-customizations-page section:has([data-testid="skills-rules-filter"]) > div.flex.flex-col.gap-1 > div.flex.flex-col > .group > button:first-child {
      display: block !important;
      width: 100% !important;
      height: 100% !important;
      padding: 11px 12px 12px !important;
      border-radius: 12px !important;
      text-align: left !important;
    }

    body.ag-customizations-page section:has([data-testid="skills-rules-filter"]) > div.flex.flex-col.gap-1 > div.flex.flex-col > .group > button:first-child > div {
      display: flex !important;
      flex-wrap: wrap !important;
      align-items: center !important;
      gap: 6px 8px !important;
      min-width: 0 !important;
      padding-right: 26px !important;
    }

    body.ag-customizations-page section:has([data-testid="skills-rules-filter"]) > div.flex.flex-col.gap-1 > div.flex.flex-col > .group > button:first-child > div > span:nth-child(1) {
      order: 1 !important;
      flex: 0 1 auto !important;
      min-width: 0 !important;
      max-width: 100% !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
      color: #E8EEF8 !important;
      font-size: 13px !important;
      font-weight: 600 !important;
      letter-spacing: 0.005em !important;
    }

    body.ag-customizations-page section:has([data-testid="skills-rules-filter"]) > div.flex.flex-col.gap-1 > div.flex.flex-col > .group > button:first-child > div > span:nth-child(2) {
      order: 2 !important;
      flex: 0 0 auto !important;
      align-self: center !important;
    }

    body.ag-customizations-page section:has([data-testid="skills-rules-filter"]) > div.flex.flex-col.gap-1 > div.flex.flex-col > .group > button:first-child > div > span:nth-child(3) {
      order: 3 !important;
      flex: 0 0 100% !important;
      display: -webkit-box !important;
      overflow: hidden !important;
      white-space: normal !important;
      text-overflow: clip !important;
      -webkit-line-clamp: 3 !important;
      -webkit-box-orient: vertical !important;
      margin-top: 1px !important;
      color: #8FA2B8 !important;
      font-size: 12px !important;
      line-height: 1.5 !important;
    }

    body.ag-customizations-page section:has([data-testid="skills-rules-filter"]) > div.flex.flex-col.gap-1 > div.flex.flex-col > .group > .absolute {
      top: 6px !important;
      right: 6px !important;
      bottom: auto !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 26px !important;
      height: 24px !important;
      padding: 0 !important;
      border-radius: 6px !important;
      background: rgba(10, 13, 24, 0.78) !important;
      -webkit-backdrop-filter: blur(8px) !important;
      backdrop-filter: blur(8px) !important;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35) !important;
      opacity: 0 !important;
      pointer-events: none !important;
    }

    body.ag-customizations-page section:has([data-testid="skills-rules-filter"]) > div.flex.flex-col.gap-1 > div.flex.flex-col > .group:hover > .absolute,
    body.ag-customizations-page section:has([data-testid="skills-rules-filter"]) > div.flex.flex-col.gap-1 > div.flex.flex-col > .group:focus-within > .absolute,
    body.ag-customizations-page section:has([data-testid="skills-rules-filter"]) > div.flex.flex-col.gap-1 > div.flex.flex-col > .group:has([data-state="open"]) > .absolute {
      opacity: 1 !important;
      pointer-events: auto !important;
    }

    body.ag-customizations-page section:has([data-testid="skills-rules-filter"]) > div.flex.flex-col.gap-1 > div.flex.justify-start {
      justify-content: center !important;
      padding-top: 8px !important;
    }

    body.ag-customizations-page section:has([data-testid="skills-rules-filter"]) > div.flex.flex-col.gap-1 > div.flex.justify-start > button {
      padding: 6px 14px !important;
      border: 1px solid rgba(255, 255, 255, 0.07) !important;
      border-radius: 999px !important;
      background: rgba(255, 255, 255, 0.03) !important;
      color: #A9B8CC !important;
      transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease !important;
    }

    body.ag-customizations-page section:has([data-testid="skills-rules-filter"]) > div.flex.flex-col.gap-1 > div.flex.justify-start > button:hover {
      border-color: rgba(165, 180, 252, 0.22) !important;
      background: rgba(165, 180, 252, 0.09) !important;
      color: #F1F5F9 !important;
    }

    @media (max-width: 980px) {
      body.ag-customizations-page section:has([data-testid="skills-rules-filter"]) > div.flex.flex-col.gap-1 > div.flex.flex-col {
        grid-template-columns: 1fr !important;
      }
    }

    /* 26. 记忆管理：侧栏入口与全页工作台 */
    .ag-memory-nav {
      display: flex !important;
      align-items: center !important;
      gap: 6px !important;
      width: 100% !important;
      height: 32px !important;
      min-height: 32px !important;
      padding: 4px 8px !important;
      border: 1px solid transparent !important;
      border-radius: 8px !important;
      background: transparent !important;
      color: #C4BBD8 !important;
      font-family: inherit !important;
      font-size: 14px !important;
      font-weight: 400 !important;
      line-height: 1.2 !important;
      text-align: left !important;
      cursor: pointer !important;
      transition: background-color 150ms ease, color 150ms ease, border-color 150ms ease !important;
    }

    .ag-memory-nav:hover {
      background: rgba(255, 255, 255, 0.055) !important;
      color: #F2ECFF !important;
    }

    .ag-memory-nav.is-active {
      border-color: rgba(196, 181, 253, 0.16) !important;
      background:
        linear-gradient(90deg, rgba(165, 180, 252, 0.15) 0%, rgba(246, 216, 147, 0.055) 100%) !important;
      color: #F5EDFF !important;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.045) !important;
    }

    .ag-memory-nav-icon {
      display: inline-flex !important;
      flex: 0 0 16px !important;
      align-items: center !important;
      justify-content: center !important;
      width: 16px !important;
      height: 16px !important;
      color: #AEB6D9 !important;
      transition: color 150ms ease, filter 150ms ease !important;
    }

    .ag-memory-nav.is-active .ag-memory-nav-icon {
      color: #F6D893 !important;
      filter: drop-shadow(0 0 6px rgba(246, 216, 147, 0.55)) !important;
    }

    .ag-memory-nav-icon svg {
      width: 16px !important;
      height: 16px !important;
    }

    .ag-memory-nav-label {
      flex: 1 1 auto !important;
      min-width: 0 !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
    }

    .ag-memory-nav-dot {
      flex: 0 0 5px !important;
      width: 5px !important;
      height: 5px !important;
      border-radius: 999px !important;
      background: #F6D893 !important;
      box-shadow: 0 0 7px rgba(246, 216, 147, 0.75) !important;
      opacity: 0.85 !important;
    }

    #ag-memory-page {
      position: fixed;
      top: 35px;
      left: 360px;
      right: 0;
      bottom: 0;
      z-index: 90;
      display: flex;
      box-sizing: border-box;
      border-left: 1px solid rgba(255, 255, 255, 0.055);
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transform: translate3d(0, 10px, 0);
      background:
        radial-gradient(90% 80% at 88% 0%, rgba(139, 92, 246, 0.14) 0%, transparent 55%),
        radial-gradient(80% 70% at 0% 100%, rgba(246, 216, 147, 0.055) 0%, transparent 55%),
        linear-gradient(165deg, rgba(8, 10, 20, 0.90) 0%, rgba(7, 9, 18, 0.86) 100%);
      -webkit-backdrop-filter: blur(26px) saturate(1.16);
      backdrop-filter: blur(26px) saturate(1.16);
      transition: opacity 200ms ease, transform 240ms cubic-bezier(0.2, 0.8, 0.2, 1), visibility 200ms !important;
      overflow: hidden;
      overscroll-behavior: contain;
    }

    #ag-memory-page.is-open {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      transform: none;
    }

    .ag-memory-shell {
      position: relative;
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      min-height: 0;
      padding: 24px 30px 22px;
      box-sizing: border-box;
    }

    .ag-memory-head {
      display: flex;
      flex: 0 0 auto;
      align-items: flex-start;
      gap: 14px;
      padding-bottom: 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.065);
    }

    .ag-memory-back {
      display: inline-flex !important;
      flex: 0 0 34px !important;
      align-items: center !important;
      justify-content: center !important;
      width: 34px !important;
      height: 34px !important;
      margin-top: 2px !important;
      border: 1px solid rgba(255, 255, 255, 0.08) !important;
      border-radius: 10px !important;
      background: rgba(255, 255, 255, 0.035) !important;
      color: #A9B8CC !important;
      cursor: pointer !important;
      transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease !important;
    }

    .ag-memory-back:hover {
      border-color: rgba(196, 181, 253, 0.25) !important;
      background: rgba(165, 180, 252, 0.10) !important;
      color: #F2F5FB !important;
    }

    .ag-memory-back svg {
      width: 17px !important;
      height: 17px !important;
    }

    .ag-memory-kicker {
      display: flex;
      align-items: center;
      gap: 6px;
      color: #F6D893;
      font-size: 9.5px;
      font-weight: 600;
      letter-spacing: 0.16em;
      line-height: 1;
      opacity: 0.82;
    }

    .ag-memory-kicker::before {
      content: "";
      width: 4px;
      height: 4px;
      border-radius: 999px;
      background: #F6D893;
      box-shadow: 0 0 7px rgba(246, 216, 147, 0.8);
    }

    .ag-memory-title h1 {
      margin: 7px 0 0;
      color: #F2F5FB;
      font-size: 22px;
      font-weight: 600;
      letter-spacing: 0.01em;
      line-height: 1.15;
    }

    .ag-memory-sub {
      margin: 5px 0 0;
      color: #8FA2B8;
      font-size: 11.5px;
      line-height: 1.5;
    }

    .ag-memory-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-left: auto;
      padding-top: 4px;
    }

    .ag-memory-btn {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 6px !important;
      height: 32px !important;
      padding: 0 12px !important;
      border: 1px solid rgba(255, 255, 255, 0.08) !important;
      border-radius: 8px !important;
      background: rgba(255, 255, 255, 0.035) !important;
      color: #B9C7D9 !important;
      font-family: inherit !important;
      font-size: 12px !important;
      font-weight: 500 !important;
      line-height: 1 !important;
      cursor: pointer !important;
      transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, box-shadow 150ms ease !important;
    }

    .ag-memory-btn:hover {
      border-color: rgba(196, 181, 253, 0.24) !important;
      background: rgba(165, 180, 252, 0.10) !important;
      color: #F2F5FB !important;
    }

    .ag-memory-btn.primary {
      border-color: rgba(196, 181, 253, 0.28) !important;
      background:
        linear-gradient(135deg, rgba(165, 180, 252, 0.22) 0%, rgba(246, 216, 147, 0.11) 100%) !important;
      color: #FBF7FF !important;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.09),
        0 8px 20px -16px rgba(165, 180, 252, 0.7) !important;
    }

    .ag-memory-btn.primary:hover {
      border-color: rgba(246, 216, 147, 0.35) !important;
      background:
        linear-gradient(135deg, rgba(165, 180, 252, 0.30) 0%, rgba(246, 216, 147, 0.16) 100%) !important;
    }

    .ag-memory-btn[disabled] {
      opacity: 0.42 !important;
      cursor: default !important;
      pointer-events: none !important;
    }

    .ag-memory-body {
      display: grid;
      flex: 1 1 auto;
      grid-template-columns: 328px minmax(0, 1fr);
      gap: 16px;
      min-height: 0;
      padding-top: 16px;
    }

    .ag-memory-side {
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 0;
      padding-right: 3px;
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      scrollbar-gutter: stable;
    }

    .ag-memory-side::-webkit-scrollbar {
      width: 5px;
    }

    .ag-memory-side::-webkit-scrollbar-thumb {
      border-radius: 999px;
      background: rgba(165, 180, 252, 0.16);
    }

    .ag-memory-card {
      flex: 0 0 auto;
      min-height: 0;
      padding: 12px;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 13px;
      background:
        radial-gradient(120% 150% at 10% 0%, rgba(165, 180, 252, 0.055) 0%, transparent 58%),
        rgba(14, 17, 34, 0.55);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.04),
        0 10px 26px rgba(0, 0, 0, 0.14);
    }

    .ag-memory-card h2 {
      margin: 0 0 9px;
      color: #8DA1B8;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.10em;
      line-height: 1.3;
      text-transform: uppercase;
    }

    .ag-memory-card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
    }

    .ag-memory-card-head h2 {
      margin: 0;
    }

    .ag-memory-count {
      min-width: 18px;
      padding: 1px 7px;
      border: 1px solid rgba(196, 181, 253, 0.14);
      border-radius: 999px;
      background: rgba(165, 180, 252, 0.07);
      color: #B9C6F8;
      font-size: 10px;
      line-height: 16px;
      text-align: center;
    }

    .ag-memory-files {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .ag-memory-file {
      display: flex !important;
      align-items: center !important;
      gap: 9px !important;
      width: 100% !important;
      padding: 6px !important;
      border: 1px solid transparent !important;
      border-radius: 10px !important;
      background: transparent !important;
      color: #C8D4E4 !important;
      font-family: inherit !important;
      text-align: left !important;
      cursor: pointer !important;
      transition: background-color 150ms ease, border-color 150ms ease !important;
    }

    .ag-memory-file:hover {
      background: rgba(255, 255, 255, 0.04) !important;
    }

    .ag-memory-file.is-active {
      border-color: rgba(196, 181, 253, 0.18) !important;
      background:
        linear-gradient(90deg, rgba(165, 180, 252, 0.13) 0%, rgba(246, 216, 147, 0.035) 100%) !important;
    }

    .ag-memory-file-glyph {
      display: inline-flex !important;
      flex: 0 0 24px !important;
      align-items: center !important;
      justify-content: center !important;
      width: 24px !important;
      height: 24px !important;
      border: 1px solid rgba(196, 181, 253, 0.10) !important;
      border-radius: 7px !important;
      background: rgba(165, 180, 252, 0.08) !important;
      color: #AEBDF7 !important;
    }

    .ag-memory-file-glyph svg {
      width: 14px !important;
      height: 14px !important;
    }

    .ag-memory-file-main {
      flex: 1 1 auto !important;
      min-width: 0 !important;
    }

    .ag-memory-file-name {
      display: block !important;
      overflow: hidden !important;
      color: #DCE6F2 !important;
      font-family: ui-monospace, "Cascadia Code", Consolas, monospace !important;
      font-size: 11.5px !important;
      font-weight: 500 !important;
      line-height: 1.4 !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
    }

    .ag-memory-file-meta {
      display: block !important;
      overflow: hidden !important;
      margin-top: 1px !important;
      color: #788AA1 !important;
      font-size: 10px !important;
      line-height: 1.4 !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
    }

    .ag-memory-file-state {
      flex: 0 0 5px !important;
      width: 5px !important;
      height: 5px !important;
      border-radius: 999px !important;
      background: #F6D893 !important;
      box-shadow: 0 0 6px rgba(246, 216, 147, 0.7) !important;
      opacity: 0 !important;
    }

    .ag-memory-file.is-dirty .ag-memory-file-state {
      opacity: 1 !important;
    }

    .ag-memory-vault-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 4px;
      border-radius: 7px;
      cursor: pointer;
      transition: background-color 140ms ease;
    }

    .ag-memory-vault-row:hover {
      background: rgba(255, 255, 255, 0.035);
    }

    .ag-memory-vault-icon {
      display: inline-flex;
      flex: 0 0 14px;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      margin-top: 1px;
      color: #7D90A8;
    }

    .ag-memory-vault-icon svg {
      width: 13px;
      height: 13px;
    }

    .ag-memory-vault-main {
      min-width: 0;
      flex: 1 1 auto;
    }

    .ag-memory-vault-label {
      display: block;
      color: #7F91A8;
      font-size: 9.5px;
      letter-spacing: 0.06em;
      line-height: 1.4;
      text-transform: uppercase;
    }

    .ag-memory-vault-path {
      display: block;
      overflow: hidden;
      margin-top: 1px;
      color: #B6C7DC;
      font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
      font-size: 10.5px;
      line-height: 1.45;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .ag-memory-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-top: 7px;
    }

    .ag-memory-chip {
      padding: 2px 7px;
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.025);
      color: #93A6BC;
      font-size: 9.5px;
      line-height: 15px;
    }

    .ag-memory-chip.ok {
      border-color: rgba(110, 231, 183, 0.16);
      background: rgba(110, 231, 183, 0.07);
      color: #86E0C0;
    }

    .ag-memory-chip.warn {
      border-color: rgba(246, 216, 147, 0.18);
      background: rgba(246, 216, 147, 0.06);
      color: #E8CE96;
    }

    .ag-memory-snapshot {
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid rgba(255, 255, 255, 0.045);
      color: #788AA1;
      font-size: 10px;
      line-height: 1.5;
    }

    .ag-memory-snapshot strong {
      color: #B9C8DA;
      font-family: ui-monospace, Consolas, monospace;
      font-size: 10px;
      font-weight: 400;
    }

    .ag-memory-candidates-card {
      display: flex;
      flex: 0 0 auto;
      flex-direction: column;
      max-height: 190px;
      min-height: 64px;
      overflow: hidden;
    }

    .ag-memory-candidates {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      gap: 6px;
      min-height: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding-right: 2px;
    }

    .ag-memory-candidate {
      padding: 7px 8px;
      border: 1px solid rgba(246, 216, 147, 0.10);
      border-radius: 8px;
      background:
        radial-gradient(120% 160% at 0% 0%, rgba(246, 216, 147, 0.055) 0%, transparent 60%),
        rgba(255, 255, 255, 0.018);
    }

    .ag-memory-candidate-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin-bottom: 3px;
      color: #8FA1B6;
      font-size: 9px;
      line-height: 1.4;
    }

    .ag-memory-candidate-meta span:first-child {
      padding: 1px 6px;
      border-radius: 999px;
      background: rgba(246, 216, 147, 0.08);
      color: #E9CC8E;
    }

    .ag-memory-candidate-text {
      display: -webkit-box;
      overflow: hidden;
      color: #C7D3E1;
      font-size: 10.5px;
      line-height: 1.5;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }

    .ag-memory-candidate-actions {
      display: flex;
      gap: 5px;
      margin-top: 6px;
    }

    .ag-memory-candidate-btn {
      height: 22px;
      padding: 0 8px;
      border: 1px solid rgba(255, 255, 255, 0.075);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.025);
      color: #AEBCCD;
      font-family: inherit;
      font-size: 9.5px;
      line-height: 20px;
      cursor: pointer;
      transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
    }

    .ag-memory-candidate-btn:hover {
      border-color: rgba(165, 180, 252, 0.22);
      background: rgba(165, 180, 252, 0.08);
      color: #E2E8F0;
    }

    .ag-memory-candidate-btn.adopt {
      border-color: rgba(110, 231, 183, 0.20);
      color: #A7F3D0;
    }

    .ag-memory-candidate-btn.adopt:hover {
      background: rgba(16, 185, 129, 0.12);
    }

    .ag-memory-candidate-btn:disabled {
      opacity: 0.45;
      cursor: default;
    }

    .ag-memory-candidates-empty {
      padding: 5px 4px 4px;
      color: #7F91A8;
      font-size: 9.5px;
      line-height: 1.45;
      text-align: center;
    }

    .ag-memory-candidates-empty strong {
      display: block;
      margin-bottom: 1px;
      color: #B9C8DA;
      font-size: 10px;
      font-weight: 500;
    }

    .ag-memory-candidates-empty span {
      display: block;
      color: #6F8198;
    }

    .ag-memory-items-card {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      min-height: 160px;
      overflow: hidden;
    }

    .ag-memory-search {
      width: 100%;
      height: 28px;
      margin-bottom: 8px;
      padding: 0 9px;
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 7px;
      background: rgba(8, 11, 21, 0.45);
      color: #CFDBE9;
      font-family: inherit;
      font-size: 11px;
      outline: none;
      box-sizing: border-box;
    }

    .ag-memory-search:focus {
      border-color: rgba(196, 181, 253, 0.25);
      box-shadow: 0 0 0 2px rgba(165, 180, 252, 0.07);
    }

    .ag-memory-search::placeholder {
      color: #62738A;
    }

    .ag-memory-items {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      gap: 7px;
      min-height: 0;
      overflow-y: auto;
      padding-right: 2px;
      overscroll-behavior: contain;
    }

    .ag-memory-item {
      padding: 8px 9px;
      border: 1px solid rgba(255, 255, 255, 0.055);
      border-radius: 9px;
      background: rgba(255, 255, 255, 0.02);
    }

    .ag-memory-item-top {
      display: flex;
      align-items: center;
      gap: 5px;
      margin-bottom: 4px;
    }

    .ag-memory-item-space {
      padding: 1px 6px;
      border-radius: 999px;
      background: rgba(165, 180, 252, 0.09);
      color: #C4B5FD;
      font-size: 9.5px;
      line-height: 15px;
    }

    .ag-memory-item-pin {
      color: #F6D893;
      font-size: 9.5px;
      line-height: 15px;
    }

    .ag-memory-item-time {
      margin-left: auto;
      color: #6F8198;
      font-size: 9px;
      line-height: 15px;
    }

    .ag-memory-item-text {
      display: -webkit-box;
      overflow: hidden;
      color: #B9C8DA;
      font-size: 11px;
      line-height: 1.55;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
    }

    .ag-memory-item-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 5px;
    }

    .ag-memory-tag {
      color: #7F93AB;
      font-size: 9px;
      line-height: 1.4;
    }

    .ag-memory-empty {
      padding: 16px 8px;
      color: #7F91A8;
      font-size: 11px;
      line-height: 1.6;
      text-align: center;
    }

    .ag-memory-empty-star {
      display: block;
      margin-bottom: 5px;
      color: #F6D893;
      font-size: 17px;
      line-height: 1;
      text-shadow: 0 0 12px rgba(246, 216, 147, 0.45);
    }

    .ag-memory-empty strong {
      display: block;
      margin-bottom: 3px;
      color: #C7D2E2;
      font-size: 11.5px;
      font-weight: 500;
    }

    .ag-memory-editor {
      display: flex;
      flex-direction: column;
      min-height: 0;
      border: 1px solid rgba(255, 255, 255, 0.075);
      border-radius: 14px;
      background:
        radial-gradient(110% 100% at 0% 0%, rgba(165, 180, 252, 0.05) 0%, transparent 55%),
        rgba(10, 13, 24, 0.52);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.04),
        0 16px 40px rgba(0, 0, 0, 0.18);
      overflow: hidden;
    }

    .ag-memory-editor-head {
      display: flex;
      flex: 0 0 auto;
      align-items: center;
      gap: 10px;
      padding: 11px 14px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      background: rgba(255, 255, 255, 0.018);
    }

    .ag-memory-editor-file {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .ag-memory-editor-dot {
      flex: 0 0 7px;
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: #F6D893;
      box-shadow: 0 0 8px rgba(246, 216, 147, 0.5);
    }

    .ag-memory-editor-name {
      color: #E9EFF8;
      font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
      font-size: 11.5px;
      font-weight: 600;
      line-height: 1.4;
    }

    .ag-memory-editor-meta {
      overflow: hidden;
      color: #7C8EA5;
      font-size: 10px;
      line-height: 1.4;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .ag-memory-editor-desc {
      max-width: 45%;
      margin-left: auto;
      overflow: hidden;
      color: #7F93AB;
      font-size: 10px;
      line-height: 1.4;
      text-align: right;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .ag-memory-textarea {
      flex: 1 1 auto;
      width: 100%;
      min-height: 0;
      padding: 14px 16px;
      border: 0;
      background: transparent;
      color: #DCE6F2;
      font-family: ui-monospace, "Cascadia Code", "Fira Code", Consolas, monospace;
      font-size: 12px;
      line-height: 1.68;
      resize: none;
      outline: none;
      box-sizing: border-box;
      tab-size: 2;
      overscroll-behavior: contain;
    }

    .ag-memory-textarea::placeholder {
      color: #5C6E85;
    }

    .ag-memory-textarea[disabled] {
      opacity: 0.55;
    }

    .ag-memory-editor-foot {
      display: flex;
      flex: 0 0 auto;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 9px 14px;
      border-top: 1px solid rgba(255, 255, 255, 0.055);
      color: #778AA1;
      font-size: 10px;
      line-height: 1.5;
    }

    .ag-memory-status {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .ag-memory-status.ok {
      color: #86E0C0;
    }

    .ag-memory-status.error {
      color: #FCA5A5;
    }

    .ag-memory-status.busy {
      color: #E8CE96;
    }

    .ag-memory-tip {
      flex: 0 0 auto;
      color: #687A91;
    }

    html.ag-memory-open #ag-star-cosmos,
    html.ag-memory-open #ag-global-stars {
      opacity: 0.55;
    }

    html.ag-memory-open .bg-sidebar a[href="/customizations"] {
      background: transparent !important;
      color: #C4BBD8 !important;
      box-shadow: none !important;
    }

    .ag-memory-empty .ag-memory-btn {
      margin-top: 9px !important;
    }

    @media (max-width: 1180px) {
      .ag-memory-shell {
        padding: 20px 22px 18px;
      }

      .ag-memory-body {
        grid-template-columns: 240px minmax(0, 1fr);
        gap: 12px;
      }

      .ag-memory-editor-desc {
        display: none;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      #ag-memory-page {
        transition: none !important;
        transform: none !important;
      }
    }

    .ag-plugin-open-location {
      display: flex !important;
      align-items: center !important;
      gap: 8px !important;
      width: 100% !important;
      padding: 7px 9px !important;
      cursor: pointer !important;
      color: #C5D2E2 !important;
      font-size: 12px !important;
    }

    .ag-plugin-open-location:hover {
      background: rgba(165, 180, 252, 0.10) !important;
      color: #F1F5F9 !important;
    }

    .ag-plugin-open-location svg {
      width: 14px !important;
      height: 14px !important;
      flex: 0 0 14px !important;
      color: #8FA3BA !important;
    }

    [role="menu"].surface-glass,
    [role="menu"].agy-overlay {
      background:
        radial-gradient(120% 160% at 12% 0%, rgba(165, 180, 252, 0.08) 0%, transparent 58%),
        linear-gradient(180deg, rgba(18, 21, 40, 0.97) 0%, rgba(10, 13, 26, 0.96) 100%) !important;
      border: 1px solid rgba(246, 216, 147, 0.16) !important;
      border-radius: 12px !important;
      box-shadow:
        0 20px 56px rgba(0, 0, 0, 0.58),
        0 0 30px -18px rgba(246, 216, 147, 0.35),
        inset 0 1px 0 rgba(255, 255, 255, 0.08) !important;
      padding: 5px !important;
    }

    [role="menu"].surface-glass [role="menuitem"],
    [role="menu"].agy-overlay [role="menuitem"] {
      border-radius: 8px !important;
      color: #C5D2E2 !important;
      transition: background-color 120ms ease, color 120ms ease !important;
    }

    [role="menu"].surface-glass [role="menuitem"]:hover,
    [role="menu"].agy-overlay [role="menuitem"]:hover {
      background: rgba(246, 216, 147, 0.10) !important;
      color: #F6E7C1 !important;
    }

    .ag-conversation-download {
      display: flex !important;
      align-items: center !important;
      gap: 8px !important;
      width: 100% !important;
      padding: 7px 9px !important;
      cursor: pointer !important;
      color: #C5D2E2 !important;
      font-size: 12px !important;
    }

    .ag-conversation-download:hover {
      background: rgba(165, 180, 252, 0.10) !important;
      color: #F1F5F9 !important;
    }

    .ag-conversation-download svg {
      width: 14px !important;
      height: 14px !important;
      flex: 0 0 14px !important;
      color: #8FA3BA !important;
    }

    .settings-modal-container [aria-label="Close"]:hover {
      background: rgba(255, 255, 255, 0.07) !important;
      color: #F8FAFC !important;
    }

    /* 16. 侧栏模型额度面板 */
    #ag-usage-panel {
      flex-shrink: 0 !important;
      margin: 10px 8px 0 !important;
      padding: 8px !important;
      border: 1px solid rgba(255, 255, 255, 0.07) !important;
      border-radius: 10px !important;
      background:
        radial-gradient(120% 140% at 10% 0%, rgba(165, 180, 252, 0.075) 0%, transparent 58%),
        rgba(13, 16, 30, 0.72) !important;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.055), 0 8px 22px rgba(0, 0, 0, 0.20) !important;
      backdrop-filter: blur(16px) saturate(150%) !important;
      -webkit-backdrop-filter: blur(16px) saturate(150%) !important;
    }

    .ag-usage-head {
      display: flex !important;
      align-items: center !important;
      gap: 5px !important;
      min-height: 20px !important;
    }

    .ag-usage-title {
      display: flex !important;
      align-items: center !important;
      gap: 6px !important;
      min-width: 0 !important;
      color: #91A2B9 !important;
      font-size: 10.5px !important;
      font-weight: 600 !important;
      letter-spacing: 0.06em !important;
    }

    .ag-usage-live {
      width: 5px !important;
      height: 5px !important;
      border-radius: 999px !important;
      background: #6EE7B7 !important;
      box-shadow: 0 0 7px rgba(110, 231, 183, 0.70) !important;
    }

    .ag-usage-plan {
      margin-left: auto !important;
      padding: 1px 5px !important;
      border: 1px solid rgba(165, 180, 252, 0.12) !important;
      border-radius: 999px !important;
      color: #8091A8 !important;
      font-size: 8.5px !important;
      font-weight: 600 !important;
      letter-spacing: 0.07em !important;
      text-transform: uppercase !important;
    }

    .ag-usage-action {
      width: 20px !important;
      height: 20px !important;
      padding: 0 !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      border: 0 !important;
      border-radius: 5px !important;
      background: transparent !important;
      color: #7F90A6 !important;
      cursor: pointer !important;
    }

    .ag-usage-action:hover {
      background: rgba(255, 255, 255, 0.06) !important;
      color: #E2E8F0 !important;
    }

    .ag-usage-action.is-loading svg {
      animation: ag-ui-spin 900ms linear infinite !important;
    }

    #ag-usage-panel.is-collapsed .ag-usage-body {
      max-height: 0 !important;
      opacity: 0 !important;
      margin-top: 0 !important;
      pointer-events: none !important;
    }

    #ag-usage-panel.is-collapsed .ag-usage-toggle svg {
      transform: rotate(-90deg) !important;
    }

    .ag-usage-toggle svg {
      transition: transform 180ms ease !important;
    }

    .ag-usage-body {
      display: flex !important;
      flex-direction: column !important;
      gap: 2px !important;
      max-height: 230px !important;
      margin-top: 5px !important;
      overflow-y: auto !important;
      overflow-x: hidden !important;
      opacity: 1 !important;
      transition: max-height 200ms ease, opacity 160ms ease, margin-top 200ms ease !important;
    }

    .ag-usage-metrics.is-single {
      grid-template-columns: 1fr !important;
    }

    .ag-usage-reset {
      display: block !important;
      margin-top: 2px !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
      color: #94A6BB !important;
      font-size: 9.5px !important;
      line-height: 1.35 !important;
    }

    .ag-usage-ring-reset {
      width: 100% !important;
      overflow: hidden !important;
      text-align: center !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
      color: #8496AC !important;
      font-size: 9px !important;
    }

    .ag-usage-row {
      padding: 3px 5px 4px !important;
      border-radius: 6px !important;
      transition: background-color 150ms ease !important;
    }

    .ag-usage-row.is-active {
      background: rgba(165, 180, 252, 0.075) !important;
    }

    .ag-usage-label {
      display: flex !important;
      align-items: center !important;
      gap: 6px !important;
      min-width: 0 !important;
    }

    .ag-usage-dot {
      width: 5px !important;
      height: 5px !important;
      flex: none !important;
      border-radius: 999px !important;
      background: var(--ag-model-color) !important;
      box-shadow: 0 0 7px var(--ag-model-color) !important;
    }

    .ag-usage-name {
      min-width: 0 !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
      color: #A7B5C8 !important;
      font-size: 10.5px !important;
    }

    .ag-usage-pct {
      margin-left: auto !important;
      color: #7D8EA5 !important;
      font-size: 9.5px !important;
      font-variant-numeric: tabular-nums !important;
    }

    .ag-usage-track {
      height: 3px !important;
      margin-top: 3px !important;
      border-radius: 999px !important;
      background: rgba(255, 255, 255, 0.06) !important;
      overflow: hidden !important;
    }

    .ag-usage-track i {
      display: block !important;
      height: 100% !important;
      border-radius: inherit !important;
      background: linear-gradient(90deg, var(--ag-model-color), rgba(255, 255, 255, 0.55)) !important;
      box-shadow: 0 0 6px var(--ag-model-color) !important;
      transition: width 280ms ease !important;
    }

    .ag-usage-empty {
      padding: 6px 4px 4px !important;
      color: #7D8EA5 !important;
      font-size: 10.5px !important;
    }

    .ag-usage-empty.is-error {
      color: #FCA5A5 !important;
    }

    /* 17. 输入框插件选择器 */
    .ag-plugin-trigger {
      width: 28px !important;
      height: 28px !important;
      margin-left: 2px !important;
      padding: 6px !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      border: 1px solid rgba(255, 255, 255, 0.06) !important;
      border-radius: 999px !important;
      background: rgba(255, 255, 255, 0.03) !important;
      color: #AAB8CC !important;
      cursor: pointer !important;
      transition: background-color 160ms ease, color 160ms ease, box-shadow 160ms ease !important;
    }

    .ag-plugin-trigger:hover,
    .ag-plugin-trigger.is-active {
      background: rgba(165, 180, 252, 0.14) !important;
      color: #E0E7FF !important;
      box-shadow: 0 0 14px -5px rgba(165, 180, 252, 0.65) !important;
    }

    .ag-plugin-trigger svg {
      width: 16px !important;
      height: 16px !important;
    }

    .ag-plugin-panel {
      position: absolute !important;
      left: 0 !important;
      bottom: calc(100% + 10px) !important;
      z-index: 70 !important;
      width: min(370px, 100%) !important;
      max-height: 390px;
      display: none !important;
      flex-direction: column !important;
      padding: 8px !important;
      border: 1px solid rgba(165, 180, 252, 0.14) !important;
      border-radius: 14px !important;
      background:
        radial-gradient(120% 160% at 10% 0%, rgba(165, 180, 252, 0.09) 0%, transparent 58%),
        linear-gradient(180deg, rgba(18, 21, 40, 0.97) 0%, rgba(9, 12, 25, 0.97) 100%) !important;
      box-shadow:
        0 22px 58px rgba(0, 0, 0, 0.60),
        inset 0 1px 0 rgba(255, 255, 255, 0.08) !important;
      backdrop-filter: blur(28px) saturate(170%) !important;
      -webkit-backdrop-filter: blur(28px) saturate(170%) !important;
    }

    .ag-plugin-panel.is-open {
      display: flex !important;
      animation: ag-plugin-reveal 180ms cubic-bezier(0.2, 0.8, 0.2, 1) !important;
    }

    .ag-plugin-head {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      padding: 1px 2px 6px !important;
    }

    .ag-plugin-title {
      display: flex !important;
      align-items: center !important;
      gap: 6px !important;
      color: #E5ECF6 !important;
      font-size: 12px !important;
      font-weight: 600 !important;
    }

    .ag-plugin-mark {
      display: inline-flex !important;
      color: #A5B4FC !important;
    }

    .ag-plugin-count {
      padding: 1px 5px !important;
      border-radius: 999px !important;
      background: rgba(165, 180, 252, 0.10) !important;
      color: #91A2B9 !important;
      font-size: 9px !important;
      font-weight: 500 !important;
    }

    .ag-plugin-close {
      width: 22px !important;
      height: 22px !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      border: 0 !important;
      border-radius: 6px !important;
      background: transparent !important;
      color: #7F90A6 !important;
      cursor: pointer !important;
    }

    .ag-plugin-close:hover {
      background: rgba(255, 255, 255, 0.06) !important;
      color: #F1F5F9 !important;
    }

    .ag-plugin-search-wrap {
      position: relative !important;
      display: flex !important;
      align-items: center !important;
      margin: 0 1px 6px !important;
      color: #7F90A6 !important;
    }

    .ag-plugin-search-wrap > svg {
      position: absolute !important;
      left: 9px !important;
      pointer-events: none !important;
    }

    .ag-plugin-search {
      width: 100% !important;
      height: 30px !important;
      padding: 0 10px 0 28px !important;
      border: 1px solid rgba(255, 255, 255, 0.08) !important;
      border-radius: 8px !important;
      background: rgba(255, 255, 255, 0.035) !important;
      color: #E2E8F0 !important;
      font-size: 11.5px !important;
      outline: none !important;
    }

    .ag-plugin-search:focus {
      border-color: rgba(165, 180, 252, 0.38) !important;
      box-shadow: 0 0 0 2px rgba(165, 180, 252, 0.08) !important;
    }

    .ag-plugin-search::placeholder {
      color: rgba(148, 163, 184, 0.62) !important;
    }

    .ag-plugin-list {
      display: flex !important;
      flex-direction: column !important;
      gap: 2px !important;
      min-height: 0 !important;
      overflow-y: auto !important;
      padding: 1px !important;
    }

    .ag-plugin-item {
      width: 100% !important;
      min-height: 48px !important;
      display: flex !important;
      align-items: flex-start !important;
      gap: 9px !important;
      padding: 7px 8px !important;
      border: 1px solid transparent !important;
      border-radius: 9px !important;
      background: transparent !important;
      color: inherit !important;
      text-align: left !important;
      cursor: pointer !important;
      transition: background-color 140ms ease, border-color 140ms ease !important;
    }

    .ag-plugin-item:hover,
    .ag-plugin-item:focus-visible {
      background: linear-gradient(90deg, rgba(165, 180, 252, 0.14) 0%, rgba(125, 211, 252, 0.045) 100%) !important;
      border-color: rgba(165, 180, 252, 0.10) !important;
      outline: none !important;
    }

    .ag-plugin-item[hidden] {
      display: none !important;
    }

    .ag-plugin-badge {
      width: 30px !important;
      height: 30px !important;
      flex: none !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      border: 1px solid color-mix(in srgb, var(--ag-plugin-color) 28%, transparent) !important;
      border-radius: 8px !important;
      background: color-mix(in srgb, var(--ag-plugin-color) 12%, transparent) !important;
      color: var(--ag-plugin-color) !important;
      font-size: 13px !important;
      font-weight: 600 !important;
    }

    .ag-plugin-copy {
      display: flex !important;
      flex-direction: column !important;
      gap: 2px !important;
      min-width: 0 !important;
      flex: 1 !important;
    }

    .ag-plugin-name {
      color: #E5ECF6 !important;
      font-size: 11.5px !important;
      font-weight: 500 !important;
      line-height: 1.35 !important;
    }

    .ag-plugin-desc {
      display: -webkit-box !important;
      overflow: hidden !important;
      -webkit-line-clamp: 2 !important;
      -webkit-box-orient: vertical !important;
      color: #8495AB !important;
      font-size: 10px !important;
      line-height: 1.35 !important;
    }

    .ag-plugin-version {
      flex: none !important;
      margin-top: 1px !important;
      color: #66778E !important;
      font-size: 9px !important;
      font-variant-numeric: tabular-nums !important;
    }

    .ag-plugin-create {
      display: flex !important;
      align-items: center !important;
      gap: 6px !important;
      margin-top: 6px !important;
      padding: 7px 9px !important;
      border: 1px dashed rgba(165, 180, 252, 0.18) !important;
      border-radius: 8px !important;
      background: rgba(255, 255, 255, 0.022) !important;
      color: #AAB8CC !important;
      font-size: 10.5px !important;
      cursor: pointer !important;
    }

    .ag-plugin-create:hover {
      background: rgba(165, 180, 252, 0.09) !important;
      color: #E0E7FF !important;
    }

    .ag-plugin-create-plus {
      color: #A5B4FC !important;
      font-size: 14px !important;
      line-height: 1 !important;
    }

    @keyframes ag-plugin-reveal {
      from { opacity: 0; transform: translateY(6px) scale(0.985); filter: blur(3px); }
      to { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
    }

    @keyframes ag-ui-spin {
      to { transform: rotate(360deg); }
    }

    /* 18. 模型选择面板：模型 + 思考强度滑杆 */
    [role="menu"]:has([data-testid="model-selector-panel"]) {
      width: 320px !important;
      min-width: 300px !important;
      max-width: 340px !important;
      padding: 6px !important;
    }

    .ag-model-effort {
      margin: 1px 1px 6px !important;
      padding: 10px 11px 9px !important;
      border: 1px solid rgba(165, 180, 252, 0.10) !important;
      border-radius: 10px !important;
      background:
        radial-gradient(120% 150% at 10% 0%, rgba(165, 180, 252, 0.10) 0%, transparent 58%),
        rgba(255, 255, 255, 0.025) !important;
    }

    .ag-effort-top {
      display: flex !important;
      align-items: center !important;
      gap: 6px !important;
    }

    .ag-effort-icon {
      display: inline-flex !important;
      color: #A5B4FC !important;
      filter: drop-shadow(0 0 5px rgba(165, 180, 252, 0.40)) !important;
    }

    .ag-effort-title {
      color: #91A2B9 !important;
      font-size: 10.5px !important;
      font-weight: 600 !important;
      letter-spacing: 0.04em !important;
    }

    .ag-effort-value {
      margin-left: auto !important;
      color: #C7D2FE !important;
      font-size: 13px !important;
      font-weight: 600 !important;
      text-shadow: 0 0 10px rgba(165, 180, 252, 0.34) !important;
    }

    .ag-effort-model {
      margin-top: 3px !important;
      color: #8495AB !important;
      font-size: 10px !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
    }

    .ag-effort-control {
      position: relative !important;
      height: 24px !important;
      margin-top: 7px !important;
    }

    .ag-effort-control input[type="range"] {
      position: relative !important;
      z-index: 2 !important;
      width: 100% !important;
      height: 24px !important;
      margin: 0 !important;
      padding: 0 !important;
      -webkit-appearance: none !important;
      appearance: none !important;
      background: transparent !important;
      outline: none !important;
      cursor: ew-resize !important;
    }

    .ag-effort-control input[type="range"]::-webkit-slider-runnable-track {
      width: 100% !important;
      height: 6px !important;
      margin-top: 9px !important;
      border-radius: 999px !important;
      background: linear-gradient(
        90deg,
        #A5B4FC 0%,
        #7DD3FC var(--ag-effort-fill),
        rgba(255, 255, 255, 0.10) var(--ag-effort-fill),
        rgba(255, 255, 255, 0.10) 100%
      ) !important;
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.04) !important;
    }

    .ag-effort-control input[type="range"]::-webkit-slider-thumb {
      width: 16px !important;
      height: 16px !important;
      margin-top: -5px !important;
      -webkit-appearance: none !important;
      appearance: none !important;
      border: 1px solid rgba(255, 255, 255, 0.85) !important;
      border-radius: 50% !important;
      background: #F8FAFC !important;
      box-shadow:
        0 2px 8px rgba(0, 0, 0, 0.35),
        0 0 0 3px rgba(165, 180, 252, 0.16) !important;
      cursor: grab !important;
    }

    .ag-effort-ticks {
      position: absolute !important;
      left: 6px !important;
      right: 6px !important;
      top: 11px !important;
      bottom: 11px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      pointer-events: none !important;
    }

    .ag-effort-ticks i {
      width: 4px !important;
      height: 4px !important;
      border-radius: 50% !important;
      background: rgba(255, 255, 255, 0.34) !important;
    }

    .ag-effort-scale {
      display: flex !important;
      justify-content: space-between !important;
      margin-top: 1px !important;
      padding: 0 1px !important;
      color: #6F8096 !important;
      font-size: 9px !important;
    }

    .ag-model-effort.is-applying {
      opacity: 0.78 !important;
    }

    /* 19. 额度面板：分组双指标与环形模式 */
    .ag-usage-groups {
      display: flex !important;
      flex-direction: column !important;
      gap: 4px !important;
    }

    .ag-usage-group {
      padding: 5px 6px 6px !important;
      border: 1px solid rgba(255, 255, 255, 0.035) !important;
      border-radius: 7px !important;
      background: rgba(255, 255, 255, 0.018) !important;
    }

    .ag-usage-group.is-active {
      background: rgba(165, 180, 252, 0.075) !important;
    }

    .ag-usage-group-head {
      display: flex !important;
      align-items: center !important;
      gap: 5px !important;
      min-width: 0 !important;
    }

    .ag-usage-group-name {
      min-width: 0 !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
      color: #C5D2E2 !important;
      font-size: 12px !important;
      font-weight: 500 !important;
    }

    .ag-usage-group-badge {
      margin-left: auto !important;
      color: #8495AB !important;
      font-size: 9px !important;
      white-space: nowrap !important;
    }

    .ag-usage-metrics {
      display: grid !important;
      grid-template-columns: 1fr 1fr !important;
      gap: 7px !important;
      margin-top: 3px !important;
    }

    .ag-usage-metric {
      min-width: 0 !important;
    }

    .ag-usage-metric-head {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      gap: 4px !important;
      color: #95A7BC !important;
      font-size: 10px !important;
      line-height: 1.25 !important;
    }

    .ag-usage-metric-head b {
      color: #C3D0E0 !important;
      font-size: 10.5px !important;
      font-weight: 500 !important;
      font-variant-numeric: tabular-nums !important;
    }

    .ag-usage-metric-track {
      height: 3px !important;
      margin-top: 2px !important;
      border-radius: 999px !important;
      background: rgba(255, 255, 255, 0.055) !important;
      overflow: hidden !important;
    }

    .ag-usage-metric-track i {
      display: block !important;
      height: 100% !important;
      border-radius: inherit !important;
      background: var(--ag-model-color) !important;
      box-shadow: 0 0 6px color-mix(in srgb, var(--ag-model-color) 65%, transparent) !important;
      transition: width 280ms ease !important;
    }

    .ag-usage-rings {
      display: grid !important;
      grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
      gap: 5px !important;
      padding: 5px 1px 1px !important;
    }

    .ag-usage-ring-group {
      display: flex !important;
      flex-direction: column !important;
      align-items: center !important;
      gap: 3px !important;
      min-width: 0 !important;
    }

    .ag-usage-ring {
      --ring-weekly: 0;
      --ring-five: 0;
      --ring-color: #A5B4FC;
      --ring-inner-color: #7DD3FC;
      position: relative !important;
      width: 48px !important;
      height: 48px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      border-radius: 50% !important;
      background: conic-gradient(var(--ring-color) calc(var(--ring-weekly) * 1%), rgba(255, 255, 255, 0.075) 0) !important;
    }

    .ag-usage-ring::before {
      content: "" !important;
      position: absolute !important;
      inset: 3px !important;
      border-radius: 50% !important;
      background: #0B0E1B !important;
    }

    .ag-usage-ring-core {
      position: relative !important;
      z-index: 1 !important;
      width: 34px !important;
      height: 34px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      border-radius: 50% !important;
      background: conic-gradient(var(--ring-inner-color) calc(var(--ring-five) * 1%), rgba(255, 255, 255, 0.06) 0) !important;
    }

    .ag-usage-ring-core::before {
      content: "" !important;
      position: absolute !important;
      inset: 3px !important;
      border-radius: 50% !important;
      background: #0B0E1B !important;
    }

    .ag-usage-ring-value {
      position: relative !important;
      z-index: 2 !important;
      color: #DDE6F2 !important;
      font-size: 9px !important;
      font-weight: 600 !important;
      font-variant-numeric: tabular-nums !important;
    }

    .ag-usage-ring-label {
      width: 100% !important;
      overflow: hidden !important;
      text-align: center !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
      color: #A7B5C8 !important;
      font-size: 9px !important;
    }

    .ag-usage-ring-meta {
      width: 100% !important;
      overflow: hidden !important;
      text-align: center !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
      color: #6D7E94 !important;
      font-size: 8px !important;
    }

    /* 20. 侧栏右侧中部折叠把手 */
    #ag-sidebar-handle {
      position: fixed !important;
      top: 50% !important;
      z-index: 5200 !important;
      width: 17px !important;
      height: 56px !important;
      padding: 0 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      border: 1px solid rgba(165, 180, 252, 0.16) !important;
      border-left: 0 !important;
      border-radius: 0 9px 9px 0 !important;
      background:
        linear-gradient(180deg, rgba(24, 28, 50, 0.90) 0%, rgba(11, 14, 28, 0.92) 100%) !important;
      color: #8EA0B8 !important;
      box-shadow: 5px 0 18px rgba(0, 0, 0, 0.30), inset 0 1px 0 rgba(255, 255, 255, 0.07) !important;
      backdrop-filter: blur(16px) saturate(150%) !important;
      cursor: pointer !important;
      transform: translateY(-50%) !important;
      transition: color 160ms ease, background-color 160ms ease, box-shadow 160ms ease !important;
    }

    #ag-sidebar-handle:hover {
      color: #E0E7FF !important;
      border-color: rgba(165, 180, 252, 0.34) !important;
      box-shadow: 5px 0 22px rgba(0, 0, 0, 0.36), 0 0 16px -6px rgba(165, 180, 252, 0.60) !important;
    }

    #ag-sidebar-handle svg {
      transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1) !important;
    }

    div[style*="width: clamp(256px"][style*="transition: width 500ms"] {
      transition:
        width 460ms cubic-bezier(0.22, 1, 0.36, 1),
        height 460ms cubic-bezier(0.22, 1, 0.36, 1),
        visibility 460ms step-end !important;
    }

    #ag-sidebar-handle.is-collapsed svg {
      transform: rotate(180deg) !important;
    }

    [data-testid="sidebar-toggle"] {
      width: 0 !important;
      min-width: 0 !important;
      height: 0 !important;
      padding: 0 !important;
      margin: 0 !important;
      border: 0 !important;
      opacity: 0 !important;
      overflow: hidden !important;
      pointer-events: none !important;
    }

    /* 21. 提示词预设面板 */
    .ag-prompt-panel .ag-plugin-list {
      max-height: 232px !important;
    }

    .ag-prompt-item {
      align-items: center !important;
    }

    .ag-prompt-item .ag-plugin-copy {
      gap: 3px !important;
    }

    .ag-prompt-preview {
      display: -webkit-box !important;
      overflow: hidden !important;
      -webkit-line-clamp: 1 !important;
      -webkit-box-orient: vertical !important;
      color: #8495AB !important;
      font-size: 10px !important;
    }

    .ag-prompt-actions {
      display: flex !important;
      align-items: center !important;
      gap: 1px !important;
      flex: none !important;
    }

    .ag-prompt-action {
      width: 22px !important;
      height: 22px !important;
      padding: 0 !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      border: 0 !important;
      border-radius: 6px !important;
      background: transparent !important;
      color: #72839A !important;
      cursor: pointer !important;
    }

    .ag-prompt-action:hover {
      background: rgba(255, 255, 255, 0.07) !important;
      color: #F1F5F9 !important;
    }

    .ag-prompt-form {
      display: none !important;
      flex-direction: column !important;
      gap: 7px !important;
      padding: 2px 1px 0 !important;
    }

    .ag-prompt-panel.is-managing .ag-prompt-list,
    .ag-prompt-panel.is-managing .ag-prompt-footer {
      display: none !important;
    }

    .ag-prompt-panel.is-managing .ag-prompt-form {
      display: flex !important;
    }

    .ag-prompt-input,
    .ag-prompt-textarea {
      width: 100% !important;
      border: 1px solid rgba(255, 255, 255, 0.08) !important;
      border-radius: 8px !important;
      background: rgba(255, 255, 255, 0.035) !important;
      color: #E2E8F0 !important;
      font-size: 11.5px !important;
      outline: none !important;
    }

    .ag-prompt-input {
      height: 30px !important;
      padding: 0 9px !important;
    }

    .ag-prompt-textarea {
      min-height: 112px !important;
      padding: 8px 9px !important;
      resize: vertical !important;
      line-height: 1.55 !important;
    }

    .ag-prompt-input:focus,
    .ag-prompt-textarea:focus {
      border-color: rgba(165, 180, 252, 0.38) !important;
      box-shadow: 0 0 0 2px rgba(165, 180, 252, 0.08) !important;
    }

    .ag-prompt-form-actions {
      display: flex !important;
      justify-content: flex-end !important;
      gap: 6px !important;
    }

    .ag-prompt-form-btn {
      height: 28px !important;
      padding: 0 11px !important;
      border: 1px solid rgba(255, 255, 255, 0.08) !important;
      border-radius: 7px !important;
      background: rgba(255, 255, 255, 0.045) !important;
      color: #AAB8CC !important;
      font-size: 10.5px !important;
      cursor: pointer !important;
    }

    .ag-prompt-form-btn.primary {
      border-color: rgba(165, 180, 252, 0.24) !important;
      background: linear-gradient(135deg, rgba(139, 92, 246, 0.28), rgba(56, 189, 248, 0.16)) !important;
      color: #F1F5F9 !important;
    }

    /* 22. 消息操作、Window 菜单与文件右键菜单 */
    .ag-message-action {
      color: #7E8FA7 !important;
    }

    .ag-message-action:hover {
      color: #C7D2FE !important;
      background: rgba(165, 180, 252, 0.08) !important;
    }

    .ag-retry-message {
      color: #F6D893 !important;
    }

    .ag-retry-message:hover {
      color: #FFF1BF !important;
      background: rgba(246, 216, 147, 0.12) !important;
    }

    .ag-window-menu,
    .ag-file-menu {
      position: fixed !important;
      z-index: 9500 !important;
      min-width: 196px !important;
      padding: 5px !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 1px !important;
      border: 1px solid rgba(165, 180, 252, 0.14) !important;
      border-radius: 11px !important;
      background:
        radial-gradient(120% 140% at 10% 0%, rgba(165, 180, 252, 0.09) 0%, transparent 58%),
        linear-gradient(180deg, rgba(18, 21, 40, 0.98) 0%, rgba(9, 12, 25, 0.98) 100%) !important;
      box-shadow: 0 20px 48px rgba(0, 0, 0, 0.58), inset 0 1px 0 rgba(255, 255, 255, 0.08) !important;
      backdrop-filter: blur(24px) saturate(170%) !important;
    }

    .ag-window-menu button,
    .ag-file-menu button {
      width: 100% !important;
      min-height: 28px !important;
      padding: 5px 8px !important;
      display: flex !important;
      align-items: center !important;
      gap: 7px !important;
      border: 1px solid transparent !important;
      border-radius: 7px !important;
      background: transparent !important;
      color: #B6C3D5 !important;
      font-size: 11.5px !important;
      text-align: left !important;
      cursor: pointer !important;
    }

    .ag-window-menu button:hover,
    .ag-file-menu button:hover {
      background: rgba(165, 180, 252, 0.12) !important;
      border-color: rgba(165, 180, 252, 0.08) !important;
      color: #FFFFFF !important;
    }

    .ag-window-menu button .ag-menu-shortcut,
    .ag-file-menu button .ag-menu-shortcut {
      margin-left: auto !important;
      color: #66778E !important;
      font-size: 9px !important;
    }

    .ag-window-menu .ag-menu-sep,
    .ag-file-menu .ag-menu-sep {
      height: 1px !important;
      margin: 4px 5px !important;
      background: rgba(255, 255, 255, 0.07) !important;
    }

    #ag-ui-toast {
      position: fixed !important;
      left: 50% !important;
      bottom: 96px !important;
      z-index: 9800 !important;
      max-width: min(380px, 80vw) !important;
      padding: 8px 14px !important;
      border: 1px solid rgba(165, 180, 252, 0.16) !important;
      border-radius: 9px !important;
      background: rgba(15, 18, 34, 0.94) !important;
      color: #E2E8F0 !important;
      font-size: 11px !important;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.42) !important;
      backdrop-filter: blur(18px) !important;
      opacity: 0 !important;
      pointer-events: none !important;
      transform: translate(-50%, 6px) !important;
      transition: opacity 180ms ease, transform 180ms ease !important;
    }

    #ag-ui-toast.is-visible {
      opacity: 1 !important;
      transform: translate(-50%, 0) !important;
    }

    /* 不能用 visibility:hidden：切换逻辑要读取选项文本，隐藏后 innerText 为空。 */
    .ag-effort-submenu-hidden {
      opacity: 0 !important;
      pointer-events: none !important;
      transform: translate3d(-9999px, 0, 0) !important;
    }

    html.ag-effort-switching [data-testid="model-selector-trigger"] {
      background: transparent !important;
      box-shadow: none !important;
      outline: none !important;
    }

    html.ag-effort-switching [data-testid="model-selector-trigger"] * {
      transition: none !important;
    }

    html.ag-cloak-model-menu [data-radix-popper-content-wrapper],
    html.ag-cloak-model-menu [role="menu"] {
      opacity: 0 !important;
      pointer-events: none !important;
    }

    .scroll-mt-4 > [role="article"][aria-label="Agent response"] {
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.028) !important;
    }

    #antigravity\\.agentSidePanelInputBox,
    .surface-composer {
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.14),
        0 8px 24px rgba(3, 5, 14, 0.28),
        0 0 20px -14px rgba(165, 180, 252, 0.32) !important;
    }

    [data-testid="model-selector-panel"] [role="menuitem"][aria-haspopup="menu"] > span:last-child {
      display: none !important;
    }

    /* 23. 设置页 Skills 卡片布局 */
    .ag-skill-grid {
      display: grid !important;
      grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
      gap: 8px !important;
      border: 0 !important;
      border-radius: 0 !important;
      overflow: visible !important;
    }

    .ag-skill-grid > .group {
      min-width: 0 !important;
      padding: 10px 11px !important;
      border: 1px solid rgba(255, 255, 255, 0.065) !important;
      border-radius: 11px !important;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.032) 0%, rgba(255, 255, 255, 0.014) 100%) !important;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035) !important;
      transition: border-color 160ms ease, background-color 160ms ease, transform 160ms ease !important;
    }

    .ag-skill-grid > .group:hover {
      border-color: rgba(165, 180, 252, 0.17) !important;
      background:
        linear-gradient(180deg, rgba(165, 180, 252, 0.065) 0%, rgba(255, 255, 255, 0.018) 100%) !important;
      transform: translateY(-1px) !important;
    }

    .ag-skill-grid > .group > div:first-child > div:first-child {
      min-width: 0 !important;
    }

    .ag-skill-grid > .group .line-clamp-2 {
      -webkit-line-clamp: 3 !important;
    }

    .ag-skill-grid .ag-skill-folder {
      color: #8C9DB4 !important;
      opacity: 0.42 !important;
    }

    .ag-skill-grid > .group:hover .ag-skill-folder,
    .ag-skill-grid .ag-skill-folder:focus-visible {
      opacity: 1 !important;
      color: #C7D2FE !important;
    }

    .ag-skill-grid .ag-skill-folder:hover {
      background: rgba(165, 180, 252, 0.10) !important;
    }

    @media (max-width: 1100px) {
      .ag-skill-grid {
        grid-template-columns: 1fr !important;
      }
    }

    ::view-transition-group(ag-section-motion) {
      animation-duration: 300ms !important;
      animation-timing-function: cubic-bezier(0.2, 0.8, 0.2, 1) !important;
    }

    ::view-transition-old(ag-section-motion) {
      animation: ag-section-out 220ms cubic-bezier(0.4, 0, 1, 1) both !important;
    }

    ::view-transition-new(ag-section-motion) {
      animation: ag-section-in 300ms cubic-bezier(0.2, 0.8, 0.2, 1) both !important;
    }

    /* 项目展开/收起：用 View Transition 对虚拟列表做快照过渡 */
    ::view-transition-group(ag-project-motion) {
      animation-duration: 300ms !important;
      animation-timing-function: cubic-bezier(0.2, 0.8, 0.2, 1) !important;
    }

    ::view-transition-old(ag-project-motion) {
      animation: ag-project-out 180ms cubic-bezier(0.4, 0, 1, 1) both !important;
    }

    ::view-transition-new(ag-project-motion) {
      animation: ag-project-in 280ms cubic-bezier(0.2, 0.8, 0.2, 1) both !important;
    }

    @keyframes ag-project-out {
      from {
        opacity: 1;
        transform: translateY(0) scaleY(1);
      }
      to {
        opacity: 0;
        transform: translateY(-6px) scaleY(0.985);
      }
    }

    @keyframes ag-project-in {
      from {
        opacity: 0;
        transform: translateY(8px) scaleY(0.985);
      }
      to {
        opacity: 1;
        transform: translateY(0) scaleY(1);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      ::view-transition-group(ag-project-motion),
      ::view-transition-old(ag-project-motion),
      ::view-transition-new(ag-project-motion) {
        animation-duration: 1ms !important;
      }
    }

    @keyframes ag-section-out {
      to {
        opacity: 0;
        transform: translateY(-8px) scale(0.985);
      }
    }

    @keyframes ag-section-in {
      from {
        opacity: 0;
        transform: translateY(10px) scale(0.985);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      #ag-usage-panel,
      .ag-plugin-panel,
      .ag-plugin-panel.is-open,
      .ag-usage-action.is-loading svg {
        animation: none !important;
      }
    }

    /* ==========================================================================
       v3.0 Celestial Astrolabe HUD — 星穹观星台
       香槟流金 + 星穹紫罗兰 + 丝绒星夜玻璃
       ========================================================================== */
    :root {
      --ag-gold-bright: #F6D893;
      --ag-gold-soft: #E5C17B;
      --ag-gold-border: rgba(243, 211, 147, 0.26);
      --ag-violet-bright: #C4B5FD;
      --ag-violet-glow: rgba(167, 139, 250, 0.32);
      --ag-text-primary: #F8F5FF;
      --ag-text-ivory: #EFE4CE;
      --ag-text-secondary: #C4BBD8;
      --ag-text-muted: #8E84A6;
      --ag-sidebar-surface: linear-gradient(180deg, rgba(28, 21, 52, 0.66) 0%, rgba(17, 13, 34, 0.72) 52%, rgba(24, 17, 44, 0.78) 100%);
      --ag-chat-pad: linear-gradient(165deg, rgba(26, 20, 48, 0.64) 0%, rgba(15, 12, 30, 0.52) 100%);
      --ag-card-elevated: linear-gradient(135deg, rgba(38, 28, 68, 0.90) 0%, rgba(22, 18, 44, 0.92) 100%);
    }

    #antigravity-custom-bg-layer {
      opacity: 1 !important;
      background-image:
        linear-gradient(180deg, rgba(10, 7, 22, 0.55) 0%, transparent 14%, transparent 82%, rgba(10, 7, 22, 0.72) 100%),
        linear-gradient(90deg, rgba(14, 10, 28, ${leftMaskAlpha}) 0%, rgba(16, 12, 32, ${midMaskAlpha}) 44%, rgba(14, 10, 28, ${rightMaskAlpha}) 100%),
        radial-gradient(circle at 66% 34%, rgba(246, 216, 147, 0.08) 0%, rgba(167, 139, 250, 0.06) 35%, rgba(11, 8, 24, 0.62) 90%),
        url('${dataUri}') !important;
      background-position: center 26% !important;
      filter: saturate(1.10) contrast(1.03) !important;
    }

    .bg-sidebar {
      position: relative !important;
      background:
        radial-gradient(130% 60% at 15% 0%, rgba(246, 216, 147, 0.10) 0%, transparent 55%),
        radial-gradient(120% 70% at 85% 45%, rgba(167, 139, 250, 0.11) 0%, transparent 60%),
        repeating-linear-gradient(-45deg, rgba(243, 211, 147, 0.012) 0px, rgba(243, 211, 147, 0.012) 1px, transparent 1px, transparent 14px),
        var(--ag-sidebar-surface) !important;
      backdrop-filter: blur(26px) saturate(180%) !important;
      -webkit-backdrop-filter: blur(26px) saturate(180%) !important;
      border-right: 1px solid rgba(243, 211, 147, 0.22) !important;
      box-shadow:
        inset -1px 0 0 rgba(196, 181, 253, 0.12),
        8px 0 32px rgba(6, 4, 16, 0.45) !important;
    }

    .bg-sidebar::after {
      content: "" !important;
      position: absolute !important;
      top: 0 !important;
      right: -1px !important;
      bottom: 0 !important;
      width: 2px !important;
      background: linear-gradient(180deg, transparent 0%, rgba(246, 216, 147, 0.65) 18%, rgba(196, 181, 253, 0.75) 50%, rgba(246, 216, 147, 0.65) 82%, transparent 100%) !important;
      box-shadow: 0 0 12px rgba(246, 216, 147, 0.45) !important;
      pointer-events: none !important;
      z-index: 10 !important;
    }

    .bg-sidebar [data-testid="new-conversation-button"] {
      position: relative !important;
      overflow: hidden !important;
      background: linear-gradient(135deg, rgba(246, 216, 147, 0.22) 0%, rgba(167, 139, 250, 0.28) 55%, rgba(56, 189, 248, 0.14) 100%) !important;
      border: 1px solid rgba(246, 216, 147, 0.42) !important;
      border-radius: 10px !important;
      color: #FFF8EB !important;
      font-weight: 600 !important;
      letter-spacing: 0.02em !important;
      box-shadow:
        inset 0 1px 0 rgba(255, 250, 235, 0.32),
        inset 0 0 16px rgba(246, 216, 147, 0.12),
        0 6px 20px -4px rgba(12, 8, 28, 0.55),
        0 0 18px -6px rgba(246, 216, 147, 0.35) !important;
      transition: all 0.22s cubic-bezier(0.22, 1, 0.36, 1) !important;
    }

    .bg-sidebar [data-testid="new-conversation-button"]:hover {
      background: linear-gradient(135deg, rgba(246, 216, 147, 0.34) 0%, rgba(167, 139, 250, 0.38) 55%, rgba(56, 189, 248, 0.22) 100%) !important;
      border-color: rgba(246, 216, 147, 0.72) !important;
      box-shadow:
        inset 0 1px 0 rgba(255, 250, 235, 0.48),
        inset 0 0 22px rgba(246, 216, 147, 0.22),
        0 8px 24px -4px rgba(12, 8, 28, 0.65),
        0 0 24px -4px rgba(246, 216, 147, 0.55) !important;
      transform: translateY(-1px) scale(1.008) !important;
    }

    .bg-sidebar [data-testid="new-conversation-button"] svg {
      color: var(--ag-gold-bright) !important;
      filter: drop-shadow(0 0 6px rgba(246, 216, 147, 0.65)) !important;
    }

    .bg-sidebar h2 {
      display: flex !important;
      align-items: center !important;
      gap: 6px !important;
      color: var(--ag-text-ivory) !important;
      font-size: 11px !important;
      font-weight: 700 !important;
      letter-spacing: 0.12em !important;
      text-shadow: 0 0 10px rgba(246, 216, 147, 0.25) !important;
    }

    .bg-sidebar h2::after {
      content: "" !important;
      flex: 1 !important;
      height: 1px !important;
      margin-left: 8px !important;
      background: linear-gradient(90deg, rgba(243, 211, 147, 0.35) 0%, rgba(196, 181, 253, 0.15) 60%, transparent 100%) !important;
      pointer-events: none !important;
    }

    .bg-sidebar [data-testid="project-header"] {
      background: transparent !important;
      border: 1px solid transparent !important;
      border-radius: 8px !important;
      box-shadow: none !important;
      color: #DDD4EC !important;
      margin: 2px 6px !important;
      padding: 6px 10px !important;
      transition: all 160ms ease-out !important;
    }

    .bg-sidebar [data-testid="project-header"] span {
      color: #E6DDF5 !important;
      font-size: 12.2px !important;
      font-weight: 600 !important;
      letter-spacing: 0.03em !important;
    }

    .bg-sidebar [data-testid="project-header"] svg {
      color: var(--ag-gold-soft) !important;
      opacity: 0.85 !important;
      filter: drop-shadow(0 0 4px rgba(243, 211, 147, 0.28)) !important;
    }

    .bg-sidebar [data-testid="project-header"]:hover {
      background: linear-gradient(90deg, rgba(243, 211, 147, 0.09) 0%, rgba(167, 139, 250, 0.05) 70%, transparent 100%) !important;
      border-color: rgba(243, 211, 147, 0.14) !important;
    }

    .agy-sidebar-row {
      position: relative !important;
      background: transparent !important;
      border: 1px solid transparent !important;
      border-radius: 8px !important;
      box-shadow: none !important;
      margin: 2px 8px !important;
      padding: 7px 10px 7px 14px !important;
      transition: background 180ms cubic-bezier(0.22, 1, 0.36, 1), border-color 180ms ease-out, transform 180ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 180ms ease-out !important;
    }

    .agy-sidebar-row,
    .agy-sidebar-row span,
    .agy-sidebar-row div {
      color: var(--ag-text-secondary) !important;
    }

    .agy-sidebar-row > div:first-of-type span {
      color: #D5CCE8 !important;
      opacity: 1 !important;
    }

    .agy-sidebar-row .text-xs,
    .agy-sidebar-row [class*="tabular-nums"],
    .agy-sidebar-row [data-screenshot-volatile="true"] {
      color: #9A8FB3 !important;
      font-size: 10.5px !important;
      opacity: 0.68 !important;
    }

    .agy-sidebar-row:hover {
      background: linear-gradient(90deg, rgba(246, 216, 147, 0.11) 0%, rgba(167, 139, 250, 0.08) 55%, transparent 100%) !important;
      border-color: rgba(243, 211, 147, 0.14) !important;
      transform: translateX(4px) !important;
    }

    .agy-sidebar-row:hover,
    .agy-sidebar-row:hover span,
    .agy-sidebar-row:hover div {
      color: var(--ag-text-primary) !important;
    }

    .agy-sidebar-row.bg-sidebar-secondary,
    .agy-sidebar-row[style*="var(--sidebar-secondary)"],
    .agy-sidebar-row[data-selected="true"] {
      position: relative !important;
      background: linear-gradient(90deg, rgba(246, 216, 147, 0.24) 0%, rgba(167, 139, 250, 0.26) 48%, rgba(56, 189, 248, 0.06) 100%) !important;
      border: 1px solid transparent !important;
      border-radius: 9px !important;
      padding-left: 18px !important;
      transform: none !important;
      box-shadow:
        inset 0 1px 0 rgba(255, 248, 231, 0.22),
        inset 0 0 24px rgba(246, 216, 147, 0.12),
        0 6px 20px -10px rgba(246, 216, 147, 0.45) !important;
      animation: ag-v3-selected-aurora 4.2s ease-in-out infinite !important;
    }

    .agy-sidebar-row[data-selected="true"]::before {
      content: "" !important;
      position: absolute !important;
      inset: 0 !important;
      border-radius: 9px !important;
      padding: 1px !important;
      background: linear-gradient(100deg, rgba(246, 216, 147, 0.78) 0%, rgba(196, 181, 253, 0.42) 45%, rgba(246, 216, 147, 0.15) 85%, transparent 100%) 0 0 / 200% 100% !important;
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0) !important;
      -webkit-mask-composite: xor !important;
      mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0) !important;
      mask-composite: exclude !important;
      pointer-events: none !important;
      animation: ag-v3-selected-border-flow 5.5s linear infinite !important;
    }

    .agy-sidebar-row[data-selected="true"]::after {
      content: "" !important;
      position: absolute !important;
      left: 5px !important;
      top: 50% !important;
      width: 9px !important;
      height: 9px !important;
      margin-top: -4.5px !important;
      background: linear-gradient(135deg, #FFFBEB 0%, #F6D893 55%, #C4B5FD 100%) !important;
      clip-path: polygon(50% 0%, 64% 36%, 100% 50%, 64% 64%, 50% 100%, 36% 64%, 0% 50%, 36% 36%) !important;
      filter: drop-shadow(0 0 6px rgba(246, 216, 147, 0.95)) !important;
      pointer-events: none !important;
      animation: ag-v3-star-pulse 2.8s ease-in-out infinite !important;
    }

    @keyframes ag-v3-star-pulse {
      0%, 100% { transform: scale(0.88) rotate(0deg); opacity: 0.85; }
      50% { transform: scale(1.18) rotate(12deg); opacity: 1; }
    }

    @keyframes ag-v3-selected-aurora {
      0%, 100% { box-shadow: inset 0 1px 0 rgba(255, 248, 231, 0.20), inset 0 0 22px rgba(246, 216, 147, 0.10), 0 5px 18px -10px rgba(246, 216, 147, 0.38); }
      50% { box-shadow: inset 0 1px 0 rgba(255, 248, 231, 0.30), inset 0 0 30px rgba(246, 216, 147, 0.18), 0 6px 24px -8px rgba(246, 216, 147, 0.58); }
    }

    @keyframes ag-v3-selected-border-flow {
      to { background-position: 200% 0; }
    }

    .agy-sidebar-row.bg-sidebar-secondary span,
    .agy-sidebar-row.bg-sidebar-secondary div,
    .agy-sidebar-row[style*="var(--sidebar-secondary)"] span,
    .agy-sidebar-row[style*="var(--sidebar-secondary)"] div,
    .agy-sidebar-row[data-selected="true"] span,
    .agy-sidebar-row[data-selected="true"] div {
      color: #FFFDF9 !important;
      font-weight: 600 !important;
      text-shadow: 0 0 12px rgba(246, 216, 147, 0.28) !important;
    }

    .bg-sidebar > .px-2 a:not([data-testid="new-conversation-button"]),
    .bg-sidebar > .px-2 button:not([data-testid="new-conversation-button"]) {
      background: transparent !important;
      border: 1px solid transparent !important;
      border-radius: 8px !important;
      color: #C4BBD8 !important;
      transition: all 160ms ease !important;
    }

    .bg-sidebar > .px-2 a:not([data-testid="new-conversation-button"]):hover,
    .bg-sidebar > .px-2 button:not([data-testid="new-conversation-button"]):hover {
      background: linear-gradient(90deg, rgba(246, 216, 147, 0.10) 0%, rgba(167, 139, 250, 0.06) 100%) !important;
      border-color: rgba(243, 211, 147, 0.15) !important;
      color: #FFF8EB !important;
    }

    .bg-sidebar > .px-2 a.bg-sidebar-secondary,
    .bg-sidebar > .px-2 button.bg-sidebar-secondary,
    .bg-sidebar > .px-2 [aria-current="page"] {
      background: linear-gradient(90deg, rgba(246, 216, 147, 0.22) 0%, rgba(167, 139, 250, 0.20) 100%) !important;
      border-color: rgba(246, 216, 147, 0.32) !important;
      color: #FFF8EB !important;
      box-shadow: inset 2px 0 0 #F6D893, 0 4px 18px -10px rgba(246, 216, 147, 0.50) !important;
    }

    #antigravity-custom-bg-layer + * {
      position: relative;
      z-index: 1;
    }

    .scroll-mt-4 > [role="article"][aria-label="Agent response"] {
      background:
        radial-gradient(90% 50% at 10% 0%, rgba(246, 216, 147, 0.07) 0%, transparent 60%),
        var(--ag-chat-pad) !important;
      backdrop-filter: blur(16px) saturate(160%) !important;
      -webkit-backdrop-filter: blur(16px) saturate(160%) !important;
      border: 1px solid rgba(243, 211, 147, 0.14) !important;
      border-top: 1px solid rgba(246, 216, 147, 0.34) !important;
      border-radius: 14px !important;
      box-shadow:
        inset 0 1px 0 rgba(255, 248, 231, 0.14),
        0 14px 36px -6px rgba(6, 4, 16, 0.52),
        0 0 24px -12px rgba(167, 139, 250, 0.20) !important;
      color: var(--ag-text-primary) !important;
    }

    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] h1,
    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] h2,
    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] h3 {
      color: #FFF8EB !important;
      font-weight: 600 !important;
      text-shadow: 0 0 14px rgba(246, 216, 147, 0.18) !important;
    }

    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] strong,
    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] b {
      color: #FDE68A !important;
      font-weight: 600 !important;
    }

    .scroll-mt-4 > [role="article"][aria-label="Agent response"] [data-markdown-root] blockquote {
      background: linear-gradient(90deg, rgba(246, 216, 147, 0.09) 0%, rgba(167, 139, 250, 0.04) 100%) !important;
      border-left: 2px solid var(--ag-gold-bright) !important;
      border-radius: 0 8px 8px 0 !important;
      padding: 10px 14px !important;
      color: #EFE4CE !important;
    }

    .group\\/user-input-step {
      width: fit-content !important;
      max-width: min(88%, 720px) !important;
      align-self: flex-end !important;
      margin-left: auto !important;
      background: var(--ag-card-elevated) !important;
      backdrop-filter: blur(28px) saturate(180%) !important;
      -webkit-backdrop-filter: blur(28px) saturate(180%) !important;
      border: 1px solid rgba(246, 216, 147, 0.28) !important;
      border-right: 3px solid var(--ag-gold-bright) !important;
      border-radius: 14px 4px 14px 14px !important;
      padding: 11px 18px !important;
      box-shadow:
        inset 0 1px 0 rgba(255, 248, 231, 0.18),
        0 12px 32px -6px rgba(5, 4, 15, 0.68),
        0 0 20px -8px rgba(246, 216, 147, 0.25) !important;
      color: var(--ag-text-primary) !important;
    }

    :not(pre) > code {
      background: rgba(246, 216, 147, 0.10) !important;
      border: 1px solid rgba(246, 216, 147, 0.22) !important;
      color: #F6D893 !important;
      border-radius: 5px !important;
      padding: 2px 6px !important;
      font-size: 0.88em !important;
    }

    #antigravity\\.agentSidePanelInputBox,
    .surface-composer {
      background:
        radial-gradient(120% 160% at 15% 0%, rgba(246, 216, 147, 0.10) 0%, transparent 55%),
        radial-gradient(100% 140% at 88% 100%, rgba(167, 139, 250, 0.12) 0%, transparent 60%),
        rgba(18, 14, 36, 0.90) !important;
      backdrop-filter: blur(26px) saturate(185%) !important;
      -webkit-backdrop-filter: blur(26px) saturate(185%) !important;
      border: 1px solid rgba(243, 211, 147, 0.22) !important;
      border-radius: 16px !important;
      box-shadow:
        inset 0 1px 0 rgba(255, 248, 231, 0.18),
        0 14px 36px rgba(4, 3, 12, 0.55),
        0 0 24px -10px rgba(246, 216, 147, 0.25) !important;
    }

    #antigravity\\.agentSidePanelInputBox::before,
    .surface-composer::before {
      background: conic-gradient(from var(--ag-composer-angle), rgba(255, 255, 255, 0.04) 0deg, rgba(246, 216, 147, 0.98) 40deg, rgba(196, 181, 253, 0.92) 72deg, rgba(125, 211, 252, 0.78) 98deg, rgba(246, 216, 147, 0.45) 124deg, rgba(255, 255, 255, 0.04) 150deg, rgba(255, 255, 255, 0.04) 360deg) !important;
    }

    #antigravity\\.agentSidePanelInputBox:focus-within,
    .surface-composer:focus-within {
      background:
        radial-gradient(120% 160% at 15% 0%, rgba(246, 216, 147, 0.14) 0%, transparent 55%),
        radial-gradient(100% 140% at 88% 100%, rgba(167, 139, 250, 0.14) 0%, transparent 60%),
        rgba(18, 14, 36, 0.92) !important;
      border-color: rgba(246, 216, 147, 0.42) !important;
      box-shadow:
        inset 0 1px 0 rgba(255, 248, 231, 0.22),
        0 14px 36px rgba(4, 3, 12, 0.58),
        0 0 28px -8px rgba(246, 216, 147, 0.32) !important;
    }

    #ag-usage-panel {
      position: relative !important;
      flex-shrink: 0 !important;
      margin: 6px 10px 10px !important;
      padding: 9px 10px !important;
      border: 1px solid rgba(243, 211, 147, 0.20) !important;
      border-radius: 10px !important;
      background:
        linear-gradient(to right, #F6D893 2px, transparent 2px) 0 0 / 8px 8px no-repeat,
        linear-gradient(to bottom, #F6D893 2px, transparent 2px) 0 0 / 8px 8px no-repeat,
        linear-gradient(to left, #F6D893 2px, transparent 2px) 100% 0 / 8px 8px no-repeat,
        linear-gradient(to bottom, #F6D893 2px, transparent 2px) 100% 0 / 8px 8px no-repeat,
        linear-gradient(to right, #F6D893 2px, transparent 2px) 0 100% / 8px 8px no-repeat,
        linear-gradient(to top, #F6D893 2px, transparent 2px) 0 100% / 8px 8px no-repeat,
        linear-gradient(to left, #F6D893 2px, transparent 2px) 100% 100% / 8px 8px no-repeat,
        linear-gradient(to top, #F6D893 2px, transparent 2px) 100% 100% / 8px 8px no-repeat,
        radial-gradient(120% 140% at 10% 0%, rgba(246, 216, 147, 0.12) 0%, transparent 60%),
        rgba(16, 12, 32, 0.78) !important;
      box-shadow:
        inset 0 0 18px rgba(246, 216, 147, 0.06),
        0 8px 22px rgba(4, 3, 12, 0.35) !important;
    }

    .ag-usage-title {
      color: var(--ag-text-ivory) !important;
      font-size: 11px !important;
      font-weight: 700 !important;
      letter-spacing: 0.08em !important;
    }

    .ag-usage-live {
      width: 7px !important;
      height: 7px !important;
      background: var(--ag-gold-bright) !important;
      clip-path: polygon(50% 0%, 65% 35%, 100% 50%, 65% 65%, 50% 100%, 35% 65%, 0% 50%, 35% 35%) !important;
      box-shadow: 0 0 8px rgba(246, 216, 147, 0.90) !important;
    }

    .ag-usage-plan {
      border: 1px solid rgba(246, 216, 147, 0.35) !important;
      background: rgba(246, 216, 147, 0.10) !important;
      color: var(--ag-gold-bright) !important;
    }

    #ag-usage-panel .ag-usage-group {
      border-color: rgba(246, 216, 147, 0.07) !important;
      background: rgba(255, 255, 255, 0.018) !important;
    }

    #ag-usage-panel .ag-usage-metric-track i {
      background: linear-gradient(90deg, var(--ag-model-color, #C4B5FD), #F6D893) !important;
    }

    #ag-sidebar-handle {
      border: 1px solid rgba(246, 216, 147, 0.32) !important;
      border-left: 0 !important;
      background: linear-gradient(180deg, rgba(36, 26, 66, 0.92) 0%, rgba(18, 14, 36, 0.94) 100%) !important;
      color: var(--ag-gold-soft) !important;
      box-shadow: 5px 0 18px rgba(0, 0, 0, 0.42), 0 0 12px rgba(246, 216, 147, 0.18) !important;
    }

    @media (prefers-reduced-motion: reduce) {
      .agy-sidebar-row[data-selected="true"],
      .agy-sidebar-row[data-selected="true"]::before,
      .agy-sidebar-row[data-selected="true"]::after {
        animation: none !important;
      }
    }

    /* ==========================================================================
       v4.0 — 布局秩序 / 可调壁纸 / 生产力组件
       ========================================================================== */
    @property --pos {
      syntax: '<number>';
      inherits: true;
      initial-value: 1;
    }

    :root {
      --ag-accent: ${brandAccent};
      --ag-accent-alt: ${accentAlt};
      --ag-accent-cool: ${accentCool};
      --ag-wp-opacity: ${wallOpacity};
      --ag-wp-tint: ${wallTint};
      --ag-glass-blur: ${glassBlur}px;
      --ag-focus-x: ${focusX}%;
      --ag-focus-y: ${focusY}%;
      --ag-row-gutter: 8px;
      --ag-font-scale: 1;
      --ag-font-display: "Cormorant Garamond", "Palatino Linotype", "华文中宋", "Source Han Serif SC", serif;
      --ag-font-sans: "Plus Jakarta Sans", "Segoe UI Variable Text", "思源黑体 CN", "Noto Sans SC", sans-serif;
      --ag-font-mono: "JetBrains Mono", "Cascadia Code", "等距更紗黑體 TC", monospace;
    }

    html[data-ag-font="editorial-luxe"] {
      --ag-font-display: "Cormorant Garamond", "Palatino Linotype", "华文中宋", "Source Han Serif SC", serif;
      --ag-font-sans: "Plus Jakarta Sans", "Segoe UI Variable Text", "思源黑体 CN", "Noto Sans SC", sans-serif;
      --ag-font-mono: "JetBrains Mono", "Cascadia Code", "等距更紗黑體 TC", monospace;
    }

    html[data-ag-font="modern-silk"] {
      --ag-font-display: "Plus Jakarta Sans", "Segoe UI Variable Display", "思源黑体 CN Medium", sans-serif;
      --ag-font-sans: "Plus Jakarta Sans", "Segoe UI Variable Text", "思源黑体 CN", "Noto Sans SC", sans-serif;
      --ag-font-mono: "Cascadia Code", "等距更紗黑體 TC", monospace;
    }

    html[data-ag-font="literary-serif"] {
      --ag-font-display: "Palatino Linotype", "Georgia", "华文中宋", serif;
      --ag-font-sans: "Segoe UI Variable Text", "思源黑体 CN", sans-serif;
      --ag-font-mono: "Cascadia Code", "等距更紗黑體 TC", monospace;
    }

    html[data-ag-font="starry-game"] {
      --ag-font-display: "Plus Jakarta Sans", "jf open 粉圓 1.0", "思源黑体 CN", sans-serif;
      --ag-font-sans: "Segoe UI Variable Text", "jf open 粉圓 1.0", "思源黑体 CN", sans-serif;
      --ag-font-mono: "Cascadia Code", "等距更紗黑體 TC", monospace;
    }

    body,
    button,
    input,
    textarea,
    select,
    [contenteditable="true"],
    [data-markdown-root] {
      font-family: var(--ag-font-sans) !important;
    }

    [data-markdown-root] {
      line-height: 1.68 !important;
      font-optical-sizing: auto;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }

    [data-markdown-root],
    [contenteditable="true"] {
      font-size: calc(1em * var(--ag-font-scale, 1)) !important;
    }

    h1, h2, h3, h4, h5, h6,
    [data-testid="conversation-title"],
    .conversation-title,
    [data-markdown-root] h1,
    [data-markdown-root] h2,
    [data-markdown-root] h3 {
      font-family: var(--ag-font-display) !important;
    }

    code, pre, kbd, samp, .font-mono, [class*="font-mono"] {
      font-family: var(--ag-font-mono) !important;
    }

    html[data-ag-font="literary-serif"] [data-markdown-root],
    html[data-ag-font="literary-serif"] [data-markdown-root] p,
    html[data-ag-font="literary-serif"] [data-markdown-root] li,
    html[data-ag-font="literary-serif"] [data-markdown-root] blockquote {
      font-family: "Georgia", "华文宋体", "思源黑体 CN", serif !important;
    }

    /* 壁纸拆成独立图层：显隐度与焦点不再和遮罩互相绑架 */
    #antigravity-custom-bg-layer {
      background-image: none !important;
      background-color: transparent !important;
      opacity: 1 !important;
      filter: none !important;
      overflow: hidden !important;
      contain: paint !important;
    }

    #antigravity-custom-bg-layer::before {
      content: "" !important;
      position: absolute !important;
      inset: 0 !important;
      background-image: url('${dataUri}') !important;
      background-size: cover !important;
      background-position: var(--ag-focus-x) var(--ag-focus-y) !important;
      background-repeat: no-repeat !important;
      opacity: var(--ag-wp-opacity) !important;
      transition: opacity 220ms ease-out, background-position 120ms ease-out !important;
      pointer-events: none !important;
    }

    #antigravity-custom-bg-layer::after {
      content: "" !important;
      position: absolute !important;
      inset: 0 !important;
      pointer-events: none !important;
      background-image:
        linear-gradient(rgba(9, 7, 20, var(--ag-wp-tint)) 0%, rgba(9, 7, 20, var(--ag-wp-tint)) 100%),
        linear-gradient(90deg, rgba(13, 10, 26, 0.72) 0%, rgba(13, 10, 26, 0.44) 46%, rgba(13, 10, 26, 0.18) 100%),
        radial-gradient(circle at 66% 34%, rgba(246, 216, 147, 0.05) 0%, rgba(12, 9, 24, 0.34) 88%),
        linear-gradient(180deg, rgba(9, 7, 20, 0.42) 0%, transparent 12%, transparent 86%, rgba(9, 7, 20, 0.55) 100%) !important;
    }

    /* Antigravity 新版首页/对话页的 .agy-sheet 与背景渐变默认不透明，会盖住壁纸 */
    .agy-sheet {
      background: transparent !important;
      background-image: none !important;
    }

    .agy-sheet .bg-background {
      background-color: transparent !important;
      background-image: none !important;
    }

    .agy-sheet [class*="-z-10"] {
      background: transparent !important;
      background-image: none !important;
    }

    /* 性能：长对话内容不做实时 backdrop 模糊，避免滚动/动画掉帧 */
    .agy-sheet [role="article"],
    .agy-sheet [data-testid="user-input-step"],
    .agy-sheet pre,
    .agy-sheet code-block,
    .agy-sheet .code-block,
    .agy-sheet [class*="group/header"],
    .agy-sheet svg,
    .agy-shell [class*="group/header"],
    .agy-shell [class*="group-hover/head"],
    .agy-shell svg {
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }

    /* 用户气泡：原生内层黑底交给主题外层气泡绘制 */
    [data-testid="user-input-step"] [data-testid="user-message-bubble"] {
      background: transparent !important;
      background-image: none !important;
      border: 0 !important;
      border-radius: 0 !important;
      padding: 0 !important;
      box-shadow: none !important;
    }

    /* 空的 Agent 回复占位不画卡片，避免出现一条空黑条 */
    .scroll-mt-4 > [role="article"][aria-label="Agent response"]:empty {
      background: transparent !important;
      background-image: none !important;
      border: 0 !important;
      border-radius: 0 !important;
      padding: 0 !important;
      margin: 0 !important;
      min-height: 0 !important;
      box-shadow: none !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }

    /* 性能优先：主界面不再做实时 backdrop 模糊，改用静态渐变/半透明底 */
    html body #root .agy-shell,
    html body #root .agy-shell * {
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }

    /* 用户气泡：外层 user-input-step 只负责布局，真正的气泡画在内层 frame 上 */
    [data-testid="user-input-step"] {
      background: transparent !important;
      background-image: none !important;
      border: 0 !important;
      border-radius: 0 !important;
      padding: 0 !important;
      box-shadow: none !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }

    [data-testid="user-input-step"] .agy-user-bubble-frame {
      background: var(--ag-card-elevated) !important;
      border: 1px solid rgba(246, 216, 147, 0.28) !important;
      border-right: 3px solid var(--ag-gold-bright) !important;
      border-radius: 14px 4px 14px 14px !important;
      padding: 1px !important;
      overflow: hidden !important;
      box-shadow:
        inset 0 1px 0 rgba(255, 248, 231, 0.18),
        0 12px 32px -6px rgba(5, 4, 15, 0.68),
        0 0 20px -8px rgba(246, 216, 147, 0.25) !important;
    }

    [data-testid="user-input-step"] [data-testid="user-message-bubble"] {
      padding: 10px 16px !important;
      background: transparent !important;
      background-image: none !important;
      border: 0 !important;
      border-radius: 0 !important;
      box-shadow: none !important;
    }

    /* 全屏星场：金色星尘铺满界面，底部输入区渐隐 */
    #ag-global-stars {
      position: fixed !important;
      inset: 0 !important;
      z-index: 15 !important;
      overflow: hidden !important;
      pointer-events: none !important;
      -webkit-mask-image: linear-gradient(180deg, #000 0%, #000 84%, transparent 96%) !important;
      mask-image: linear-gradient(180deg, #000 0%, #000 84%, transparent 96%) !important;
    }

    #ag-global-stars i {
      position: absolute !important;
      display: block !important;
      background: var(--ag-accent) !important;
      clip-path: polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%) !important;
      opacity: 0.08;
      filter: drop-shadow(0 0 4px rgba(246, 216, 147, 0.55));
      animation: ag-global-twinkle var(--dur, 9s) ease-in-out infinite !important;
      animation-delay: var(--delay, 0s) !important;
      /* opacity only: scaling a drop-shadow-filtered layer re-rasterizes the filter every frame */
      will-change: opacity;
    }

    #ag-global-stars i.is-sparkle {
      clip-path: polygon(50% 0%, 58% 42%, 100% 50%, 58% 58%, 50% 100%, 42% 58%, 0% 50%, 42% 42%) !important;
      opacity: 0.12;
      filter: drop-shadow(0 0 5px rgba(246, 216, 147, 0.7));
    }

    #ag-global-stars i.is-bright {
      filter: drop-shadow(0 0 7px rgba(246, 216, 147, 0.85));
    }

    @keyframes ag-global-twinkle {
      0%, 100% { opacity: 0.04; }
      45%, 55% { opacity: var(--peak, 0.42); }
    }

    @media (prefers-reduced-motion: reduce) {
      #ag-global-stars i {
        animation: none !important;
        opacity: 0.2 !important;
      }
    }

    #ag-star-cosmos {
      position: fixed !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      z-index: 16 !important;
      pointer-events: none !important;
    }

    html.ag-stars-off #ag-global-stars,
    html.ag-stars-off #ag-star-cosmos {
      display: none !important;
    }

    /* 侧栏底衬只作用于真正的侧栏根节点，避免每一层 bg-sidebar 各自成块 */
    .bg-sidebar::after {
      display: none !important;
    }

    .bg-sidebar:has([data-testid="settings-button"]) {
      overflow-x: clip !important;
      background:
        radial-gradient(120% 55% at 12% 0%, rgba(246, 216, 147, 0.06) 0%, transparent 58%),
        linear-gradient(180deg, rgba(24, 19, 45, 0.84) 0%, rgba(14, 11, 30, 0.86) 55%, rgba(18, 14, 36, 0.88) 100%) !important;
      backdrop-filter: blur(var(--ag-glass-blur)) saturate(165%) !important;
      -webkit-backdrop-filter: blur(var(--ag-glass-blur)) saturate(165%) !important;
      border-right: 1px solid rgba(246, 216, 147, 0.16) !important;
      box-shadow: inset -1px 0 0 rgba(196, 181, 253, 0.06), 6px 0 26px rgba(5, 4, 14, 0.32) !important;
    }

    .bg-sidebar:has([data-testid="settings-button"])::after {
      display: block !important;
      content: "" !important;
      position: absolute !important;
      top: 0 !important;
      right: -1px !important;
      bottom: 0 !important;
      width: 1px !important;
      background: linear-gradient(180deg, transparent 0%, rgba(246, 216, 147, 0.38) 22%, rgba(196, 181, 253, 0.34) 58%, transparent 100%) !important;
      box-shadow: none !important;
      pointer-events: none !important;
      z-index: 10 !important;
    }

    .bg-sidebar .bg-sidebar {
      background: transparent !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
      box-shadow: none !important;
      border-right: 0 !important;
    }

    /* Antigravity 侧栏是虚拟列表：分组容器用内联 absolute + translateY 定位。
       主题的 .bg-sidebar{position:relative} 会把它们打回文档流，必须按内联值恢复。 */
    .bg-sidebar .bg-sidebar[style*="position: absolute"] {
      position: absolute !important;
    }

    .bg-sidebar .bg-sidebar[style*="position: sticky"] {
      position: sticky !important;
      background: rgba(14, 11, 28, 0.94) !important;
      backdrop-filter: blur(var(--ag-glass-blur)) saturate(150%) !important;
      -webkit-backdrop-filter: blur(var(--ag-glass-blur)) saturate(150%) !important;
    }

    .bg-sidebar .bg-sidebar:not([style*="position:"]) {
      position: static !important;
    }

    .bg-sidebar [data-testid="section-header"] h2 {
      opacity: 1 !important;
    }

    [data-testid="title-menu-bar"] {
      background: rgba(10, 8, 22, 0.78) !important;
      backdrop-filter: blur(var(--ag-glass-blur)) saturate(150%) !important;
      -webkit-backdrop-filter: blur(var(--ag-glass-blur)) saturate(150%) !important;
      border-bottom: 1px solid rgba(255, 255, 255, 0.035) !important;
    }

    /* 列表回到 8px 统一边距：所有行右边缘对齐 351px */
    .bg-sidebar .agy-sidebar-row,
    .bg-sidebar [data-testid="conversation-row-sidebar"],
    .bg-sidebar [data-testid="project-header"] {
      box-sizing: border-box !important;
      width: 100% !important;
      margin: 1px 0 !important;
      border: 0 !important;
      border-radius: 8px !important;
      background: transparent !important;
      box-shadow: inset 1px 0 0 rgba(255, 255, 255, 0.045) !important;
      transform: none !important;
      animation: none !important;
    }

    .bg-sidebar [data-testid="conversation-row-sidebar"],
    .bg-sidebar .agy-sidebar-row {
      padding: 7px 10px 7px 30px !important;
      min-height: 32px !important;
    }

    .bg-sidebar [data-testid="project-header"] {
      padding: 6px 10px 6px 8px !important;
      box-shadow: none !important;
    }

    .bg-sidebar [data-testid="project-header"] span {
      color: #CFC6E2 !important;
      font-size: 12px !important;
      font-weight: 600 !important;
    }

    .bg-sidebar [data-testid="project-header"] svg {
      filter: none !important;
      opacity: 0.72 !important;
      color: #B9A9DA !important;
    }

    .bg-sidebar .agy-sidebar-row:hover,
    .bg-sidebar [data-testid="conversation-row-sidebar"]:hover,
    .bg-sidebar [data-testid="project-header"]:hover {
      background: rgba(255, 255, 255, 0.038) !important;
      border-color: transparent !important;
      box-shadow: inset 1px 0 0 rgba(255, 255, 255, 0.08) !important;
      transform: none !important;
    }

    .bg-sidebar .agy-sidebar-row.bg-sidebar-secondary,
    .bg-sidebar .agy-sidebar-row[style*="var(--sidebar-secondary)"],
    .bg-sidebar .agy-sidebar-row[data-selected="true"],
    .bg-sidebar [data-testid="conversation-row-sidebar"][data-selected="true"],
    .bg-sidebar [data-testid="conversation-row-sidebar"].bg-sidebar-secondary {
      background: rgba(255, 255, 255, 0.048) !important;
      border: 0 !important;
      padding-left: 30px !important;
      box-shadow: inset 2px 0 0 var(--ag-accent) !important;
      animation: none !important;
    }

    .bg-sidebar .agy-sidebar-row[data-selected="true"]::before,
    .bg-sidebar .agy-sidebar-row[data-selected="true"]::after,
    .bg-sidebar .agy-sidebar-row.bg-sidebar-secondary::before,
    .bg-sidebar .agy-sidebar-row.bg-sidebar-secondary::after {
      display: none !important;
      animation: none !important;
    }

    .bg-sidebar .agy-sidebar-row span {
      color: #BCB3D0 !important;
    }

    .bg-sidebar [data-testid="conversation-row-sidebar"] > div:first-of-type span,
    .bg-sidebar .agy-sidebar-row > div:first-of-type span {
      font-size: 12.8px !important;
      font-weight: 500 !important;
      letter-spacing: 0.005em !important;
    }

    .bg-sidebar [data-testid="conversation-row-sidebar"][data-selected="true"] span,
    .bg-sidebar .agy-sidebar-row[data-selected="true"] > div:first-of-type span {
      color: #F4EFFF !important;
    }

    .bg-sidebar h2 {
      color: #A3B0C4 !important;
      font-size: 10.5px !important;
      font-weight: 600 !important;
      letter-spacing: 0.1em !important;
    }

    .bg-sidebar h2::after {
      background: linear-gradient(90deg, color-mix(in srgb, var(--ag-accent) 26%, transparent) 0%, color-mix(in srgb, var(--ag-accent-alt) 14%, transparent) 55%, transparent 100%) !important;
    }

    .bg-sidebar .overflow-y-auto {
      padding-bottom: 8px !important;
    }

    .bg-sidebar *::-webkit-scrollbar {
      width: 5px !important;
      height: 5px !important;
    }

    .bg-sidebar *::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.10) !important;
      border-radius: 3px !important;
    }

    .bg-sidebar *::-webkit-scrollbar-track {
      background: transparent !important;
    }

    .bg-sidebar [data-testid="new-conversation-button"] {
      background: linear-gradient(135deg, rgba(246, 216, 147, 0.13) 0%, rgba(167, 139, 250, 0.16) 100%) !important;
      border: 1px solid rgba(246, 216, 147, 0.22) !important;
      border-radius: 10px !important;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06) !important;
      color: #F6EBD8 !important;
    }

    .bg-sidebar [data-testid="new-conversation-button"]:hover {
      background: linear-gradient(135deg, rgba(246, 216, 147, 0.2) 0%, rgba(167, 139, 250, 0.2) 100%) !important;
      border-color: rgba(246, 216, 147, 0.34) !important;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1) !important;
      transform: none !important;
    }

    .bg-sidebar > .px-2 a.bg-sidebar-secondary,
    .bg-sidebar > .px-2 button.bg-sidebar-secondary,
    .bg-sidebar > .px-2 [aria-current="page"] {
      background: rgba(255, 255, 255, 0.045) !important;
      border-color: rgba(255, 255, 255, 0.05) !important;
      box-shadow: inset 2px 0 0 var(--ag-accent) !important;
      color: #F4EFFF !important;
    }

    /* 额度面板：紧凑条 + 展开详情，去掉金色转角与多层描边 */
    #ag-usage-panel {
      margin: 2px var(--ag-row-gutter) 8px !important;
      padding: 7px 9px !important;
      border: 1px solid rgba(255, 255, 255, 0.055) !important;
      border-radius: 9px !important;
      background: rgba(15, 12, 30, 0.58) !important;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035) !important;
      backdrop-filter: blur(var(--ag-glass-blur)) saturate(150%) !important;
      -webkit-backdrop-filter: blur(var(--ag-glass-blur)) saturate(150%) !important;
    }

    #ag-usage-panel .ag-usage-head {
      min-height: 18px !important;
    }

    #ag-usage-panel .ag-usage-title {
      color: #A3B0C4 !important;
      font-size: 9.5px !important;
      font-weight: 600 !important;
      letter-spacing: 0.1em !important;
    }

    #ag-usage-panel .ag-usage-live {
      width: 5px !important;
      height: 5px !important;
      clip-path: none !important;
      border-radius: 50% !important;
      background: var(--ag-accent-cool) !important;
      box-shadow: 0 0 6px color-mix(in srgb, var(--ag-accent-cool) 55%, transparent) !important;
    }

    #ag-usage-panel .ag-usage-plan {
      padding: 0 5px !important;
      border: 1px solid rgba(255, 255, 255, 0.07) !important;
      background: transparent !important;
      color: #7F8FA6 !important;
      font-size: 8px !important;
    }

    #ag-usage-panel .ag-usage-group {
      border: 0 !important;
      background: transparent !important;
      padding: 4px 2px !important;
    }

    #ag-usage-panel .ag-usage-groups {
      gap: 2px !important;
    }

    #ag-usage-panel .ag-usage-body {
      max-height: 204px !important;
      margin-top: 4px !important;
    }

    #ag-usage-panel.is-collapsed .ag-usage-toggle svg {
      transform: rotate(180deg) !important;
    }

    .ag-usage-strip {
      display: none;
      align-items: center;
      gap: 10px;
      margin-top: 5px;
    }

    #ag-usage-panel.is-collapsed .ag-usage-strip {
      display: flex;
    }

    #ag-usage-panel.is-collapsed .ag-usage-head {
      margin-bottom: 0;
    }

    .ag-usage-strip-item {
      flex: 1 1 0;
      min-width: 0;
    }

    .ag-usage-strip-top {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 4px;
      margin-bottom: 3px;
    }

    .ag-usage-strip-label {
      overflow: hidden;
      color: #8D9BB0;
      font-size: 9px;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .ag-usage-strip-value {
      color: #D9D2E8;
      font-size: 9.5px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }

    .ag-usage-strip-bar {
      height: 2.5px;
      overflow: hidden;
      border-radius: 2px;
      background: rgba(255, 255, 255, 0.065);
    }

    .ag-usage-strip-bar i {
      display: block;
      height: 100%;
      border-radius: 2px;
      background: var(--ag-model-color, var(--ag-accent-alt));
    }

    /* 折叠把手：贴边、低存在感、不再压在内容上 */
    #ag-sidebar-handle {
      z-index: 60 !important;
      width: 12px !important;
      height: 44px !important;
      border: 1px solid rgba(255, 255, 255, 0.07) !important;
      border-left: 0 !important;
      border-radius: 0 8px 8px 0 !important;
      background: rgba(16, 12, 32, 0.72) !important;
      color: #A99BC4 !important;
      box-shadow: 3px 0 12px rgba(0, 0, 0, 0.28) !important;
      opacity: 0.35 !important;
      backdrop-filter: blur(12px) !important;
      transition: opacity 160ms ease, background-color 160ms ease !important;
    }

    #ag-sidebar-handle:hover {
      opacity: 1 !important;
      background: rgba(24, 18, 46, 0.92) !important;
      border-color: rgba(246, 216, 147, 0.28) !important;
      color: var(--ag-accent) !important;
    }

    #ag-sidebar-handle svg {
      width: 11px !important;
      height: 11px !important;
    }

    /* 星轨对话导航 */
    [data-testid="conversation-navigator"] {
      opacity: 0 !important;
      pointer-events: none !important;
    }

    #ag-chat-minimap {
      position: fixed;
      z-index: 58;
      width: 24px;
      padding: 4px 0;
      border: 1px solid rgba(246, 216, 147, 0.12);
      border-radius: 13px;
      background: linear-gradient(180deg, rgba(21, 17, 40, 0.78), rgba(11, 9, 23, 0.62));
      box-shadow: 0 8px 24px rgba(3, 2, 10, 0.35), inset 0 0 0 1px rgba(255, 255, 255, 0.025);
      backdrop-filter: blur(10px);
      opacity: 0;
      pointer-events: none;
      transition: opacity 180ms ease-out, border-color 180ms ease;
    }

    #ag-chat-minimap.is-visible {
      opacity: 1;
      pointer-events: auto;
    }

    #ag-chat-minimap:hover {
      border-color: rgba(246, 216, 147, 0.3);
    }

    /* 设置弹窗 / 记忆页 / 任何模态框打开时，导航竖线不得透出 */
    html:has(.settings-modal-container) #ag-chat-minimap,
    html:has([role="dialog"][aria-modal="true"]) #ag-chat-minimap,
    html.ag-memory-open #ag-chat-minimap,
    html:has(.settings-modal-container) #ag-minimap-list,
    html:has([role="dialog"][aria-modal="true"]) #ag-minimap-list,
    html.ag-memory-open #ag-minimap-list {
      opacity: 0 !important;
      pointer-events: none !important;
    }

    #ag-chat-minimap::before {
      content: "" !important;
      position: absolute !important;
      left: 50% !important;
      top: 30px !important;
      bottom: 10px !important;
      width: 1px !important;
      transform: translateX(-0.5px) !important;
      background: linear-gradient(180deg, transparent 0%, color-mix(in srgb, var(--ag-accent) 22%, transparent) 8%, color-mix(in srgb, var(--ag-accent-alt) 30%, transparent) 50%, color-mix(in srgb, var(--ag-accent) 22%, transparent) 92%, transparent 100%) !important;
      pointer-events: none !important;
    }

    .ag-minimap-head {
      position: absolute;
      top: 4px;
      left: 50%;
      width: 20px;
      height: 20px;
      transform: translateX(-50%);
      display: grid;
      place-items: center;
      border: 1px solid rgba(246, 216, 147, 0.18);
      border-radius: 50%;
      background: rgba(246, 216, 147, 0.08);
      color: rgba(246, 216, 147, 0.82);
      font-size: 10px;
      line-height: 1;
      cursor: pointer;
      transition: color 140ms ease, background 140ms ease, border-color 140ms ease;
    }

    .ag-minimap-head:hover,
    .ag-minimap-head.is-open {
      color: #FFF1BF;
      background: rgba(246, 216, 147, 0.2);
      border-color: rgba(246, 216, 147, 0.42);
    }

    .ag-minimap-thumb {
      position: absolute;
      left: 50%;
      width: 6px;
      height: 18px;
      margin-top: -9px;
      transform: translateX(-50%);
      border-radius: 4px;
      background: linear-gradient(180deg, #FFF1BF, #F6D893 55%, rgba(246, 216, 147, 0.36));
      box-shadow: 0 0 10px rgba(246, 216, 147, 0.55);
      pointer-events: none;
      transition: top 220ms cubic-bezier(0.22, 0.8, 0.28, 1);
    }

    .ag-minimap-dot {
      position: absolute;
      left: 50%;
      width: 24px;
      height: 14px;
      margin-top: -7px;
      transform: translateX(-50%);
      display: grid;
      place-items: center;
      border: 0;
      padding: 0;
      background: transparent;
      color: rgba(255, 255, 255, 0.42);
      font-size: 8px;
      line-height: 1;
      cursor: pointer;
      transition: color 140ms ease, text-shadow 140ms ease, transform 140ms ease;
    }

    .ag-minimap-dot:hover,
    .ag-minimap-dot.is-current {
      color: var(--ag-accent);
      text-shadow: 0 0 8px rgba(246, 216, 147, 0.65);
      transform: translateX(-50%) scale(1.2);
    }

    .ag-minimap-list {
      position: fixed;
      z-index: 60;
      width: 286px;
      max-height: 62vh;
      overflow-y: auto;
      padding: 7px;
      border: 1px solid rgba(246, 216, 147, 0.14);
      border-radius: 12px;
      background: rgba(14, 11, 28, 0.96);
      box-shadow: 0 18px 45px rgba(3, 2, 10, 0.58);
      backdrop-filter: blur(18px);
      opacity: 0;
      pointer-events: none;
      transform: translateX(6px);
      transition: opacity 150ms ease, transform 150ms ease;
    }

    .ag-minimap-list.is-visible {
      opacity: 1;
      pointer-events: auto;
      transform: translateX(0);
    }

    .ag-minimap-list-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 4px 7px 7px;
      color: var(--ag-accent);
      font-size: 10px;
      letter-spacing: 0.08em;
    }

    .ag-minimap-list-head strong {
      font-weight: 600;
    }

    .ag-minimap-list-head span {
      color: rgba(217, 210, 232, 0.5);
      letter-spacing: 0;
    }

    .ag-minimap-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      width: 100%;
      padding: 7px 8px;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: #C9C1DA;
      text-align: left;
      cursor: pointer;
      transition: background 140ms ease, color 140ms ease;
    }

    .ag-minimap-item:hover,
    .ag-minimap-item.is-current {
      background: rgba(246, 216, 147, 0.09);
      color: #FFF1BF;
    }

    .ag-minimap-item-index {
      flex: 0 0 auto;
      display: grid;
      place-items: center;
      width: 18px;
      height: 18px;
      margin-top: 1px;
      border: 1px solid rgba(246, 216, 147, 0.16);
      border-radius: 50%;
      color: rgba(246, 216, 147, 0.7);
      font-size: 9px;
      line-height: 1;
    }

    .ag-minimap-item.is-current .ag-minimap-item-index {
      background: rgba(246, 216, 147, 0.18);
      border-color: rgba(246, 216, 147, 0.4);
      color: #FFF1BF;
    }

    .ag-minimap-item-text {
      display: -webkit-box;
      overflow: hidden;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      font-size: 11px;
      line-height: 1.45;
    }

    .ag-minimap-preview {
      position: fixed;
      z-index: 59;
      width: 236px;
      padding: 9px 11px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 9px;
      background: rgba(16, 13, 32, 0.94);
      box-shadow: 0 12px 30px rgba(3, 2, 10, 0.5);
      backdrop-filter: blur(14px);
      color: #D9D2E8;
      font-size: 11px;
      line-height: 1.55;
      opacity: 0;
      pointer-events: none;
      transform: translateY(4px);
      transition: opacity 140ms ease, transform 140ms ease;
    }

    .ag-minimap-preview.is-visible {
      opacity: 1;
      transform: translateY(0);
    }

    .ag-minimap-preview strong {
      display: block;
      margin-bottom: 3px;
      color: var(--ag-accent);
      font-size: 9.5px;
      letter-spacing: 0.08em;
      font-weight: 600;
    }

    .ag-minimap-preview p {
      display: -webkit-box;
      overflow: hidden;
      -webkit-line-clamp: 4;
      -webkit-box-orient: vertical;
      color: #B9B0CC;
      margin: 0;
    }

    /* 统一罗盘：插件 / Skills / 收藏 */
    .ag-plugin-tabs {
      display: flex;
      gap: 3px;
      padding: 6px 8px 4px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.045);
    }

    .ag-plugin-tab {
      flex: 1 1 0;
      height: 24px;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      color: #8D9BB0;
      font-size: 10.5px;
      font-weight: 600;
      cursor: pointer;
      transition: background-color 140ms ease, color 140ms ease;
    }

    .ag-plugin-tab:hover {
      background: rgba(255, 255, 255, 0.04);
      color: #D9D2E8;
    }

    .ag-plugin-tab.is-active {
      background: rgba(246, 216, 147, 0.09);
      border-color: rgba(246, 216, 147, 0.16);
      color: var(--ag-accent);
    }

    .ag-skill-star {
      width: 20px;
      height: 20px;
      margin-left: auto;
      flex: 0 0 20px;
      display: grid;
      place-items: center;
      border: 0;
      border-radius: 5px;
      background: transparent;
      color: #6E7D92;
      font-size: 12px;
      cursor: pointer;
    }

    .ag-skill-star:hover {
      background: rgba(255, 255, 255, 0.05);
      color: var(--ag-accent);
    }

    .ag-skill-star.is-favorite {
      color: var(--ag-accent);
    }

    .ag-plugin-empty {
      padding: 16px 10px;
      text-align: center;
      color: #7E8CA1;
      font-size: 11px;
    }

    .ag-plugin-create[hidden] {
      display: none !important;
    }

    /* 底栏思考强度胶囊 */
    #ag-effort-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      width: 118px;
      height: 24px;
      margin-left: 4px;
      padding: 0 7px;
      overflow: visible;
      border: 1px solid rgba(255, 255, 255, 0.075);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.028);
      vertical-align: middle;
      transition: opacity 140ms ease, border-color 140ms ease, background-color 140ms ease;
    }

    #ag-effort-pill:hover {
      border-color: rgba(246, 216, 147, 0.22);
      background: rgba(255, 255, 255, 0.04);
    }

    #ag-effort-pill.is-applying {
      opacity: 0.65;
    }

    #ag-effort-pill.is-applying .ag-effort-track {
      pointer-events: none;
    }

    .ag-effort-pill-live {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      width: 118px;
      height: 24px;
      margin-left: 4px;
      padding: 0 7px;
      overflow: visible;
      border: 1px solid rgba(255, 255, 255, 0.075);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.028);
      vertical-align: middle;
      transition: opacity 140ms ease, border-color 140ms ease, background-color 140ms ease;
    }

    .ag-effort-pill-live:hover {
      border-color: rgba(246, 216, 147, 0.22);
      background: rgba(255, 255, 255, 0.04);
    }

    .ag-effort-pill-live.is-applying {
      opacity: 0.72;
      border-color: rgba(246, 216, 147, 0.18);
    }

    .ag-effort-pill-live.is-applying .ag-effort-track {
      pointer-events: none;
    }

    html.ag-effort-isolated #ag-effort-pill {
      display: none !important;
    }

    .ag-effort-kicker {
      flex: 0 0 auto;
      color: #7F8CA0;
      font-size: 8.5px;
      letter-spacing: 0.08em;
    }

    .ag-effort-track {
      position: relative;
      flex: 1 1 auto;
      min-width: 0;
      height: 16px;
      box-sizing: border-box;
      padding: 0 5px;
      display: flex;
      align-items: center;
      cursor: grab;
      touch-action: none;
      user-select: none;
      --pos: 1;
    }

    .ag-effort-track.is-dragging {
      cursor: grabbing;
    }

    .ag-effort-track:focus-visible {
      outline: 1px solid rgba(246, 216, 147, 0.35);
      outline-offset: 2px;
      border-radius: 5px;
    }

    .ag-effort-rail {
      position: absolute;
      left: 5px;
      right: 5px;
      top: 50%;
      height: 3px;
      transform: translateY(-50%);
      border-radius: 2px;
      background: rgba(255, 255, 255, 0.10);
      pointer-events: none;
    }

    .ag-effort-fill {
      position: absolute;
      left: 5px;
      top: 50%;
      height: 3px;
      width: calc(100% - 10px);
      transform-origin: 0 50%;
      transform: translateY(-50%) scaleX(var(--pos));
      border-radius: 2px;
      background: linear-gradient(90deg, rgba(246, 216, 147, 0.55) 0%, var(--ag-accent) 100%);
      box-shadow: 0 0 6px rgba(246, 216, 147, 0.28);
      pointer-events: none;
    }

    .ag-effort-thumb {
      position: absolute;
      left: 5px;
      top: 50%;
      box-sizing: border-box;
      width: 11px;
      height: 11px;
      transform: translate3d(calc(var(--pos) * var(--track-travel, 50px)), -50%, 0) scale(var(--thumb-scale, 1));
      border: 2px solid #0d0a1c;
      border-radius: 50%;
      background: var(--ag-accent);
      box-shadow: 0 0 6px rgba(246, 216, 147, 0.5);
      pointer-events: none;
      transition: box-shadow 140ms ease;
    }

    .ag-effort-track:hover .ag-effort-thumb {
      --thumb-scale: 1.18;
      box-shadow: 0 0 9px rgba(246, 216, 147, 0.65);
    }

    .ag-effort-track.is-dragging .ag-effort-thumb {
      --thumb-scale: 1.3;
      box-shadow: 0 0 10px rgba(246, 216, 147, 0.8);
    }

    .ag-effort-ticks {
      position: absolute;
      left: 5px;
      right: 5px;
      bottom: 0;
      height: 3px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      pointer-events: none;
    }

    .ag-effort-ticks i {
      width: 2px;
      height: 2px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.24);
      transition: background-color 160ms ease;
    }

    .ag-effort-track[data-level="0"] .ag-effort-ticks i:first-child,
    .ag-effort-track[data-level="1"] .ag-effort-ticks i:nth-child(2),
    .ag-effort-track[data-level="2"] .ag-effort-ticks i:last-child {
      background: rgba(246, 216, 147, 0.75);
    }

    .ag-effort-value {
      flex: 0 0 12px;
      width: 12px;
      color: var(--ag-accent);
      font-size: 10px;
      font-weight: 600;
      text-align: right;
      font-variant-numeric: tabular-nums;
      transition: color 160ms ease;
    }

    /* Quest Complete 横幅 */
    #ag-quest-banner {
      position: fixed;
      top: 46px;
      left: 50%;
      z-index: 7000;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 18px;
      border: 1px solid rgba(246, 216, 147, 0.28);
      border-radius: 999px;
      background: linear-gradient(135deg, rgba(30, 22, 52, 0.94) 0%, rgba(18, 13, 36, 0.96) 100%);
      box-shadow: 0 10px 30px rgba(3, 2, 10, 0.45), 0 0 20px -8px rgba(246, 216, 147, 0.4);
      color: #F6EBD8;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.06em;
      opacity: 0;
      pointer-events: none;
      transform: translate(-50%, -10px);
      transition: opacity 240ms ease, transform 240ms ease;
    }

    #ag-quest-banner.is-visible {
      opacity: 1;
      transform: translate(-50%, 0);
    }

    #ag-quest-banner .ag-quest-star {
      color: var(--ag-accent);
      font-size: 13px;
    }

    #ag-quest-banner .ag-quest-sub {
      color: #9F92B8;
      font-size: 10px;
      font-weight: 500;
      letter-spacing: 0.04em;
    }

    /* 沉浸观星 */
    #ag-immersive-toggle {
      position: fixed;
      top: 44px;
      right: 16px;
      z-index: 5000;
      width: 26px;
      height: 26px;
      display: grid;
      place-items: center;
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 7px;
      background: rgba(16, 12, 32, 0.45);
      color: #9A8DB5;
      opacity: 0.32;
      cursor: pointer;
      backdrop-filter: blur(10px);
      transition: opacity 160ms ease, color 160ms ease, border-color 160ms ease;
    }

    #ag-immersive-toggle:hover,
    html.ag-immersive #ag-immersive-toggle {
      opacity: 1;
      color: var(--ag-accent);
      border-color: rgba(246, 216, 147, 0.24);
    }

    html.ag-immersive .bg-sidebar:has([data-testid="settings-button"]),
    html.ag-immersive .isolate.h-full.overflow-y-auto {
      opacity: 0.05 !important;
      transition: opacity 450ms cubic-bezier(0.22, 1, 0.36, 1) !important;
    }

    html.ag-immersive.ag-immersive-awake .bg-sidebar:has([data-testid="settings-button"]),
    html.ag-immersive.ag-immersive-awake .isolate.h-full.overflow-y-auto {
      opacity: 1 !important;
    }

    /* v3.0 右侧面板 / 提示框 / 复制 / 顶栏细节 */
    #ag-immersive-toggle {
      top: 4px !important;
      right: 153px !important;
      z-index: 6000 !important;
      -webkit-app-region: no-drag;
    }

    #ag-starlight-launch {
      position: fixed !important;
      top: 4px !important;
      right: 185px !important;
      margin: 0 !important;
      z-index: 6000 !important;
      -webkit-app-region: no-drag;
    }

    [data-aux-pane-focus-scope="true"] {
      background:
        radial-gradient(120% 80% at 100% 0%, rgba(139, 92, 246, 0.06) 0%, transparent 55%),
        linear-gradient(180deg, rgba(16, 13, 32, 0.76) 0%, rgba(11, 9, 24, 0.70) 100%) !important;
      -webkit-backdrop-filter: blur(var(--ag-glass-blur, 24px)) saturate(155%);
      backdrop-filter: blur(var(--ag-glass-blur, 24px)) saturate(155%);
    }

    [data-aux-pane-focus-scope="true"] .bg-background,
    [data-aux-pane-focus-scope="true"] [data-testid="artifact-view"] {
      background: transparent !important;
    }

    [data-active-tab-id] {
      border-color: rgba(255, 255, 255, 0.06) !important;
      background: linear-gradient(180deg, rgba(22, 18, 40, 0.66) 0%, rgba(14, 11, 28, 0.50) 100%) !important;
    }

    [data-active-tab-id] button[data-tab-id] {
      border-radius: 8px 8px 0 0 !important;
      color: #9DA9BC !important;
      transition: color 150ms ease, background-color 150ms ease !important;
    }

    [data-active-tab-id] button[data-tab-id]:hover {
      color: #E9EFF8 !important;
      background: rgba(255, 255, 255, 0.035) !important;
    }

    [data-active-tab-id] button[data-tab-id][aria-selected="true"],
    [data-active-tab-id] button[data-tab-id].is-active,
    [data-active-tab-id] button[data-tab-id][data-active="true"] {
      color: #F6EBD8 !important;
      background: linear-gradient(180deg, rgba(246, 216, 147, 0.10) 0%, rgba(246, 216, 147, 0.02) 100%) !important;
      box-shadow: inset 0 1px 0 rgba(246, 216, 147, 0.22) !important;
    }

    [class*="group/file-row"] {
      border-bottom: 1px solid rgba(255, 255, 255, 0.045) !important;
      background: rgba(12, 14, 26, 0.22) !important;
    }

    [data-aux-pane-focus-scope="true"] [data-testid="more-actions-overflow"],
    .ag-quick-copy-btn,
    .ag-quick-copy-chat {
      -webkit-app-region: no-drag;
    }

    .artifact-card {
      border: 1px solid rgba(196, 181, 253, 0.14) !important;
      border-radius: 12px !important;
      background:
        radial-gradient(120% 180% at 0% 0%, rgba(165, 180, 252, 0.07) 0%, transparent 55%),
        rgba(14, 17, 34, 0.55) !important;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035) !important;
      line-height: 1.55 !important;
      transition: border-color 160ms ease, transform 160ms ease, background-color 160ms ease !important;
    }

    .artifact-card:hover {
      border-color: rgba(246, 216, 147, 0.24) !important;
      transform: translateY(-1px);
    }

    [data-testid="artifact-update-notice"] {
      border: 1px solid rgba(246, 216, 147, 0.20) !important;
      border-radius: 999px !important;
      background: rgba(24, 20, 38, 0.88) !important;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.04) !important;
    }

    button[aria-label="Scroll to Bottom"] {
      background: rgba(18, 14, 36, 0.96) !important;
      border-color: rgba(246, 216, 147, 0.24) !important;
      color: #F6D893 !important;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.36), 0 0 16px -8px rgba(246, 216, 147, 0.6) !important;
      -webkit-backdrop-filter: blur(14px);
      backdrop-filter: blur(14px);
    }

    button[aria-label="Scroll to Bottom"]:hover {
      background: rgba(30, 24, 48, 0.98) !important;
      border-color: rgba(246, 216, 147, 0.42) !important;
    }

    .markdown-alert {
      margin: 12px 0 !important;
      padding: 12px 14px 12px 14px !important;
      border: 1px solid rgba(255, 255, 255, 0.075) !important;
      border-left: 3px solid var(--ag-alert-accent, #C4B5FD) !important;
      border-radius: 12px !important;
      background:
        linear-gradient(90deg, color-mix(in srgb, var(--ag-alert-accent, #C4B5FD) 9%, transparent) 0%, transparent 42%),
        rgba(14, 17, 34, 0.58) !important;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035) !important;
    }

    .markdown-alert-important { --ag-alert-accent: #C4B5FD; }
    .markdown-alert-note { --ag-alert-accent: #7DD3FC; }
    .markdown-alert-tip { --ag-alert-accent: #86E0C0; }
    .markdown-alert-warning { --ag-alert-accent: #F6D893; }
    .markdown-alert-caution { --ag-alert-accent: #FCA5A5; }

    .markdown-alert-title {
      display: inline-flex !important;
      align-items: center !important;
      width: fit-content !important;
      margin: 0 0 7px 0 !important;
      padding: 2px 9px !important;
      border: 1px solid color-mix(in srgb, var(--ag-alert-accent, #C4B5FD) 30%, transparent) !important;
      border-radius: 999px !important;
      background: color-mix(in srgb, var(--ag-alert-accent, #C4B5FD) 10%, transparent) !important;
      color: var(--ag-alert-accent, #C4B5FD) !important;
      font-size: 10px !important;
      font-weight: 600 !important;
      letter-spacing: 0.06em !important;
      line-height: 16px !important;
    }

    [data-markdown-root] table {
      border-collapse: separate !important;
      border-spacing: 0 !important;
      border: 1px solid rgba(255, 255, 255, 0.075) !important;
      border-radius: 10px !important;
      overflow: hidden !important;
    }

    [data-markdown-root] th {
      background: rgba(165, 180, 252, 0.08) !important;
      color: #DCE6F2 !important;
      font-weight: 600 !important;
    }

    [data-markdown-root] tr:hover td {
      background: rgba(246, 216, 147, 0.035) !important;
    }

    [data-aux-pane-focus-scope="true"] .bg-muted {
      background: rgba(255, 255, 255, 0.045) !important;
    }
  `;
}

function applyWallpaper(options = {}) {
  const port = getDevToolsPort();
  if (!port) {
    console.error('[Wallpaper] DevToolsActivePort not found. Is Antigravity running?');
    return;
  }

  const pluginDir = path.resolve(__dirname, '..');
  const configPath = path.join(pluginDir, 'config', 'config.json');
  let cfg = {
    enabled: true,
    opacity: 0.58,
    wallpaperPath: 'assets/wallpaper.jpg'
  };

  if (fs.existsSync(configPath)) {
    try {
      cfg = { ...cfg, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
    } catch (e) {}
  }

  if (options.opacity !== undefined) cfg.opacity = options.opacity;
  if (options.wallpaperPath) cfg.wallpaperPath = options.wallpaperPath;

  let fullImgPath = path.isAbsolute(cfg.wallpaperPath) 
    ? cfg.wallpaperPath 
    : path.join(pluginDir, cfg.wallpaperPath);

  if (!fs.existsSync(fullImgPath)) {
    console.error('[Wallpaper] Wallpaper image not found:', fullImgPath);
    return;
  }

  const imgBase64 = fs.readFileSync(fullImgPath).toString('base64');
  const ext = path.extname(fullImgPath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : 'image/jpeg');
  const dataUri = `data:${mime};base64,${imgBase64}`;

  const css = generateThemeCss(dataUri, cfg);
  const pluginCatalog = readPluginCatalog(pluginDir);
  const skillPathMap = readSkillPathMap(pluginDir);
  const skillCatalog = readSkillCatalog(pluginDir);
  const usageEndpoints = findUsageEndpoints();
  let sidecarPort = 39290;
  try {
    const runtime = JSON.parse(fs.readFileSync(path.join(pluginDir, 'config', 'runtime.json'), 'utf8'));
    if (Number.isInteger(runtime.port) && runtime.port > 0) sidecarPort = runtime.port;
  } catch (error) {}
  let defaultPrompts = [];
  try {
    defaultPrompts = JSON.parse(fs.readFileSync(path.join(__dirname, 'default-prompts.json'), 'utf8'));
  } catch (error) {
    defaultPrompts = [];
  }
  const enhancePath = path.join(__dirname, 'ui-enhance.js');
  const memoryPath = path.join(__dirname, 'memory-page.js');
  let enhanceScript = '';
  let memoryScript = '';
  let extraScripts = '';

  try {
    if (fs.existsSync(enhancePath)) enhanceScript = fs.readFileSync(enhancePath, 'utf8');
  } catch (error) {
    console.warn('[Wallpaper] Failed to read ui-enhance.js:', error.message);
  }
  try {
    if (fs.existsSync(memoryPath)) memoryScript = fs.readFileSync(memoryPath, 'utf8');
  } catch (error) {
    console.warn('[Wallpaper] Failed to read memory-page.js:', error.message);
  }
  for (const extraName of ['i18n-engine.js', 'running-radar.js', 'quick-copy.js', 'telemetry-panels.js', 'resource-actions.js', 'starlight-settings.js']) {
    const extraPath = path.join(__dirname, extraName);
    try {
      if (fs.existsSync(extraPath)) extraScripts += '\n;\n' + fs.readFileSync(extraPath, 'utf8');
    } catch (error) {
      console.warn('[Wallpaper] Failed to read ' + extraName + ':', error.message);
    }
  }

  const applyConfigSource = `
window.__agApplyConfig = function (patch) {
  if (!patch || typeof patch !== 'object') return window.__AG_CONFIG;
  window.__AG_CONFIG = Object.assign({}, window.__AG_CONFIG || {}, patch);
  const p = patch;
  const style = document.documentElement.style;
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)));
  if (isNum(p.opacity)) style.setProperty('--ag-wp-opacity', String(clamp(p.opacity, 0, 1)));
  if (isNum(p.darkTint)) style.setProperty('--ag-wp-tint', String(clamp(p.darkTint, 0, 0.95)));
  if (isNum(p.blur)) style.setProperty('--ag-glass-blur', clamp(p.blur, 0, 60) + 'px');
  if (isNum(p.focusX)) style.setProperty('--ag-focus-x', clamp(p.focusX, 0, 100) + '%');
  if (isNum(p.focusY)) style.setProperty('--ag-focus-y', clamp(p.focusY, 0, 100) + '%');
  if (p.palette && typeof p.palette === 'object') {
    const hex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : null;
    const accent = hex(p.palette.accent);
    const highlight = hex(p.palette.highlight);
    const cool = hex(p.palette.cool);
    const dark = hex(p.palette.dark);
    if (accent) style.setProperty('--ag-accent-cool', accent);
    if (highlight) style.setProperty('--ag-accent-alt', highlight);
    if (cool) style.setProperty('--ag-accent-tertiary', cool);
    if (dark) style.setProperty('--ag-palette-dark', dark);
  }
  if (p.fontPreset && ['editorial-luxe', 'modern-silk', 'literary-serif', 'starry-game'].includes(p.fontPreset)) {
    document.documentElement.dataset.agFont = p.fontPreset;
  }
  if (isNum(p.fontScale)) style.setProperty('--ag-font-scale', String(clamp(p.fontScale, 0.85, 1.15)));
  if (p.starEffectMode || isNum(p.starIntensity) || isNum(p.meteorFrequency)) {
    window.__AG_STAR_CONFIG = Object.assign({}, window.__AG_STAR_CONFIG || {}, {
      mode: p.starEffectMode || (window.__AG_STAR_CONFIG || {}).mode,
      intensity: isNum(p.starIntensity) ? clamp(p.starIntensity, 0, 1) : (window.__AG_STAR_CONFIG || {}).intensity,
      frequency: isNum(p.meteorFrequency) ? clamp(p.meteorFrequency, 0, 1) : (window.__AG_STAR_CONFIG || {}).frequency
    });
    if (typeof window.__agUpdateStarCosmos === 'function') window.__agUpdateStarCosmos();
  }
  if (typeof p.promptSticky === 'boolean') {
    document.documentElement.classList.toggle('ag-prompt-sticky', p.promptSticky);
    if (typeof window.__agUpdatePromptSticky === 'function') window.__agUpdatePromptSticky();
  }
  if (p.language) {
    document.documentElement.lang = p.language;
    try { window.__agI18n?.setLanguage?.(p.language); } catch (error) {}
  }
  if (p.cursorParticles === false) document.getElementById('antigravity-cursor-particles')?.remove();
  document.dispatchEvent(new CustomEvent('ag-config-updated', { detail: p }));
  return window.__AG_CONFIG;
};
`;

  http.get(`http://127.0.0.1:${port}/json`, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      let targets;
      try {
        targets = JSON.parse(data);
      } catch (e) {
        console.error('[Wallpaper] Failed to parse DevTools targets:', e);
        return;
      }

      const pages = targets.filter(x => x.type === 'page');
      pages.forEach((page) => {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        let enhanceSent = false;
        ws.onopen = () => {
          const code = `
            (() => {
              let layer = document.getElementById('antigravity-custom-bg-layer');
              if (!layer) {
                layer = document.createElement('div');
                layer.id = 'antigravity-custom-bg-layer';
                document.body.prepend(layer);
              }
              let style = document.getElementById('antigravity-custom-bg-style');
              if (!style) {
                style = document.createElement('style');
                style.id = 'antigravity-custom-bg-style';
                document.head.appendChild(style);
              }
              style.textContent = ${JSON.stringify(css)};

              const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

              function installCursorParticles() {
                if (reduceMotion.matches) {
                  const existing = document.getElementById('antigravity-cursor-particles');
                  if (existing) existing.remove();
                  return 'disabled';
                }

                let canvas = document.getElementById('antigravity-cursor-particles');
                if (!canvas) {
                  canvas = document.createElement('canvas');
                  canvas.id = 'antigravity-cursor-particles';
                  Object.assign(canvas.style, {
                    position: 'fixed',
                    inset: '0',
                    width: '100vw',
                    height: '100vh',
                    pointerEvents: 'none',
                    zIndex: '5000',
                    mixBlendMode: 'screen',
                    opacity: '0.78'
                  });
                  document.body.appendChild(canvas);
                }

                if (canvas.dataset.agReady === '1') return 'ready';
                canvas.dataset.agReady = '1';

                const ctx = canvas.getContext('2d');
                if (!ctx) return 'no-context';

                const colors = ['246,216,147', '196,181,253', '249,168,212', '125,211,252'];
                let viewportW = 0;
                let viewportH = 0;
                let dpr = 1;
                let particles = [];
                let rafId = 0;
                let lastMoveAt = 0;
                let pointerX = -100;
                let pointerY = -100;
                let pointerAt = 0;

                function resize() {
                  dpr = Math.min(window.devicePixelRatio || 1, 2);
                  viewportW = window.innerWidth;
                  viewportH = window.innerHeight;
                  canvas.width = Math.max(1, Math.floor(viewportW * dpr));
                  canvas.height = Math.max(1, Math.floor(viewportH * dpr));
                  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                }

                resize();
                window.addEventListener('resize', resize, { passive: true });

                function spawn(x, y, count) {
                  const now = performance.now();
                  for (let i = 0; i < count; i += 1) {
                    particles.push({
                      x: x + (Math.random() - 0.5) * 8,
                      y: y + (Math.random() - 0.5) * 8,
                      vx: (Math.random() - 0.5) * 0.42,
                      vy: -0.12 - Math.random() * 0.5,
                      size: 0.7 + Math.random() * 1.55,
                      life: 420 + Math.random() * 420,
                      born: now + Math.random() * 50,
                      color: colors[(Math.random() * colors.length) | 0],
                      shape: Math.random() < 0.4 ? 'star' : 'dust',
                      rotation: Math.random() * Math.PI,
                      twinkle: Math.random() * Math.PI * 2
                    });
                  }
                  if (particles.length > 140) particles.splice(0, particles.length - 140);
                  if (!rafId) rafId = requestAnimationFrame(draw);
                }

                function drawFourPointStar(x, y, radius, rotation) {
                  ctx.save();
                  ctx.translate(x, y);
                  ctx.rotate(rotation);
                  ctx.beginPath();
                  for (let i = 0; i < 4; i += 1) {
                    const angle = (i * Math.PI) / 2;
                    ctx.lineTo(Math.cos(angle) * radius * 2.1, Math.sin(angle) * radius * 2.1);
                    const midAngle = angle + Math.PI / 4;
                    ctx.lineTo(Math.cos(midAngle) * radius * 0.42, Math.sin(midAngle) * radius * 0.42);
                  }
                  ctx.closePath();
                  ctx.fill();
                  ctx.restore();
                }

                function draw(now) {
                  ctx.clearRect(0, 0, viewportW, viewportH);

                  if (now - pointerAt < 260 && pointerX > 0 && pointerY > 0) {
                    const fade = 1 - (now - pointerAt) / 260;
                    const halo = ctx.createRadialGradient(pointerX, pointerY, 0, pointerX, pointerY, 38);
                    halo.addColorStop(0, 'rgba(246,216,147,' + (0.095 * fade) + ')');
                    halo.addColorStop(0.42, 'rgba(196,181,253,' + (0.050 * fade) + ')');
                    halo.addColorStop(1, 'rgba(246,216,147,0)');
                    ctx.fillStyle = halo;
                    ctx.beginPath();
                    ctx.arc(pointerX, pointerY, 38, 0, Math.PI * 2);
                    ctx.fill();
                  }

                  ctx.globalCompositeOperation = 'lighter';
                  for (let i = particles.length - 1; i >= 0; i -= 1) {
                    const p = particles[i];
                    const age = (now - p.born) / p.life;
                    if (age < 0) continue;
                    if (age >= 1) {
                      particles.splice(i, 1);
                      continue;
                    }
                    const x = p.x + p.vx * (now - p.born) * 0.08;
                    const y = p.y + p.vy * (now - p.born) * 0.08;
                    const twinkle = 0.78 + 0.22 * Math.sin(now * 0.004 + p.twinkle);
                    const alpha = (1 - age) * 0.56 * twinkle;
                    const radius = p.size * (1 - age * 0.45);
                    ctx.fillStyle = 'rgba(' + p.color + ',' + alpha + ')';
                    if (p.shape === 'star') {
                      drawFourPointStar(x, y, Math.max(1.1, radius * 1.35), p.rotation + (now - p.born) * 0.0012);
                    } else {
                      ctx.beginPath();
                      ctx.arc(x, y, radius, 0, Math.PI * 2);
                      ctx.fill();
                    }
                  }
                  ctx.globalCompositeOperation = 'source-over';

                  if (particles.length > 0) {
                    rafId = requestAnimationFrame(draw);
                  } else {
                    rafId = 0;
                    ctx.clearRect(0, 0, viewportW, viewportH);
                  }
                }

                window.addEventListener('pointermove', (event) => {
                  pointerX = event.clientX;
                  pointerY = event.clientY;
                  pointerAt = performance.now();
                  if (pointerAt - lastMoveAt < 20) return;
                  lastMoveAt = pointerAt;
                  spawn(event.clientX, event.clientY, 2);
                }, { passive: true });

                window.addEventListener('pointerdown', (event) => {
                  pointerX = event.clientX;
                  pointerY = event.clientY;
                  pointerAt = performance.now();
                  spawn(event.clientX, event.clientY, 8);
                }, { passive: true });

                return 'ready';
              }

              function installSectionHints() {
                document.querySelectorAll('.bg-sidebar h2 > button[aria-expanded]').forEach((button) => {
                  if (button.dataset.agCollapseHint === '1') return;
                  button.dataset.agCollapseHint = '1';
                  const sync = () => {
                    button.title = button.getAttribute('aria-expanded') === 'false' ? '展开分组' : '收起分组';
                  };
                  sync();
                  new MutationObserver(sync).observe(button, {
                    attributes: true,
                    attributeFilter: ['aria-expanded']
                  });
                });
              }

              function installAttachmentReorder() {
                if (window.__agAttachmentReorderInstalled) return 'ready';
                window.__agAttachmentReorderInstalled = true;

                let handleRef = null;
                let press = null;
                let drag = null;
                let suppressClickUntil = 0;
                let watchdog = 0;

                document.addEventListener('dragstart', (event) => {
                  if (event.target.closest?.('[data-testid="input-attachment"]')) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                  }
                }, true);

                const getComposer = () => document.getElementById('antigravity.agentSidePanelInputBox');
                const getItems = () => {
                  const composer = getComposer();
                  return composer ? Array.from(composer.querySelectorAll('[data-testid="input-attachment"]')) : [];
                };

                function findHandleRef() {
                  if (handleRef?.current?.setMediaAttachments) return handleRef;
                  const composer = getComposer();
                  if (!composer) return null;
                  const fiberKey = Object.keys(composer).find((key) => key.startsWith('__reactFiber$'));
                  if (!fiberKey) return null;

                  let fiber = composer[fiberKey];
                  for (let i = 0; i < 24 && fiber.return; i += 1) fiber = fiber.return;

                  const stack = [fiber];
                  const seen = new Set();
                  let steps = 0;
                  while (stack.length && steps < 8000) {
                    const node = stack.pop();
                    if (!node || seen.has(node)) continue;
                    seen.add(node);
                    steps += 1;

                    const props = node.memoizedProps;
                    if (props && typeof props === 'object') {
                      const candidate = props.inputBoxRef;
                      if (candidate?.current?.setMediaAttachments && candidate.current?.getMediaAttachments) {
                        handleRef = candidate;
                        return handleRef;
                      }
                    }

                    if (node.sibling) stack.push(node.sibling);
                    if (node.child) stack.push(node.child);
                  }
                  return null;
                }

                function clearPressTimer() {
                  if (press?.timer) clearTimeout(press.timer);
                  press = null;
                }

                function clearDragMarks() {
                  if (watchdog) {
                    clearTimeout(watchdog);
                    watchdog = 0;
                  }
                  if (drag?.item && drag.pointerId !== undefined) {
                    try { drag.item.releasePointerCapture(drag.pointerId); } catch (error) {}
                  }
                  getItems().forEach((item) => {
                    item.classList.remove('ag-attachment-lifted');
                    item.removeAttribute('data-ag-drop-target');
                    item.style.transform = '';
                    item.style.zIndex = '';
                  });
                  document.documentElement.classList.remove('ag-attachment-reordering');
                  drag = null;
                }

                function armDrag() {
                  if (!press || !press.item.isConnected) {
                    clearPressTimer();
                    return;
                  }
                  drag = {
                    item: press.item,
                    from: press.from,
                    target: press.from,
                    x: press.x,
                    y: press.y,
                    pointerId: press.pointerId
                  };
                  try { press.item.setPointerCapture(press.pointerId); } catch (error) {}
                  press.item.classList.add('ag-attachment-lifted');
                  document.documentElement.classList.add('ag-attachment-reordering');
                  watchdog = setTimeout(() => {
                    clearPressTimer();
                    clearDragMarks();
                  }, 15000);
                }

                function updateDrag(event) {
                  if (!drag) return;
                  event.preventDefault();
                  event.stopPropagation();

                  const dx = event.clientX - drag.x;
                  const dy = event.clientY - drag.y;
                  drag.item.style.transform = 'translate(' + dx + 'px, ' + dy + 'px) scale(1.08)';
                  drag.item.style.zIndex = '30';

                  const items = getItems();
                  let bestIndex = drag.from;
                  let bestDistance = Infinity;
                  items.forEach((item, index) => {
                    if (item === drag.item) return;
                    const rect = item.getBoundingClientRect();
                    const cx = rect.left + rect.width / 2;
                    const cy = rect.top + rect.height / 2;
                    const distance = (event.clientX - cx) ** 2 + (event.clientY - cy) ** 2;
                    if (distance < bestDistance) {
                      bestDistance = distance;
                      bestIndex = index;
                    }
                  });

                  drag.target = bestIndex;
                  items.forEach((item, index) => {
                    if (index === bestIndex && item !== drag.item) {
                      item.setAttribute('data-ag-drop-target', 'true');
                    } else {
                      item.removeAttribute('data-ag-drop-target');
                    }
                  });
                }

                function finishDrag(event) {
                  if (drag) {
                    event.preventDefault();
                    event.stopPropagation();
                    suppressClickUntil = performance.now() + 420;

                    const from = drag.from;
                    const to = drag.target;
                    clearDragMarks();
                    try {
                      const ref = findHandleRef();
                      const handle = ref?.current;
                      const media = handle?.getMediaAttachments?.();
                      if (Array.isArray(media) && media.length > 1 && from !== to) {
                        const next = media.slice();
                        const moved = next.splice(from, 1)[0];
                        next.splice(Math.min(to, next.length), 0, moved);
                        handle.setMediaAttachments(next);
                      }
                    } catch (error) {
                      console.warn('[Wallpaper] Attachment reorder failed:', error);
                    }
                  }
                  clearPressTimer();
                }

                document.addEventListener('pointerdown', (event) => {
                  if (event.pointerType === 'mouse' && event.button !== 0) return;
                  const item = event.target.closest?.('[data-testid="input-attachment"]');
                  const composer = getComposer();
                  if (!item || !composer?.contains(item)) return;

                  const items = getItems();
                  const index = items.indexOf(item);
                  if (index < 0 || items.length < 2) return;

                  clearPressTimer();
                  clearDragMarks();
                  press = {
                    item,
                    from: index,
                    x: event.clientX,
                    y: event.clientY,
                    pointerId: event.pointerId,
                    timer: setTimeout(armDrag, 220)
                  };
                }, true);

                document.addEventListener('pointermove', (event) => {
                  if (press && !drag) {
                    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 6) {
                      clearPressTimer();
                    }
                    return;
                  }
                  updateDrag(event);
                }, { capture: true, passive: false });

                document.addEventListener('pointerup', finishDrag, true);
                document.addEventListener('pointercancel', () => {
                  clearPressTimer();
                  clearDragMarks();
                }, true);
                document.addEventListener('lostpointercapture', () => {
                  clearPressTimer();
                  clearDragMarks();
                }, true);
                document.addEventListener('visibilitychange', () => {
                  if (document.hidden) {
                    clearPressTimer();
                    clearDragMarks();
                  }
                });
                document.addEventListener('keydown', (event) => {
                  if (event.key === 'Escape') {
                    clearPressTimer();
                    clearDragMarks();
                  }
                }, true);
                window.addEventListener('blur', () => {
                  clearPressTimer();
                  clearDragMarks();
                });

                document.addEventListener('contextmenu', (event) => {
                  if (!drag) return;
                  event.preventDefault();
                  event.stopPropagation();
                }, true);

                document.addEventListener('click', (event) => {
                  if (performance.now() >= suppressClickUntil) return;
                  if (!event.target.closest?.('[data-testid="input-attachment"]')) return;
                  event.preventDefault();
                  event.stopPropagation();
                }, true);

                document.addEventListener('pointerover', (event) => {
                  const item = event.target.closest?.('[data-testid="input-attachment"]');
                  if (item && !item.title) item.title = '长按拖动调整顺序';
                }, { passive: true });

                return 'ready';
              }

              installCursorParticles();
              installSectionHints();
              installAttachmentReorder();

              window.__agUiPolish = {
                refresh() {
                  installCursorParticles();
                  installSectionHints();
                  installAttachmentReorder();
                }
              };

              return 'Starlight Obsidian Glass Applied';
            })()
          `;

          ws.send(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression: code, returnByValue: true }
          }));
        };

        ws.onmessage = (msg) => {
          let response = null;
          try {
            response = JSON.parse(msg.data);
          } catch (error) {}

          if (!enhanceSent && (enhanceScript || memoryScript || extraScripts)) {
            enhanceSent = true;
            if (response?.result?.exceptionDetails) {
              console.error('[Wallpaper] Theme injection error:', response.result.exceptionDetails.text);
            }
            const expression =
              'window.__AG_INSTALLED_PLUGINS = ' + JSON.stringify(pluginCatalog) + ';\n' +
              'window.__AG_USAGE_ENDPOINTS = ' + JSON.stringify(usageEndpoints) + ';\n' +
              'window.__AG_SKILL_PATHS = ' + JSON.stringify(skillPathMap) + ';\n' +
              'window.__AG_SKILLS = ' + JSON.stringify(skillCatalog) + ';\n' +
              'window.__AG_DEFAULT_PROMPTS = ' + JSON.stringify(defaultPrompts) + ';\n' +
              'window.__AG_SIDECAR_PORT = ' + JSON.stringify(sidecarPort) + ';\n' +
              'window.__AG_CONFIG = Object.assign({}, window.__AG_CONFIG || {}, ' + JSON.stringify(cfg) + ');\n' +
              'window.__AG_CONFIG__ = window.__AG_CONFIG;\n' +
              'document.documentElement.lang = ' + JSON.stringify(cfg.language || 'zh-CN') + ';\n' +
              applyConfigSource +
              'document.documentElement.classList.toggle("ag-prompt-sticky", ' + JSON.stringify(cfg.promptSticky === true) + ');\n' +
              'document.documentElement.dataset.agFont = ' + JSON.stringify(cfg.fontPreset || 'editorial-luxe') + ';\n' +
              'document.documentElement.style.setProperty("--ag-font-scale", String(' + JSON.stringify(Number(cfg.fontScale) || 1) + '));\n' +
              'window.__AG_STAR_CONFIG = ' + JSON.stringify({
                mode: cfg.starEffectMode || 'orbit-meteor',
                intensity: Number.isFinite(Number(cfg.starIntensity)) ? Number(cfg.starIntensity) : 0.85,
                frequency: Number.isFinite(Number(cfg.meteorFrequency)) ? Number(cfg.meteorFrequency) : 0.6
              }) + ';\n' +
              'if (typeof window.__agUpdatePromptSticky === "function") window.__agUpdatePromptSticky();\n' +
              enhanceScript + '\n;\n' + memoryScript + extraScripts +
              '\n;(function(){try{if(window.__agI18n&&window.__AG_CONFIG)window.__agI18n.setLanguage(window.__AG_CONFIG.language||"zh-CN");}catch(e){}})();\n';
            ws.send(JSON.stringify({
              id: 2,
              method: 'Runtime.evaluate',
              params: { expression, returnByValue: true }
            }));
            return;
          }

          if (response?.result?.exceptionDetails) {
            console.error('[Wallpaper] UI enhancement error:', response.result.exceptionDetails.text);
          }
          ws.close();
          console.log(`[Wallpaper] Applied Starlight Obsidian Glass theme to page: ${page.title || page.id}`);
        };

        ws.onerror = (err) => {
          console.error('[Wallpaper] WS error:', err.message);
        };
      });
    });
  }).on('error', (err) => {
    console.error('[Wallpaper] DevTools connection failed:', err.message);
  });
}

if (require.main === module) {
  const customImg = process.argv[2];
  const customOpacity = process.argv[3] ? parseFloat(process.argv[3]) : undefined;
  applyWallpaper({
    wallpaperPath: customImg,
    opacity: customOpacity
  });
}

module.exports = { applyWallpaper };
