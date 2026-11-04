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

function restoreDefault() {
  const port = getDevToolsPort();
  if (!port) {
    console.error('[Wallpaper] DevToolsActivePort not found.');
    return;
  }

  http.get(`http://127.0.0.1:${port}/json`, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      let targets = JSON.parse(data);
      const pages = targets.filter(x => x.type === 'page');
      pages.forEach((page) => {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        ws.onopen = () => {
          const code = `
            (() => {
              try { window.__agUiDispose?.(); } catch (error) {}
              try { window.__agMemoryDispose?.(); } catch (error) {}
              try { window.__agTelemetryDispose?.(); } catch (error) {}
              try { window.__agResourceActionsDispose?.(); } catch (error) {}
              const ids = [
                'antigravity-custom-bg-layer',
                'antigravity-custom-bg-style',
                'antigravity-cursor-particles',
                'ag-usage-panel',
                'ag-sidebar-handle',
                'ag-chat-minimap',
                'ag-minimap-preview',
                'ag-sidebar-stars',
                'ag-global-stars',
                'ag-star-cosmos',
                'ag-quest-banner',
                'ag-immersive-toggle',
                'ag-effort-pill',
                'ag-ui-toast',
                'ag-memory-page',
                'ag-telemetry-bar',
                'ag-task-bar',
                'ag-quick-goal',
                'ag-ambient-clock',
                'ag-telemetry-popover',
                'ag-telemetry-toast',
                'ag-telemetry-style',
                'ag-resource-actions-style',
                'ag-resource-actions-toast'
              ];
              ids.forEach((id) => document.getElementById(id)?.remove());
              document.querySelectorAll('.ag-plugin-panel, .ag-plugin-trigger, .ag-prompt-trigger, .ag-model-effort, .ag-message-action, .ag-conversation-download-button, .ag-skill-folder, .ag-skill-star, .ag-plugin-tabs, .ag-memory-nav').forEach((node) => node.remove());
              document.querySelectorAll('.ag-skill-card, .ag-skill-grid').forEach((node) => {
                node.classList.remove('ag-skill-card', 'ag-skill-grid');
              });
              document.documentElement.classList.remove('ag-immersive', 'ag-immersive-awake', 'ag-customizations-page', 'ag-attachment-reordering', 'ag-prompt-sticky', 'ag-stars-off', 'ag-memory-open', 'ag-project-animating');
              document.querySelectorAll('.ag-project-row-enter, .ag-project-row-exit').forEach((node) => {
                node.classList.remove('ag-project-row-enter', 'ag-project-row-exit');
              });
              document.body.classList.remove('ag-customizations-page');
              document.querySelectorAll('.ag-prompt-stuck').forEach((node) => {
                node.classList.remove('ag-prompt-stuck');
                node.removeAttribute('data-ag-prompt-preview');
              });
              return 'Restored default';
            })()
          `;
          ws.send(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression: code, returnByValue: true }
          }));
        };
        ws.onmessage = () => {
          ws.close();
          console.log('[Wallpaper] Restored default theme.');
        };
      });
    });
  });
}

if (require.main === module) {
  restoreDefault();
}

module.exports = { restoreDefault };
