#!/usr/bin/env node
/* Startup injector for Antigravity updates/restarts. */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const APPLY_JS = path.join(__dirname, 'apply.js');
const PORT_FILE = path.join(process.env.APPDATA || '', 'Antigravity', 'DevToolsActivePort');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPort() {
  try {
    return fs.readFileSync(PORT_FILE, 'utf8').split(/\r?\n/)[0].trim();
  } catch (error) {
    return '';
  }
}

function isEnabled() {
  try {
    const configPath = path.join(PLUGIN_ROOT, 'config', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config.enabled !== false;
  } catch (error) {
    return true;
  }
}

function fetchTargets(port) {
  return new Promise((resolve) => {
    const request = http.get('http://127.0.0.1:' + port + '/json', (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          resolve([]);
        }
      });
    });
    request.on('error', () => resolve([]));
    request.setTimeout(2500, () => {
      request.destroy();
      resolve([]);
    });
  });
}

function evaluate(wsUrl, expression) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let socket;
    try {
      socket = new WebSocket(wsUrl);
    } catch (error) {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      try { socket.close(); } catch (error) {}
      finish(null);
    }, 4000);
    socket.onopen = () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true }
      }));
    };
    socket.onmessage = (event) => {
      clearTimeout(timer);
      try {
        const message = JSON.parse(event.data);
        const value = message?.result?.result?.value;
        socket.close();
        finish(value === undefined ? null : value);
      } catch (error) {
        socket.close();
        finish(null);
      }
    };
    socket.onerror = () => {
      clearTimeout(timer);
      finish(null);
    };
  });
}

async function inspectPage() {
  const port = readPort();
  if (!port) return null;
  const targets = await fetchTargets(port);
  const page = (Array.isArray(targets) ? targets : []).find((target) =>
    target.type === 'page' && /^https:\/\/127\.0\.0\.1:\d+\//.test(target.url || '')
  );
  if (!page || !page.webSocketDebuggerUrl) return null;
  const state = await evaluate(page.webSocketDebuggerUrl, `(() => ({
    ready: !!document.querySelector('.agy-shell') && !!document.querySelector('[data-testid="settings-button"]'),
    ui: !!window.__agExtendedUiInstalled,
    style: !!document.getElementById('antigravity-custom-bg-style')
  }))()`);
  return state;
}

async function main() {
  if (!isEnabled()) process.exit(0);
  for (let attempt = 0; attempt < 18; attempt += 1) {
    const state = await inspectPage();
    if (state && state.ready) {
      if (state.ui && state.style) process.exit(0);
      spawnSync(process.execPath, [APPLY_JS], {
        cwd: PLUGIN_ROOT,
        stdio: 'ignore',
        timeout: 20000
      });
      await sleep(1200);
      const after = await inspectPage();
      if (after && after.ui && after.style) process.exit(0);
    }
    await sleep(2000);
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
