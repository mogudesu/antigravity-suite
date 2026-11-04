#!/usr/bin/env node
/**
 * Local structural validation, mirroring the checklist Antigravity applies with
 * `agy plugin validate --strict`: manifest schema, skill frontmatter and folder
 * names, rule trigger modes, MCP server shape, hook shape and referenced files.
 *
 *   node scripts/validate.mjs ./mnemon            # report errors and warnings
 *   node scripts/validate.mjs --strict ./mnemon   # warnings become errors
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const target = path.resolve(argv.find((a) => !a.startsWith('--')) || '.');

const findings = [];
const error = (code, message) => findings.push({ level: 'error', code, message });
const warn = (code, message) => findings.push({ level: 'warn', code, message });

const readJSONFile = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    error('json', `${path.relative(target, file)} is not valid JSON: ${e.message}`);
    return null;
  }
};

const MANIFEST_KEYS = new Set(['$schema', 'name', 'displayName', 'display_name', 'description', 'version', 'disabled', 'logo', 'suggestedPrompts', 'suggested_prompts', 'skills', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions', 'source', 'sourcePath', 'source_path']);
const RESERVED_PREFIXES = ['antigravity', 'gemini', 'claude', 'cursor'];
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LOGO_EXT = /\.(png|svg|jpe?g|webp)$/i;
const RULE_TRIGGERS = new Set(['always_on', 'model_decision', 'glob', 'manual']);
const AGENT_MODELS = new Set(['inherit', 'flash_lite', 'flash', 'pro']);
const HOOK_EVENTS = new Set(['SessionStart', 'PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop']);
const MATCHED_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

function parseFrontmatter(raw) {
  const text = String(raw || '');
  if (!text.startsWith('---')) return { meta: {}, body: text, present: false };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: text, present: false };
  const head = text.slice(3, end);
  const body = text.slice(end + 4);
  const meta = {};
  let currentKey = null;
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyMatch) {
      currentKey = keyMatch[1];
      const rawValue = keyMatch[2].trim();
      if (rawValue === '' || rawValue === '>-' || rawValue === '>' || rawValue === '|') meta[currentKey] = '';
      else meta[currentKey] = rawValue.replace(/^["']|["']$/g, '');
    } else if (currentKey) {
      meta[currentKey] = `${meta[currentKey] ? `${meta[currentKey]} ` : ''}${line.trim()}`;
    }
  }
  return { meta, body, present: true };
}

// ------------------------------------------------------------------ manifest
const manifestPath = fs.existsSync(path.join(target, 'plugin.json'))
  ? path.join(target, 'plugin.json')
  : path.join(target, '.antigravity-plugin', 'plugin.json');
if (!fs.existsSync(manifestPath)) {
  error('manifest', 'plugin.json is missing (looked in <root>/plugin.json and <root>/.antigravity-plugin/plugin.json)');
}
const manifest = fs.existsSync(manifestPath) ? readJSONFile(manifestPath) : null;
if (manifest) {
  for (const key of Object.keys(manifest)) if (!MANIFEST_KEYS.has(key)) warn('manifest.key', `unknown manifest key "${key}" (Antigravity ignores it and reports it)`);
  if (typeof manifest.name !== 'string' || !manifest.name) error('manifest.name', 'name is required');
  else {
    if (!KEBAB.test(manifest.name)) error('manifest.name', `name "${manifest.name}" must be lowercase kebab-case (^[a-z0-9]+(-[a-z0-9]+)*$)`);
    const lower = manifest.name.toLowerCase();
    for (const prefix of RESERVED_PREFIXES) if (lower.startsWith(prefix)) warn('manifest.name', `name must not lead with the reserved vendor word "${prefix}"`);
  }
  for (const key of ['displayName', 'description', 'version', 'license']) {
    if (manifest[key] !== undefined && typeof manifest[key] !== 'string') error('manifest.type', `${key} must be a string`);
  }
  if (manifest.disabled !== undefined && typeof manifest.disabled !== 'boolean') error('manifest.type', 'disabled must be a boolean');
  if (manifest.suggestedPrompts !== undefined) {
    if (!Array.isArray(manifest.suggestedPrompts)) error('manifest.type', 'suggestedPrompts must be an array');
    else {
      if (manifest.suggestedPrompts.length > 3) error('manifest.prompts', 'suggestedPrompts holds at most 3 prompts');
      if (manifest.suggestedPrompts.some((p) => typeof p !== 'string' || !p.trim())) error('manifest.prompts', 'suggestedPrompts entries must be non-empty strings');
    }
  }
  if (manifest.logo !== undefined) {
    if (typeof manifest.logo !== 'string') error('manifest.type', 'logo must be a string');
    else if (/^https:\/\//.test(manifest.logo)) {
      if (!/^https:\/\/([A-Za-z0-9-]+\.)*(google\.com|gstatic\.com|googleusercontent\.com)/.test(manifest.logo)) warn('manifest.logo', 'remote logos are only read from google.com, gstatic.com and googleusercontent.com');
    } else if (!LOGO_EXT.test(manifest.logo)) error('manifest.logo', 'logo must point to a .png, .svg, .jpg, .jpeg or .webp file');
    else if (!fs.existsSync(path.join(target, manifest.logo))) error('manifest.logo', `logo file not found: ${manifest.logo}`);
  }
  if (manifest.author !== undefined && typeof manifest.author !== 'string' && (typeof manifest.author !== 'object' || manifest.author === null)) error('manifest.type', 'author must be a string or an object');
  if (!fs.existsSync(path.join(target, 'README.md'))) warn('readme', 'README.md is missing: the Marketplace detail page shows it before installation');
}

// -------------------------------------------------------------------- skills
const skillsDir = path.join(target, 'skills');
if (fs.existsSync(skillsDir)) {
  const dirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  if (!dirs.length) warn('skills', 'skills/ exists but contains no skill folder');
  for (const dir of dirs) {
    const file = path.join(skillsDir, dir, 'SKILL.md');
    if (!fs.existsSync(file)) {
      error('skills', `skills/${dir}/SKILL.md is missing`);
      continue;
    }
    const { meta } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    if (!meta.name) error('skills.frontmatter', `skills/${dir}/SKILL.md needs a name`);
    else if (meta.name !== dir) error('skills.name', `skill name "${meta.name}" must match its folder name "${dir}"`);
    else if (!KEBAB.test(meta.name) || meta.name.length > 64) error('skills.name', `skill name "${meta.name}" must be lowercase kebab-case, 1-64 characters`);
    if (!meta.description) error('skills.frontmatter', `skills/${dir}/SKILL.md needs a description (what it does and when to trigger)`);
    else if (meta.description.length > 1024) error('skills.frontmatter', `skills/${dir} description is ${meta.description.length} characters (max 1024)`);
    for (const key of Object.keys(meta)) if (!['name', 'description', 'disable-model-invocation', 'license', 'compatibility'].includes(key)) warn('skills.frontmatter', `skills/${dir}/SKILL.md has an unknown frontmatter key "${key}"`);
  }
} else {
  warn('skills', 'no skills/ directory');
}

// -------------------------------------------------------------------- agents
const agentsDir = path.join(target, 'agents');
if (fs.existsSync(agentsDir)) {
  for (const name of fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'))) {
    const { meta } = parseFrontmatter(fs.readFileSync(path.join(agentsDir, name), 'utf8'));
    if (!meta.name) error('agents', `agents/${name} needs a name`);
    else if (!KEBAB.test(meta.name)) error('agents', `agents/${name} name "${meta.name}" must be kebab-case`);
    if (!meta.description) error('agents', `agents/${name} needs a description`);
    for (const key of ['mainAgent', 'subagent', 'inheritMcp', 'inheritCustomizations']) {
      if (meta[key] !== undefined && !['true', 'false'].includes(String(meta[key]))) error('agents', `agents/${name} ${key} must be true or false`);
    }
    if (meta.model !== undefined && !AGENT_MODELS.has(String(meta.model))) error('agents', `agents/${name} model "${meta.model}" must be one of ${[...AGENT_MODELS].join(', ')}`);
  }
}

// --------------------------------------------------------------------- rules
const rulesDir = path.join(target, 'rules');
if (fs.existsSync(rulesDir)) {
  const files = fs.readdirSync(rulesDir).filter((f) => f.endsWith('.md'));
  for (const name of files) {
    const { meta, present } = parseFrontmatter(fs.readFileSync(path.join(rulesDir, name), 'utf8'));
    const alwaysOnFile = name === 'AGENTS.md' || name === 'GEMINI.md';
    if (alwaysOnFile && !present) continue;
    if (!meta.trigger) {
      error('rules', `rules/${name} needs a trigger (always_on, model_decision, glob or manual)`);
      continue;
    }
    if (!RULE_TRIGGERS.has(String(meta.trigger))) error('rules', `rules/${name} trigger "${meta.trigger}" is not one of ${[...RULE_TRIGGERS].join(', ')}`);
    if (String(meta.trigger) === 'glob' && typeof meta.globs !== 'string') error('rules', `rules/${name} globs must be a comma-separated string, not a list`);
    if (String(meta.trigger) === 'model_decision' && !meta.description) error('rules', `rules/${name} needs a description so the agent can decide when to load it`);
  }
} else {
  warn('rules', 'no rules/ directory');
}

// -------------------------------------------------------------- mcp config
const mcpCandidates = ['mcp_config.json', 'mcp.json'];
const mcpPath = mcpCandidates.map((name) => path.join(target, name)).find((file) => fs.existsSync(file)) || null;
if (mcpPath) {
  const mcp = readJSONFile(mcpPath);
  const label = path.basename(mcpPath);
  if (mcp) {
    if (mcp.variables) error('mcp', 'variables must be declared inside mcpServers.<server>.variables, not at the root');
    if (!mcp.mcpServers || typeof mcp.mcpServers !== 'object') error('mcp', `${label} needs an mcpServers object`);
    else {
      for (const [key, server] of Object.entries(mcp.mcpServers)) {
        if (!server || typeof server !== 'object') {
          error('mcp', `mcpServers.${key} must be an object`);
          continue;
        }
        const remote = typeof server.url === 'string' || typeof server.serverUrl === 'string';
        const local = typeof server.command === 'string';
        if (!remote && !local) error('mcp', `mcpServers.${key} needs either url/serverUrl (remote) or command (local stdio)`);
        if (local && server.args !== undefined && !Array.isArray(server.args)) error('mcp', `mcpServers.${key}.args must be an array`);
        if (server.env && typeof server.env === 'object') {
          for (const envKey of Object.keys(server.env)) {
            if (envKey === 'PLUGIN_ROOT' || envKey === 'PLUGIN_DATA') warn('mcp', `mcpServers.${key}.env must not redefine ${envKey}: Antigravity exports it automatically`);
          }
        }
        if (server.variables !== undefined && !Array.isArray(server.variables)) error('mcp', `mcpServers.${key}.variables must be an array`);
        if (local && Array.isArray(server.args)) {
          for (const arg of server.args) {
            const raw = String(arg);
            const match = raw.match(/^\$\{PLUGIN_ROOT\}\/(.+)$/);
            if (match && !fs.existsSync(path.join(target, match[1]))) error('mcp', `mcpServers.${key} references a missing file: ${match[1]}`);
            if (/\.(mjs|js|cjs)$/.test(raw) && path.isAbsolute(raw) && !fs.existsSync(raw)) error('mcp', `mcpServers.${key} references a missing file: ${raw}`);
          }
          for (const flag of ['--data-dir', '--mirror-dir']) {
            const i = server.args.indexOf(flag);
            const inline = server.args.find((a) => String(a).startsWith(`${flag}=`));
            const value = i !== -1 ? server.args[i + 1] : inline ? String(inline).slice(flag.length + 1) : null;
            if (value && !path.isAbsolute(String(value))) warn('mcp', `mcpServers.${key} ${flag} should be an absolute path: ${value}`);
          }
        }
      }
    }
  }
} else {
  warn('mcp', 'no mcp_config.json (or legacy mcp.json): the plugin ships no MCP tools');
}

// ----------------------------------------------------------------- hooks.json
const hooksPath = path.join(target, 'hooks.json');
if (fs.existsSync(hooksPath)) {
  const hooks = readJSONFile(hooksPath);
  if (hooks) {
    for (const [groupName, group] of Object.entries(hooks)) {
      if (!group || typeof group !== 'object') {
        error('hooks', `${groupName} must be an object mapping lifecycle events to handlers`);
        continue;
      }
      if (group.enabled !== undefined && typeof group.enabled !== 'boolean') error('hooks', `${groupName}.enabled must be a boolean`);
      for (const [event, handlers] of Object.entries(group)) {
        if (event === 'enabled') continue;
        if (!HOOK_EVENTS.has(event)) {
          warn('hooks', `${groupName}.${event} is not a known lifecycle event`);
          continue;
        }
        if (!Array.isArray(handlers)) {
          error('hooks', `${groupName}.${event} must be an array`);
          continue;
        }
        const flat = handlers;
        for (const entry of flat) {
          if (!entry || typeof entry !== 'object') {
            error('hooks', `${groupName}.${event} entries must be objects`);
            continue;
          }
          if (MATCHED_EVENTS.has(event)) {
            if (typeof entry.matcher !== 'string') error('hooks', `${groupName}.${event} entries need a matcher regex`);
            if (!Array.isArray(entry.hooks)) {
              error('hooks', `${groupName}.${event} entries must wrap handlers in a "hooks" array`);
              continue;
            }
            for (const handler of entry.hooks) checkHandler(groupName, event, handler);
          } else {
            if (entry.matcher !== undefined) error('hooks', `${groupName}.${event} takes a flat handler array and no matcher`);
            if (entry.hooks !== undefined) error('hooks', `${groupName}.${event} must not wrap handlers in a "hooks" array`);
            checkHandler(groupName, event, entry);
          }
        }
      }
    }
  }
} else {
  warn('hooks', 'no hooks.json: the plugin runs no lifecycle hooks');
}

function checkHandler(groupName, event, handler) {
  if (!handler || typeof handler !== 'object') {
    error('hooks', `${groupName}.${event} handler must be an object`);
    return;
  }
  if (handler.type !== 'command') error('hooks', `${groupName}.${event} handler type must be "command"`);
  if (typeof handler.command !== 'string' || !handler.command.trim()) {
    error('hooks', `${groupName}.${event} handler needs a command`);
    return;
  }
  if (handler.command.includes('${PLUGIN_ROOT}')) warn('hooks', `${groupName}.${event} should use a relative path (./scripts/...) instead of \${PLUGIN_ROOT}`);
  // Commands may quote paths that contain spaces (e.g. "C:\Program Files\nodejs\node.exe").
  const tokens = (handler.command.match(/"[^"]+"|'[^']+'|\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, ''));
  const exe = tokens[0];
  if (exe && path.isAbsolute(exe) && !fs.existsSync(exe)) error('hooks', `${groupName}.${event} command points at a missing executable: ${exe}`);
  const script = tokens.find((token) => /\.(mjs|js|cjs)$/.test(token));
  if (script) {
    const file = path.isAbsolute(script) ? script : path.join(target, script.replace(/^\.\//, ''));
    if (!fs.existsSync(file)) error('hooks', `${groupName}.${event} references a missing script: ${file}`);
  }
}

// -------------------------------------------------------------------- report
const errors = findings.filter((f) => f.level === 'error');
const warnings = findings.filter((f) => f.level === 'warn');
const label = path.basename(target);
process.stdout.write(`mnemon validate${strict ? ' --strict' : ''}: ${label}\n`);
for (const finding of findings) process.stdout.write(`  ${finding.level === 'error' ? 'ERROR' : 'warn '} [${finding.code}] ${finding.message}\n`);
if (!findings.length) process.stdout.write('  no findings\n');
process.stdout.write(`\n${errors.length} error(s), ${warnings.length} warning(s)\n`);
if (errors.length || (strict && warnings.length)) process.exit(1);
