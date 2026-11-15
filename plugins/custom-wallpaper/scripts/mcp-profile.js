#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.gemini', 'config');

const KNOWN_DOMAINS = [
  {
    id: 'mogu-script-manager',
    kind: 'mcp',
    label: 'AE 控制与脚本管理',
    toolsHint: '62 tools',
    weight: 'heavy',
    defaultOn: false,
  },
  {
    id: 'github',
    kind: 'plugin',
    label: 'GitHub 集成',
    toolsHint: '26 tools',
    weight: 'heavy',
    defaultOn: false,
  },
  {
    id: 'notion',
    kind: 'plugin',
    label: 'Notion 知识库',
    toolsHint: 'Notion MCP',
    weight: 'heavy',
    defaultOn: false,
  },
  {
    id: 'mogu-video-studio',
    kind: 'plugin',
    label: 'MOGU 视频工作台',
    toolsHint: '19 tools',
    weight: 'medium',
    defaultOn: false,
  },
  {
    id: 'computer-use',
    kind: 'plugin',
    label: '桌面控制 computer-use',
    toolsHint: '15 tools',
    weight: 'medium',
    defaultOn: false,
  },
  {
    id: 'antigravity-browser-bridge',
    kind: 'plugin',
    label: '浏览器控制与录制桥',
    toolsHint: '22 tools',
    weight: 'medium',
    defaultOn: true,
  },
  {
    id: 'antigravity-remote-mogu',
    kind: 'plugin',
    label: '手机远程消息桥',
    toolsHint: '3 tools',
    weight: 'light',
    defaultOn: false,
  },
  {
    id: 'android-cli-plugin',
    kind: 'plugin',
    label: 'Android CLI 插件',
    toolsHint: 'Android',
    weight: 'medium',
    defaultOn: false,
  },
];

const BUILTIN_PROFILES = {
  'coding-lean': {
    id: 'coding-lean',
    name: '极简省缓存模式',
    description: '关闭 AE / GitHub / Notion / 桌面 / 视频重型 Schema，首轮前缀最小化，缓存命中率最高',
    enable: ['antigravity-browser-bridge'],
    disable: [
      'mogu-script-manager',
      'github',
      'notion',
      'mogu-video-studio',
      'computer-use',
      'antigravity-remote-mogu',
      'android-cli-plugin',
    ],
  },
  'video-studio': {
    id: 'video-studio',
    name: '视频与动效创作模式',
    description: '挂载 MOGU 视频工作台、AE 脚本管理与浏览器桥，关闭无关 SaaS MCP',
    enable: ['mogu-video-studio', 'mogu-script-manager', 'antigravity-browser-bridge'],
    disable: ['github', 'notion', 'computer-use', 'antigravity-remote-mogu', 'android-cli-plugin'],
  },
  automation: {
    id: 'automation',
    name: '全端自动化模式',
    description: '挂载浏览器静默控制、桌面 UIA 控制与手机远程回传',
    enable: ['antigravity-browser-bridge', 'computer-use', 'antigravity-remote-mogu'],
    disable: ['mogu-script-manager', 'mogu-video-studio', 'github', 'notion', 'android-cli-plugin'],
  },
  full: {
    id: 'full',
    name: '全量兼容模式',
    description: '恢复启用全部已登记的 MCP 与扩展插件',
    enable: KNOWN_DOMAINS.map((d) => d.id),
    disable: [],
  },
};

function resolvePaths(configDir) {
  const root = path.resolve(configDir || process.env.ANTIGRAVITY_CONFIG_DIR || DEFAULT_CONFIG_DIR);
  return {
    root,
    configPath: path.join(root, 'config.json'),
    mcpConfigPath: path.join(root, 'mcp_config.json'),
    profilesPath: path.join(root, 'mcp_profiles.json'),
  };
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return JSON.parse(JSON.stringify(fallback));
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    if (!raw.trim()) return JSON.parse(JSON.stringify(fallback));
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : JSON.parse(JSON.stringify(fallback));
  } catch {
    return JSON.parse(JSON.stringify(fallback));
  }
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, filePath);
  } finally {
    if (fs.existsSync(tmp)) {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
}

function loadProfilesStore(paths) {
  const existing = readJsonSafe(paths.profilesPath, {});
  const parkedServers = existing.parkedServers && typeof existing.parkedServers === 'object'
    ? { ...existing.parkedServers }
    : {};
  const customProfiles = existing.profiles && typeof existing.profiles === 'object'
    ? existing.profiles
    : {};
  const mergedProfiles = { ...BUILTIN_PROFILES };
  for (const [k, v] of Object.entries(customProfiles)) {
    if (v && typeof v === 'object') {
      mergedProfiles[k] = {
        id: k,
        name: String(v.name || BUILTIN_PROFILES[k]?.name || k),
        description: String(v.description || BUILTIN_PROFILES[k]?.description || ''),
        enable: Array.isArray(v.enable) ? v.enable : (BUILTIN_PROFILES[k]?.enable || []),
        disable: Array.isArray(v.disable) ? v.disable : (BUILTIN_PROFILES[k]?.disable || []),
      };
    }
  }
  return {
    version: 1,
    activeProfile: typeof existing.activeProfile === 'string' ? existing.activeProfile : null,
    updatedAt: existing.updatedAt || null,
    parkedServers,
    profiles: mergedProfiles,
  };
}

function saveProfilesStore(paths, store) {
  writeJsonAtomic(paths.profilesPath, {
    version: 1,
    activeProfile: store.activeProfile || null,
    updatedAt: new Date().toISOString(),
    parkedServers: store.parkedServers || {},
    profiles: store.profiles || BUILTIN_PROFILES,
  });
}

function isDomainInstalledPlugin(configDir, domainId) {
  const pluginsDir = path.join(configDir, 'plugins');
  if (!fs.existsSync(pluginsDir)) return false;
  if (fs.existsSync(path.join(pluginsDir, domainId))) return true;
  try {
    for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pjPath = path.join(pluginsDir, entry.name, 'plugin.json');
      if (fs.existsSync(pjPath)) {
        const pj = readJsonSafe(pjPath, {});
        if (pj.name === domainId) return true;
      }
    }
  } catch {}
  return false;
}

function getStatus(configDir) {
  const paths = resolvePaths(configDir);
  const cfg = readJsonSafe(paths.configPath, { plugins: {} });
  const mcpCfg = readJsonSafe(paths.mcpConfigPath, { mcpServers: {} });
  const store = loadProfilesStore(paths);
  const pluginsMap = cfg.plugins && typeof cfg.plugins === 'object' ? cfg.plugins : {};
  const mcpServers = mcpCfg.mcpServers && typeof mcpCfg.mcpServers === 'object' ? mcpCfg.mcpServers : {};

  const domains = [];
  const seen = new Set();

  for (const def of KNOWN_DOMAINS) {
    seen.add(def.id);
    if (def.kind === 'mcp') {
      const active = Object.prototype.hasOwnProperty.call(mcpServers, def.id) && mcpServers[def.id]?.disabled !== true;
      const parked = Object.prototype.hasOwnProperty.call(store.parkedServers, def.id);
      domains.push({
        id: def.id,
        kind: 'mcp',
        label: def.label,
        toolsHint: def.toolsHint,
        weight: def.weight,
        present: active || parked,
        enabled: active,
      });
    } else {
      const entry = pluginsMap[def.id];
      const installed = Boolean(entry) || isDomainInstalledPlugin(paths.root, def.id);
      const enabled = entry ? entry.enabled !== false : installed;
      domains.push({
        id: def.id,
        kind: 'plugin',
        label: def.label,
        toolsHint: def.toolsHint,
        weight: def.weight,
        present: installed,
        enabled: installed ? enabled : false,
      });
    }
  }

  for (const serverName of [...Object.keys(mcpServers), ...Object.keys(store.parkedServers)]) {
    if (seen.has(serverName)) continue;
    seen.add(serverName);
    const active = Object.prototype.hasOwnProperty.call(mcpServers, serverName) && mcpServers[serverName]?.disabled !== true;
    domains.push({
      id: serverName,
      kind: 'mcp',
      label: serverName,
      toolsHint: 'custom MCP',
      weight: 'custom',
      present: true,
      enabled: active,
    });
  }

  const matchedProfile = Object.values(store.profiles).find((profile) => {
    const presentDomains = domains.filter((d) => d.present);
    const enSet = new Set(profile.enable || []);
    const disSet = new Set(profile.disable || []);
    return presentDomains.every((d) => {
      if (enSet.has(d.id)) return d.enabled === true;
      if (disSet.has(d.id)) return d.enabled === false;
      return true;
    });
  });

  return {
    ok: true,
    activeProfile: matchedProfile ? matchedProfile.id : (store.activeProfile || 'custom'),
    domains,
    profiles: Object.values(store.profiles),
    restartHint: '修改全局 MCP / 插件启停后，新会话或重载 Antigravity 生效',
  };
}

function setDomainEnabled(state, id, enabled) {
  const { cfg, mcpCfg, store, configDir } = state;
  if (!cfg.plugins || typeof cfg.plugins !== 'object') cfg.plugins = {};
  if (!mcpCfg.mcpServers || typeof mcpCfg.mcpServers !== 'object') mcpCfg.mcpServers = {};

  const known = KNOWN_DOMAINS.find((d) => d.id === id);
  const isMcpServer =
    known?.kind === 'mcp' ||
    Object.prototype.hasOwnProperty.call(mcpCfg.mcpServers, id) ||
    Object.prototype.hasOwnProperty.call(store.parkedServers, id);

  if (isMcpServer) {
    if (enabled) {
      if (!mcpCfg.mcpServers[id] && store.parkedServers[id]) {
        mcpCfg.mcpServers[id] = { ...store.parkedServers[id] };
        delete store.parkedServers[id];
      }
      if (mcpCfg.mcpServers[id] && Object.prototype.hasOwnProperty.call(mcpCfg.mcpServers[id], 'disabled')) {
        delete mcpCfg.mcpServers[id].disabled;
      }
      return { id, kind: 'mcp', changed: Boolean(mcpCfg.mcpServers[id]), enabled: Boolean(mcpCfg.mcpServers[id]) };
    }
    if (mcpCfg.mcpServers[id]) {
      store.parkedServers[id] = { ...mcpCfg.mcpServers[id] };
      delete mcpCfg.mcpServers[id];
      return { id, kind: 'mcp', changed: true, enabled: false };
    }
    return { id, kind: 'mcp', changed: false, enabled: false };
  }

  const installed = Boolean(cfg.plugins[id]) || isDomainInstalledPlugin(configDir, id);
  if (!installed && !enabled) {
    return { id, kind: 'plugin', changed: false, enabled: false };
  }
  const prev = cfg.plugins[id] && typeof cfg.plugins[id] === 'object' ? { ...cfg.plugins[id] } : {};
  const wasEnabled = prev.enabled !== false;
  if (!cfg.plugins[id] && !installed) {
    return { id, kind: 'plugin', changed: false, enabled: false };
  }
  cfg.plugins[id] = { ...prev, enabled: Boolean(enabled) };
  return { id, kind: 'plugin', changed: wasEnabled !== Boolean(enabled), enabled: Boolean(enabled) };
}

function toggleDomain(id, enabled, configDir) {
  const paths = resolvePaths(configDir);
  const cfg = readJsonSafe(paths.configPath, { plugins: {} });
  const mcpCfg = readJsonSafe(paths.mcpConfigPath, { mcpServers: {} });
  const store = loadProfilesStore(paths);

  const outcome = setDomainEnabled({ cfg, mcpCfg, store, configDir: paths.root }, id, Boolean(enabled));
  store.activeProfile = 'custom';
  writeJsonAtomic(paths.configPath, cfg);
  writeJsonAtomic(paths.mcpConfigPath, mcpCfg);
  saveProfilesStore(paths, store);
  return { ...getStatus(paths.root), toggled: outcome };
}

function applyProfile(profileId, configDir) {
  const paths = resolvePaths(configDir);
  const cfg = readJsonSafe(paths.configPath, { plugins: {} });
  const mcpCfg = readJsonSafe(paths.mcpConfigPath, { mcpServers: {} });
  const store = loadProfilesStore(paths);
  const profile = store.profiles[profileId];
  if (!profile) {
    throw new Error(`Unknown MCP profile: ${profileId}`);
  }

  const changes = [];
  for (const id of profile.enable || []) {
    changes.push(setDomainEnabled({ cfg, mcpCfg, store, configDir: paths.root }, id, true));
  }
  for (const id of profile.disable || []) {
    changes.push(setDomainEnabled({ cfg, mcpCfg, store, configDir: paths.root }, id, false));
  }
  store.activeProfile = profile.id;
  writeJsonAtomic(paths.configPath, cfg);
  writeJsonAtomic(paths.mcpConfigPath, mcpCfg);
  saveProfilesStore(paths, store);
  return { ...getStatus(paths.root), appliedProfile: profile.id, changes };
}

function parseCliArgs(argv) {
  const args = [];
  let configDir = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config-dir' && argv[i + 1]) {
      configDir = argv[++i];
    } else {
      args.push(argv[i]);
    }
  }
  return { args, configDir };
}

if (require.main === module) {
  try {
    const { args, configDir } = parseCliArgs(process.argv.slice(2));
    const cmd = args[0] || 'list';
    if (cmd === 'list' || cmd === 'status') {
      process.stdout.write(JSON.stringify(getStatus(configDir)) + '\n');
    } else if (cmd === 'apply') {
      if (!args[1]) throw new Error('Usage: mcp-profile.js apply <profile>');
      process.stdout.write(JSON.stringify(applyProfile(args[1], configDir)) + '\n');
    } else if (cmd === 'toggle') {
      if (!args[1] || !args[2]) throw new Error('Usage: mcp-profile.js toggle <domain> <on|off>');
      const enabled = args[2] === 'on' || args[2] === 'true' || args[2] === '1';
      process.stdout.write(JSON.stringify(toggleDomain(args[1], enabled, configDir)) + '\n');
    } else {
      throw new Error(`Unknown command: ${cmd}`);
    }
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message || String(error) }) + '\n');
    process.exitCode = 1;
  }
}

module.exports = {
  BUILTIN_PROFILES,
  KNOWN_DOMAINS,
  getStatus,
  applyProfile,
  toggleDomain,
};
