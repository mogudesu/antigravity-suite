const fs = require('fs');
const http = require('http');
const path = require('path');
const readline = require('readline');

function getDevToolsPort() {
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  const portFile = path.join(appData, 'Antigravity', 'DevToolsActivePort');
  try {
    const lines = fs.readFileSync(portFile, 'utf8').trim().split('\n');
    const port = parseInt(lines[0].trim(), 10);
    return Number.isInteger(port) ? port : null;
  } catch (error) {
    return null;
  }
}

function fetchTargets(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/json', timeout: 1500 }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

let socket = null;
let connecting = null;
let lastAttempt = 0;
let messageId = 0;

async function connect() {
  if (socket && socket.readyState === WebSocket.OPEN) return socket;
  if (connecting) return connecting;
  const now = Date.now();
  if (now - lastAttempt < 700) return null;
  lastAttempt = now;

  connecting = (async () => {
    const port = getDevToolsPort();
    if (!port) return null;
    const targets = await fetchTargets(port);
    const page = (targets || []).find((target) =>
      target.type === 'page' && /^https:\/\//.test(target.url || '') && !String(target.url).startsWith('plugin://')
    );
    if (!page) return null;

    await new Promise((resolve) => {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      const timer = setTimeout(() => {
        try { ws.close(); } catch (error) {}
        resolve(null);
      }, 2500);
      ws.onopen = () => {
        clearTimeout(timer);
        socket = ws;
        resolve(ws);
      };
      ws.onclose = () => {
        clearTimeout(timer);
        if (socket === ws) socket = null;
        resolve(null);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        if (socket === ws) socket = null;
        resolve(null);
      };
      ws.onmessage = () => {};
    });

    return socket;
  })();

  try {
    return await connecting;
  } catch (error) {
    return null;
  } finally {
    connecting = null;
  }
}

function buildExpression(payload) {
  return `(() => {
    const p = ${JSON.stringify(payload)};
    const style = document.documentElement.style;
    const num = (value) => typeof value === 'number' && Number.isFinite(value);
    if (p && typeof p === 'object') {
      window.__AG_CONFIG = Object.assign({}, window.__AG_CONFIG || {}, p);
      if (p.language) {
        document.documentElement.lang = p.language;
        try { window.__agI18n?.setLanguage?.(p.language); } catch (error) {}
      }
      if (p.cursorParticles === false) {
        const trail = document.getElementById('antigravity-cursor-particles');
        if (trail) trail.remove();
      }
      document.dispatchEvent(new CustomEvent('ag-config-updated', { detail: p }));
    }
    if (num(p.opacity)) style.setProperty('--ag-wp-opacity', String(Math.max(0, Math.min(1, p.opacity))));
    if (num(p.darkTint)) style.setProperty('--ag-wp-tint', String(Math.max(0, Math.min(0.95, p.darkTint))));
    if (num(p.blur)) style.setProperty('--ag-glass-blur', Math.max(0, Math.min(60, p.blur)) + 'px');
    if (num(p.focusX)) style.setProperty('--ag-focus-x', Math.max(0, Math.min(100, p.focusX)) + '%');
    if (num(p.focusY)) style.setProperty('--ag-focus-y', Math.max(0, Math.min(100, p.focusY)) + '%');
    const hex = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
    if (p.palette && typeof p.palette === 'object') {
      const accent = hex(p.palette.accent);
      const highlight = hex(p.palette.highlight);
      const cool = hex(p.palette.cool);
      const dark = hex(p.palette.dark);
      if (accent) style.setProperty('--ag-accent-cool', accent);
      if (highlight) style.setProperty('--ag-accent-alt', highlight);
      if (cool) style.setProperty('--ag-accent-tertiary', cool);
      if (dark) style.setProperty('--ag-palette-dark', dark);
    }
    if (typeof p.promptSticky === 'boolean') {
      document.documentElement.classList.toggle('ag-prompt-sticky', p.promptSticky);
      if (typeof window.__agUpdatePromptSticky === 'function') window.__agUpdatePromptSticky();
    }
    if (p.fontPreset && ['editorial-luxe', 'modern-silk', 'literary-serif', 'starry-game'].includes(p.fontPreset)) {
      document.documentElement.dataset.agFont = p.fontPreset;
    }
    if (num(p.fontScale)) style.setProperty('--ag-font-scale', String(Math.max(0.85, Math.min(1.15, p.fontScale))));
    if (p.starEffectMode || num(p.starIntensity) || num(p.meteorFrequency)) {
      window.__AG_STAR_CONFIG = Object.assign({}, window.__AG_STAR_CONFIG || {}, {
        mode: p.starEffectMode || (window.__AG_STAR_CONFIG || {}).mode,
        intensity: num(p.starIntensity) ? Math.max(0, Math.min(1, p.starIntensity)) : (window.__AG_STAR_CONFIG || {}).intensity,
        frequency: num(p.meteorFrequency) ? Math.max(0, Math.min(1, p.meteorFrequency)) : (window.__AG_STAR_CONFIG || {}).frequency
      });
      if (typeof window.__agUpdateStarCosmos === 'function') window.__agUpdateStarCosmos();
    }
    return true;
  })()`;
}

async function applyPayload(payload) {
  const ws = await connect();
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  messageId += 1;
  ws.send(JSON.stringify({
    id: messageId,
    method: 'Runtime.evaluate',
    params: { expression: buildExpression(payload), returnByValue: true }
  }));
  return true;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    return;
  }
  applyPayload(payload).catch(() => {});
});

rl.on('close', () => process.exit(0));
