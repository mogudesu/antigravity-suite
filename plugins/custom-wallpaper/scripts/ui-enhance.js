(() => {
  'use strict';

  const UI_VERSION = '5.0.0';
  // 同一页面只允许一套实例：重复注入会叠加捕获监听器，面板会一开一合。
  // 热更新代码请刷新页面，而不是换版本重新注入。
  if (window.__agExtendedUiInstalled) {
    window.__agUiDisabled = false;
    if (window.__agExtendedUiRefresh) window.__agExtendedUiRefresh();
    return;
  }
  window.__agExtendedUiInstalled = true;
  window.__agExtendedUiVersion = UI_VERSION;
  window.__agUiDisabled = false;

  const PLUGINS = Array.isArray(window.__AG_INSTALLED_PLUGINS) ? window.__AG_INSTALLED_PLUGINS : [];
  const USAGE_ENDPOINTS = Array.isArray(window.__AG_USAGE_ENDPOINTS) ? window.__AG_USAGE_ENDPOINTS : [];
  const EFFORTS = ['Low', 'Medium', 'High'];
  const EFFORT_LABELS = { Low: '低', Medium: '中', High: '高' };
  const MODEL_COLORS = {
    'gemini-4-argon': '#A5B4FC',
    'gemini-3.8-flash': '#7DD3FC',
    'claude-opus-5-5': '#FCD34D',
    'claude-sonnet-5-5': '#F0ABFC'
  };
  const PLUGIN_COLORS = ['#A5B4FC', '#7DD3FC', '#FCD34D', '#F0ABFC', '#6EE7B7', '#FCA5A5'];
  const SKILLS = Array.isArray(window.__AG_SKILLS) ? window.__AG_SKILLS : [];
  const SIDECAR = 'http://127.0.0.1:' + (window.__AG_SIDECAR_PORT || 39290);
  const DECK_FAVORITES_KEY = 'ag-deck-favorites-v1';

  const usageState = {
    loading: false,
    data: null,
    error: null,
    lastFetch: 0
  };
  let usageMode = localStorage.getItem('ag-usage-mode') === 'ring' ? 'ring' : 'detail';
  const SHOW_USAGE_PANEL = true;
  let scanTimer = 0;
  let scanCount = 0;
  let pluginPanelBound = false;

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function getComposer() {
    return document.getElementById('antigravity.agentSidePanelInputBox');
  }

  function getModelTrigger() {
    return document.querySelector('[data-testid="model-selector-trigger"]');
  }

  function getVisibleMenus() {
    return Array.from(document.querySelectorAll('[role="menu"]')).filter((menu) => {
      const rect = menu.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  }

  function closeModelMenu() {
    const menus = getVisibleMenus().filter((menu) => menu.querySelector('[data-testid="model-selector-panel"]'));
    if (!menus.length) return;
    const options = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
    menus.forEach((menu) => {
      const item = menu.querySelector('[role="menuitem"]');
      try { item?.focus({ preventScroll: true }); } catch (error) {}
      menu.dispatchEvent(new KeyboardEvent('keydown', options));
      item?.dispatchEvent(new KeyboardEvent('keydown', options));
    });
    document.dispatchEvent(new KeyboardEvent('keydown', options));
  }

  function insertComposerText(text) {
    const composer = getComposer();
    const editor = composer ? composer.querySelector('[contenteditable="true"]') : null;
    if (!editor) return false;

    const lexical = editor.__lexicalEditor;
    if (lexical && lexical._nodes && typeof lexical.update === 'function') {
      try {
        const TextNode = lexical._nodes.get('text')?.klass;
        const ParagraphNode = lexical._nodes.get('paragraph')?.klass;
        const LineBreakNode = lexical._nodes.get('linebreak')?.klass;
        if (TextNode && ParagraphNode) {
          lexical.update(() => {
            const root = lexical._pendingEditorState._nodeMap.get('root');
            if (!root) return;
            const paragraph = new ParagraphNode();
            String(text).split('\n').forEach((line, index) => {
              if (index > 0 && LineBreakNode) paragraph.append(new LineBreakNode());
              if (line) paragraph.append(new TextNode(line));
            });
            root.append(paragraph);
            if (typeof root.selectEnd === 'function') root.selectEnd();
          }, { tag: 'ag-plugin-insert' });
          lexical.focus();
          try {
            editor.dispatchEvent(new Event('input', { bubbles: true }));
          } catch (error) {}
          return true;
        }
      } catch (error) {
        console.warn('[Wallpaper] Lexical insert failed, using fallback:', error);
      }
    }

    editor.focus();
    try {
      const transfer = new DataTransfer();
      transfer.setData('text/plain', text);
      editor.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer
      }));
      return true;
    } catch (error) {
      console.warn('[Wallpaper] Failed to insert prompt:', error);
      return false;
    }
  }

  function replaceComposerText(text) {
    const composer = getComposer();
    const editor = composer ? composer.querySelector('[contenteditable="true"]') : null;
    if (!editor) return false;

    editor.focus();
    try { editor.click(); } catch (error) {}
    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      if (document.execCommand('insertText', false, String(text))) {
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
    } catch (error) {}

    const lexical = editor.__lexicalEditor;
    if (lexical && lexical._nodes && typeof lexical.update === 'function') {
      try {
        const TextNode = lexical._nodes.get('text')?.klass;
        const ParagraphNode = lexical._nodes.get('paragraph')?.klass;
        const LineBreakNode = lexical._nodes.get('linebreak')?.klass;
        if (TextNode && ParagraphNode) {
          lexical.update(() => {
            const root = lexical._pendingEditorState._nodeMap.get('root');
            if (!root) return;
            if (typeof root.clear === 'function') root.clear();
            else if (typeof root.getChildren === 'function') root.getChildren().forEach((child) => child.remove());
            const paragraph = new ParagraphNode();
            String(text).split('\n').forEach((line, index) => {
              if (index > 0 && LineBreakNode) paragraph.append(new LineBreakNode());
              if (line) paragraph.append(new TextNode(line));
            });
            root.append(paragraph);
            if (typeof root.selectEnd === 'function') root.selectEnd();
          }, { tag: 'ag-retry-insert' });
          lexical.focus();
          try {
            editor.dispatchEvent(new Event('input', { bubbles: true }));
          } catch (error) {}
          return true;
        }
      } catch (error) {
        console.warn('[Wallpaper] Lexical replace failed, using fallback:', error);
      }
    }

    editor.focus();
    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    } catch (error) {}
    return insertComposerText(text);
  }

  function modelBaseFromTrigger() {
    const trigger = getModelTrigger();
    if (!trigger) return null;
    const aria = trigger.getAttribute('aria-label') || '';
    const label = (aria.split('current:')[1] || trigger.innerText || '').trim();
    const effort = EFFORTS.find((item) => label.endsWith(' ' + item));
    if (!effort) return null;
    return {
      label,
      base: label.slice(0, -(effort.length + 1)).trim(),
      effort,
      index: EFFORTS.indexOf(effort)
    };
  }

  async function applyEffort(level, base) {
    const menu = getVisibleMenus().find((node) => node.querySelector('[data-testid="model-selector-panel"]'));
    if (!menu) return false;

    const row = Array.from(menu.querySelectorAll('[data-testid="model-selector-effort-group"]'))
      .find((node) => node.dataset.modelBase === base)
      ?.closest('[role="menuitem"]');
    if (!row) return false;

    const rect = row.getBoundingClientRect();
    const pointerOptions = {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      pointerId: 1,
      pointerType: 'mouse'
    };
    row.dispatchEvent(new PointerEvent('pointerenter', Object.assign({}, pointerOptions, { bubbles: false })));
    row.dispatchEvent(new PointerEvent('pointerover', pointerOptions));
    row.dispatchEvent(new PointerEvent('pointermove', pointerOptions));
    row.dispatchEvent(new MouseEvent('mouseenter', Object.assign({}, pointerOptions, { bubbles: false })));
    row.dispatchEvent(new MouseEvent('mouseover', pointerOptions));
    row.dispatchEvent(new MouseEvent('mousemove', pointerOptions));
    await new Promise((resolve) => setTimeout(resolve, 180));

    row.focus();
    if (row.getAttribute('aria-expanded') !== 'true') {
      row.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        code: 'ArrowRight',
        bubbles: true,
        cancelable: true
      }));
    }

    let submenu = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const controls = row.getAttribute('aria-controls');
      if (controls) {
        const candidate = document.getElementById(controls);
        if (candidate && candidate !== menu) {
          submenu = candidate;
          break;
        }
      }
    }

    if (!submenu) {
      submenu = getVisibleMenus().find((node) => {
        if (node === menu) return false;
        return Array.from(node.querySelectorAll('[role="menuitem"], [role="menuitemradio"]'))
          .some((item) => (item.textContent || '').trim() === level);
      }) || Array.from(document.querySelectorAll('[role="menu"]')).find((node) => {
        if (node === menu) return false;
        return !!node.querySelector('[data-testid="model-selector-effort-option"]');
      });
    }
    if (!submenu) return false;
    submenu.classList.add('ag-effort-submenu-hidden');

    const option = submenu.querySelector(
      '[data-testid="model-selector-effort-option"][data-effort="' + level.toLowerCase() + '"]'
    );
    const target = option?.closest('[role="menuitem"], [role="menuitemradio"]') ||
      Array.from(submenu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]'))
        .find((item) => (item.textContent || '').trim() === level);
    if (!target) return false;

    target.click();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      if (modelBaseFromTrigger()?.effort === level) return true;
    }
    return modelBaseFromTrigger()?.effort === level;
  }

  function markEffortMenu(menu) {
    if (!menu || menu.querySelector('[data-testid="model-selector-panel"]')) return;
    const labels = Array.from(menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]'))
      .map((item) => (item.textContent || '').trim())
      .filter(Boolean);
    if (!labels.length) return;
    const hits = labels.filter((label) => /^(low|medium|high|minimal|低|中|高)(\b|$)/i.test(label)).length;
    if (hits >= 2 || hits === labels.length) {
      menu.classList.add('ag-effort-submenu-hidden');
    }
  }

  function hideEffortSubmenus() {
    const main = getVisibleMenus().find((node) => node.querySelector('[data-testid="model-selector-panel"]'));
    if (!main) return;
    getVisibleMenus().forEach((menu) => {
      if (menu === main || menu.querySelector('[data-testid="model-selector-panel"]')) return;
      markEffortMenu(menu);
    });
  }

  function installEffortMenuGuard() {
    if (window.__agEffortMenuGuard) return;
    window.__agEffortMenuGuard = true;
    const inspect = (node) => {
      if (!node || node.nodeType !== 1) return;
      if (node.matches?.('[role="menu"]')) markEffortMenu(node);
      node.querySelectorAll?.('[role="menu"]').forEach(markEffortMenu);
    };
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach(inspect);
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.__agEffortMenuObserver = observer;
  }

  function installModelRowSelection() {
    if (window.__agModelRowSelectionBound) return;
    window.__agModelRowSelectionBound = true;

    document.addEventListener('click', async (event) => {
      const row = event.target.closest?.('[data-testid="model-selector-panel"] [role="menuitem"][aria-haspopup="menu"]');
      if (!row || event.target.closest('.ag-model-effort')) return;

      const base = row.querySelector('[data-testid="model-selector-effort-group"]')?.dataset.modelBase;
      if (!base) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      const current = modelBaseFromTrigger();
      if (current && current.base === base) return;

      const effortInput = document.querySelector('.ag-model-effort input[type="range"]');
      const desired = EFFORTS[Math.round(Number(effortInput?.value) || 0)] || current?.effort || 'Medium';
      const success = await applyEffort(desired, base);
      if (!success) return;

      await new Promise((resolve) => setTimeout(resolve, 260));
      if (getVisibleMenus().some((menu) => menu.querySelector('[data-testid="model-selector-panel"]'))) {
        closeModelMenu();
      }
    }, true);
  }

  function ensureModelEffort() {
    installEffortMenuGuard();
    const menu = getVisibleMenus().find((node) => node.querySelector('[data-testid="model-selector-panel"]'));
    if (menu) {
      hideEffortSubmenus();
      installModelRowSelection();
    }
    if (!menu || menu.querySelector('.ag-model-effort')) return;

    const info = modelBaseFromTrigger();
    if (!info) return;

    const panel = make('div', 'ag-model-effort');
    panel.innerHTML = [
      '<div class="ag-effort-top">',
      '<span class="ag-effort-icon"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 -960 960 960" fill="currentColor"><path d="M480-80 360-280h240L480-80Zm0-240L240-680h480L480-320Zm0-360L120-920h720L480-680Z"></path></svg></span>',
      '<span class="ag-effort-title">思考强度</span>',
      '<strong class="ag-effort-value">' + EFFORT_LABELS[info.effort] + '</strong>',
      '</div>',
      '<div class="ag-effort-model">' + escapeHtml(info.base) + '</div>',
      '<div class="ag-effort-control" style="--ag-effort-fill:' + (info.index * 50) + '%">',
      '<input type="range" min="0" max="2" step="0.01" value="' + info.index + '" aria-label="思考强度">',
      '<div class="ag-effort-ticks"><i></i><i></i><i></i></div>',
      '</div>',
      '<div class="ag-effort-scale"><span>低</span><span>中</span><span>高</span></div>'
    ].join('');

    const range = panel.querySelector('input[type="range"]');
    const valueNode = panel.querySelector('.ag-effort-value');
    const control = panel.querySelector('.ag-effort-control');

    const update = () => {
      const pos = Math.max(0, Math.min(1, Number(range.value) / 2 || 0));
      const index = Math.max(0, Math.min(2, Math.round(pos * 2)));
      valueNode.textContent = EFFORT_LABELS[EFFORTS[index]];
      control.style.setProperty('--ag-effort-fill', (pos * 100) + '%');
    };

    range.addEventListener('input', (event) => {
      event.stopPropagation();
      update();
    });
    range.addEventListener('keydown', (event) => event.stopPropagation(), true);
    range.addEventListener('pointerdown', (event) => event.stopPropagation());
    range.addEventListener('click', (event) => event.stopPropagation());
    range.addEventListener('change', async (event) => {
      event.stopPropagation();
      const index = Math.max(0, Math.min(2, Math.round(Number(range.value) / 2 * 2)));
      range.value = String(index);
      update();
      const level = EFFORTS[index];
      const current = modelBaseFromTrigger();
      if (!level || !current) return;
      if (level === current.effort) {
        range.value = String(current.index);
        update();
        return;
      }

      range.disabled = true;
      panel.classList.add('is-applying');
      try {
        await applyEffort(level, current.base);
        const next = modelBaseFromTrigger();
        if (next) {
          range.value = String(next.index);
          const modelNode = panel.querySelector('.ag-effort-model');
          if (modelNode) modelNode.textContent = next.base;
          update();
        }
        reopenModelMenu();
      } finally {
        range.disabled = false;
        panel.classList.remove('is-applying');
      }
    });

    const host = menu.querySelector('[data-testid="model-selector-panel"]');
    if (host) host.insertBefore(panel, host.firstElementChild);
  }

  function usageModeIcon(mode) {
    if (mode === 'ring') {
      return '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 -960 960 960" fill="currentColor"><path d="M120-240v-80h240v80H120Zm0-200v-80h480v80H120Zm0-200v-80h720v80H120Zm120 520v-120h120v120H240Zm0-280v-120h120v120H240Zm0-280v-120h120v120H240Zm240 280v-120h120v120H360Zm0-280v-120h120v120H360Zm240 280v-120h120v120H600Zm0-280v-120h120v120H600Z"></path></svg>';
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 -960 960 960" fill="currentColor"><path d="M480-80q-84 0-157-31.5T196-197q-54-54-85-127T80-481q0-84 31-157t85-127q54-54 127-85t157-31q84 0 157 31t127 85q54 54 85 127t31 157q0 83-31 156t-85 127q-54 54-127 85T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-160q-67 0-114-47t-47-114q0-67 47-114t114-47q67 0 114 47t47 114q0 67-47 114T480-320Z"></path></svg>';
  }

  function syncUsageModeButton(panel) {
    const button = panel?.querySelector('[data-ag-usage-mode]');
    if (!button) return;
    const nextLabel = usageMode === 'ring' ? '切换列表模式' : '切换环形模式';
    button.innerHTML = usageModeIcon(usageMode);
    button.setAttribute('aria-label', nextLabel);
    button.title = nextLabel;
  }

  const QUOTA_GROUP_STYLES = {
    gemini: { color: '#F6D893', inner: '#C4B5FD' },
    claude: { color: '#F0ABFC', inner: '#F6D893' },
    argon: { color: '#7DD3FC', inner: '#F6D893' },
    other: { color: '#6EE7B7', inner: '#F6D893' }
  };

  function quotaKey(label) {
    const value = String(label || '').toLowerCase();
    if (value.includes('argon')) return 'argon';
    if (value.includes('claude') || value.includes('gpt')) return 'claude';
    if (value.includes('gemini')) return 'gemini';
    return 'other';
  }

  function formatResetCountdown(reset, short) {
    if (!reset) return '';
    if (/^重置/.test(String(reset))) return String(reset);
    const time = Date.parse(reset);
    if (!Number.isFinite(time)) return String(reset);
    const diff = time - Date.now();
    if (diff <= 0) return '即将重置';
    const totalMinutes = Math.max(1, Math.floor(diff / 60000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    let value;
    if (days > 0) value = days + '天' + (hours > 0 ? hours + '小时' : '');
    else if (hours > 0) value = hours + '小时' + (minutes > 0 ? minutes + '分钟' : '');
    else value = minutes + '分钟';
    return short ? value : value + '后重置';
  }

  function normalizeOfficialGroups(groups) {
    return (groups || []).map((group) => {
      const key = quotaKey(group.displayName);
      const style = QUOTA_GROUP_STYLES[key] || QUOTA_GROUP_STYLES.other;
      const buckets = {};
      (group.buckets || []).forEach((bucket) => {
        buckets[bucket.window] = {
          percent: Math.max(0, Math.min(100, Math.round(Number(bucket.remainingFraction) * 100))),
          reset: bucket.resetTime || '',
          description: bucket.description || '',
          displayName: bucket.displayName || ''
        };
      });
      return {
        key,
        label: group.displayName || 'Models',
        description: group.description || '',
        weekly: buckets.weekly || null,
        five: buckets['5h'] || null,
        color: style.color,
        inner: style.inner
      };
    });
  }

  async function fetchOfficialQuota() {
    const token = window.__APP_CONFIG__?.csrfToken;
    if (!token) throw new Error('Missing CSRF token');
    const frame = new Uint8Array([0, 0, 0, 0, 2, 123, 125]);
    const response = await fetch('/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/grpc-web+json',
        'x-grpc-web': '1',
        'x-codeium-csrf-token': token,
        'x-user-agent': 'CONNECT_ES_USER_AGENT'
      },
      body: frame
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const buffer = new Uint8Array(await response.arrayBuffer());
    let offset = 0;
    let payload = null;
    while (offset + 5 <= buffer.length) {
      const flag = buffer[offset];
      const length = (buffer[offset + 1] << 24) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 8) | buffer[offset + 4];
      const start = offset + 5;
      const end = start + length;
      offset = end;
      if ((flag & 0x80) || length <= 0 || end > buffer.length) continue;
      payload = JSON.parse(new TextDecoder().decode(buffer.slice(start, end)));
    }
    const groups = payload?.response?.groups;
    if (!Array.isArray(groups)) throw new Error('Invalid quota response');
    return {
      source: 'official',
      groups: normalizeOfficialGroups(groups),
      fetchedAt: Date.now()
    };
  }

  function resetLabelToIso(label) {
    const text = String(label || '');
    const monthDay = text.match(/(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);
    const timeOnly = text.match(/(\d{1,2}):(\d{2})/);
    const now = new Date();
    let date = null;
    if (monthDay) {
      date = new Date(now.getFullYear(), Number(monthDay[1]) - 1, Number(monthDay[2]), Number(monthDay[3]), Number(monthDay[4]));
    } else if (timeOnly) {
      date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(timeOnly[1]), Number(timeOnly[2]));
      if (date.getTime() <= now.getTime()) date.setDate(date.getDate() + 1);
    }
    return date ? date.toISOString() : text;
  }

  function fallbackGroupsFromStats(data) {
    const quotas = Array.isArray(data?.model_quotas) ? data.model_quotas : [];
    const used = new Set();
    const take = (predicate) => {
      const found = quotas.filter((model) => !used.has(model.id) && predicate(model));
      found.forEach((model) => used.add(model.id));
      return found;
    };
    const gemini = take((model) => /gemini/i.test(model.id) && model.id !== 'gemini-4-argon');
    const claude = take((model) => /claude|gpt/i.test(model.id));
    const argon = take((model) => model.id === 'gemini-4-argon');
    const definitions = [
      { key: 'gemini', label: 'Gemini Models', models: gemini },
      { key: 'claude', label: 'Claude and GPT models', models: claude },
      { key: 'argon', label: 'Gemini 4 Argon', models: argon }
    ];
    return definitions.filter((entry) => entry.models.length).map((entry) => {
      const style = QUOTA_GROUP_STYLES[entry.key];
      const models = entry.models;
      const weeklyPercent = Math.min(...models.map((model) => Math.max(0, Math.min(100, Number(model.five_hour_remaining_pct) || 0))));
      const fivePercent = Math.max(...models.map((model) => Math.max(0, Math.min(100, Number(model.weekly_remaining_pct) || 0))));
      const weeklyReset = models.map((model) => model.five_hour_reset).find(Boolean) || '';
      const fiveReset = models.map((model) => model.weekly_reset).find(Boolean) || '';
      return {
        key: entry.key,
        label: entry.label,
        description: entry.models.map((model) => model.name || model.id).join(', '),
        weekly: { percent: weeklyPercent, reset: resetLabelToIso(weeklyReset), description: '' },
        five: entry.key === 'argon' ? null : { percent: fivePercent, reset: resetLabelToIso(fiveReset), description: '' },
        color: style.color,
        inner: style.inner
      };
    });
  }

  function formatGroupTitle(group) {
    const parts = [group.label];
    if (group.weekly) parts.push('周 ' + group.weekly.percent + '% · ' + formatResetCountdown(group.weekly.reset, false));
    if (group.five) parts.push('5H ' + group.five.percent + '% · ' + formatResetCountdown(group.five.reset, false));
    if (group.description) parts.push(group.description);
    return parts.join('；');
  }

  function renderUsageStrip(panel, groups, source) {
    const strip = panel?.querySelector('[data-ag-usage-strip]');
    if (!strip) return;
    if (!Array.isArray(groups) || !groups.length) {
      strip.innerHTML = '<span class="ag-usage-strip-label">额度读取中…</span>';
      return;
    }
    strip.innerHTML = groups.slice(0, 3).map((group) => {
      const weekly = group.weekly;
      const five = group.five;
      const percent = weekly ? weekly.percent : (five ? five.percent : 0);
      const label = String(group.label || '')
        .replace('Gemini Models', 'Gemini')
        .replace('Claude and GPT models', 'Claude/GPT')
        .replace('Gemini 4 Argon', 'Argon');
      return [
        '<div class="ag-usage-strip-item" title="' + escapeHtml(formatGroupTitle(group)) + '">',
        '<div class="ag-usage-strip-top">',
        '<span class="ag-usage-strip-label">' + escapeHtml(label) + '</span>',
        '<span class="ag-usage-strip-value">' + percent + '%</span>',
        '</div>',
        '<div class="ag-usage-strip-bar"><i style="width:' + percent + '%;--ag-model-color:' + (group.color || '#C4B5FD') + '"></i></div>',
        '</div>'
      ].join('');
    }).join('');
    strip.title = source === 'LIVE' ? '官方实时额度，点击展开详情' : '本地用量接口，点击展开详情';
  }

  function renderUsage(panel) {
    if (!panel) return;
    const body = panel.querySelector('.ag-usage-body');
    if (!body) return;

    syncUsageModeButton(panel);

    if (usageState.loading && !usageState.data) {
      body.innerHTML = '<div class="ag-usage-empty">正在读取额度...</div>';
      renderUsageStrip(panel, null, 'LOCAL');
      return;
    }
    if (usageState.error && !usageState.data) {
      body.innerHTML = '<div class="ag-usage-empty is-error">' + escapeHtml(usageState.error) + '</div>';
      renderUsageStrip(panel, null, 'LOCAL');
      return;
    }

    const data = usageState.data;
    if (!data) return;

    const groups = Array.isArray(data.groups) ? data.groups : [];
    const source = data.source === 'official' ? 'LIVE' : 'LOCAL';
    const planNode = panel.querySelector('[data-ag-usage-plan]');
    if (planNode) {
      planNode.textContent = source;
      planNode.title = source === 'LIVE' ? '官方实时额度' : '本地用量接口';
    }
    renderUsageStrip(panel, groups, source);

    if (!groups.length) {
      body.innerHTML = '<div class="ag-usage-empty">暂无模型额度</div>';
      return;
    }

    if (usageMode === 'ring') {
      body.innerHTML = '<div class="ag-usage-rings">' + groups.map((group) => {
        const weekly = group.weekly;
        const five = group.five;
        const mainPercent = weekly ? weekly.percent : (five ? five.percent : 0);
        const fivePercent = five ? five.percent : 0;
        const reset = weekly ? formatResetCountdown(weekly.reset, true) : '';
        const label = group.label.replace('Gemini Models', 'Gemini').replace('Claude and GPT models', 'Claude/GPT');
        return [
          '<div class="ag-usage-ring-group" title="' + escapeHtml(formatGroupTitle(group)) + '">',
          '<div class="ag-usage-ring" style="--ring-weekly:' + mainPercent + ';--ring-five:' + fivePercent + ';--ring-color:' + group.color + ';--ring-inner-color:' + group.inner + '">',
          '<div class="ag-usage-ring-core"><span class="ag-usage-ring-value">' + mainPercent + '%</span></div>',
          '</div>',
          '<span class="ag-usage-ring-label">' + escapeHtml(label) + '</span>',
          '<span class="ag-usage-ring-meta">' + (five ? '5H ' + five.percent + '%' : '仅周额度') + '</span>',
          '<span class="ag-usage-ring-reset">' + escapeHtml(reset) + '</span>',
          '</div>'
        ].join('');
      }).join('') + '</div>';
      return;
    }

    body.innerHTML = '<div class="ag-usage-groups">' + groups.map((group) => {
      const metrics = [];
      if (group.weekly) {
        metrics.push([
          '<div class="ag-usage-metric" title="' + escapeHtml(group.weekly.description || formatGroupTitle(group)) + '">',
          '<div class="ag-usage-metric-head"><span>周</span><b>' + group.weekly.percent + '%</b></div>',
          '<div class="ag-usage-metric-track"><i style="width:' + group.weekly.percent + '%;--ag-model-color:' + group.color + '"></i></div>',
          '<span class="ag-usage-reset">' + escapeHtml(formatResetCountdown(group.weekly.reset, false)) + '</span>',
          '</div>'
        ].join(''));
      }
      if (group.five) {
        metrics.push([
          '<div class="ag-usage-metric" title="' + escapeHtml(group.five.description || formatGroupTitle(group)) + '">',
          '<div class="ag-usage-metric-head"><span>5H</span><b>' + group.five.percent + '%</b></div>',
          '<div class="ag-usage-metric-track"><i style="width:' + group.five.percent + '%;--ag-model-color:' + group.inner + '"></i></div>',
          '<span class="ag-usage-reset">' + escapeHtml(formatResetCountdown(group.five.reset, false)) + '</span>',
          '</div>'
        ].join(''));
      }
      return [
        '<div class="ag-usage-group" title="' + escapeHtml(formatGroupTitle(group)) + '">',
        '<div class="ag-usage-group-head">',
        '<span class="ag-usage-dot" style="--ag-model-color:' + group.color + '"></span>',
        '<span class="ag-usage-group-name">' + escapeHtml(group.label) + '</span>',
        '<span class="ag-usage-group-badge">剩余</span>',
        '</div>',
        '<div class="ag-usage-metrics' + (metrics.length === 1 ? ' is-single' : '') + '">' + metrics.join('') + '</div>',
        '</div>'
      ].join('');
    }).join('') + '</div>';
  }

  function ensureUsagePanel() {
    if (!SHOW_USAGE_PANEL) {
      document.getElementById('ag-usage-panel')?.remove();
      return;
    }
    const settings = document.querySelector('[data-testid="settings-button"]');
    if (!settings) return;
    const sidebar = settings.closest('.bg-sidebar');
    if (!sidebar) return;

    let panel = document.getElementById('ag-usage-panel');
    if (!panel) {
      panel = make('section', 'ag-usage-panel');
      panel.id = 'ag-usage-panel';
      panel.innerHTML = [
        '<div class="ag-usage-head">',
        '<div class="ag-usage-title"><span class="ag-usage-live"></span><span>模型额度</span></div>',
        '<span class="ag-usage-plan" data-ag-usage-plan>LIVE</span>',
        '<button type="button" class="ag-usage-action" data-ag-usage-mode aria-label="切换环形模式" title="切换环形模式"></button>',
        '<button type="button" class="ag-usage-action" data-ag-usage-refresh aria-label="刷新模型额度" title="刷新模型额度">',
        '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 -960 960 960" fill="currentColor"><path d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h188q-28-64-82-102t-146-38q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z"></path></svg>',
        '</button>',
        '<button type="button" class="ag-usage-action ag-usage-toggle" data-ag-usage-toggle aria-label="收起额度面板" title="收起额度面板">',
        '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 -960 960 960" fill="currentColor"><path d="M480-345 240-585l56-56 184 184 184-184 56 56-240 240Z"></path></svg>',
        '</button>',
        '</div>',
        '<div class="ag-usage-strip" data-ag-usage-strip></div>',
        '<div class="ag-usage-body"><div class="ag-usage-empty">正在读取额度...</div></div>'
      ].join('');

      const scrollArea = [...sidebar.children].find((node) =>
        node.classList.contains('flex-1') && node.classList.contains('overflow-y-auto')
      );
      const bottom = settings.parentElement;
      const divider = bottom ? bottom.previousElementSibling : null;
      if (scrollArea && scrollArea !== panel) {
        scrollArea.after(panel);
      } else {
        sidebar.insertBefore(panel, divider && divider !== panel ? divider : bottom);
      }

      const setCollapsed = (next) => {
        panel.classList.toggle('is-collapsed', next);
        const toggle = panel.querySelector('[data-ag-usage-toggle]');
        if (toggle) {
          toggle.setAttribute('aria-label', next ? '展开额度面板' : '收起额度面板');
          toggle.title = next ? '展开额度面板' : '收起额度面板';
        }
        localStorage.setItem('ag-usage-collapsed', next ? '1' : '0');
      };

      const storedCollapsed = localStorage.getItem('ag-usage-collapsed');
      setCollapsed(storedCollapsed === null ? true : storedCollapsed === '1');

      const toggle = panel.querySelector('[data-ag-usage-toggle]');
      toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        setCollapsed(!panel.classList.contains('is-collapsed'));
      });

      const strip = panel.querySelector('[data-ag-usage-strip]');
      strip.addEventListener('click', (event) => {
        event.stopPropagation();
        setCollapsed(false);
      });

      const mode = panel.querySelector('[data-ag-usage-mode]');
      mode.addEventListener('click', (event) => {
        event.stopPropagation();
        usageMode = usageMode === 'ring' ? 'detail' : 'ring';
        localStorage.setItem('ag-usage-mode', usageMode);
        renderUsage(panel);
      });

      const refresh = panel.querySelector('[data-ag-usage-refresh]');
      refresh.addEventListener('click', (event) => {
        event.stopPropagation();
        loadUsage(true);
      });

      syncUsageModeButton(panel);
      renderUsage(panel);
      if (usageState.data) renderUsage(panel);
      loadUsage(false);
    }

    if (!panel.querySelector('[data-ag-usage-strip]')) {
      const body = panel.querySelector('.ag-usage-body');
      const strip = make('div', 'ag-usage-strip');
      strip.setAttribute('data-ag-usage-strip', '');
      panel.insertBefore(strip, body);
      strip.addEventListener('click', (event) => {
        event.stopPropagation();
        panel.querySelector('[data-ag-usage-toggle]')?.click();
      });
      renderUsage(panel);
    }

    const compactMigrated = localStorage.getItem('ag-usage-compact-v4') === '1';
    if (!compactMigrated) {
      panel.classList.add('is-collapsed');
      localStorage.setItem('ag-usage-collapsed', '1');
      localStorage.setItem('ag-usage-compact-v4', '1');
      const toggleNode = panel.querySelector('[data-ag-usage-toggle]');
      if (toggleNode) {
        toggleNode.setAttribute('aria-label', '展开额度面板');
        toggleNode.title = '展开额度面板';
      }
    }

    const scrollArea = [...sidebar.children].find((node) =>
      node.classList.contains('flex-1') && node.classList.contains('overflow-y-auto')
    );
    if (scrollArea && scrollArea !== panel && panel.previousElementSibling !== scrollArea) {
      scrollArea.after(panel);
    }
  }

  // One forced layout in Antigravity's document costs ~45ms, so the sidebar rail geometry is cached
  // and only re-measured when something could have moved it (collapse animation, resize, pane drag).
  let sidebarGeom = null;
  const SIDEBAR_GEOM_MS = 500;
  const SIDEBAR_GEOM_SAFE_MS = 2500;

  function updateSidebarHandle(force) {
    const handle = document.getElementById('ag-sidebar-handle');
    if (!handle) return;
    const now = performance.now();
    const widthKey = window.innerWidth + 'x' + window.innerHeight;
    const mayRefresh = !sidebarGeom || now - sidebarGeom.at > SIDEBAR_GEOM_MS;
    const mustRefresh = !sidebarGeom || sidebarGeom.widthKey !== widthKey || now - sidebarGeom.at > SIDEBAR_GEOM_SAFE_MS;
    if (force === true || (mayRefresh && mustRefresh)) {
      const settings = document.querySelector('[data-testid="settings-button"]');
      const sidebar = settings ? settings.closest('.bg-sidebar') : null;
      const wrapper = sidebar?.parentElement?.parentElement || null;
      const rect = wrapper ? wrapper.getBoundingClientRect() : null;
      sidebarGeom = { at: now, widthKey, right: rect ? rect.right : 360, wide: !!rect && rect.width > 80 };
    }
    if (typeof window.__agSidebarCollapsedState !== 'boolean') {
      window.__agSidebarCollapsedState = !sidebarGeom.wide;
    }
    const expanded = !window.__agSidebarCollapsedState;
    const left = expanded ? Math.min(window.innerWidth - 12, Math.max(0, sidebarGeom.right - 1)) : 4;
    const nextLeft = Math.round(left) + 'px';
    if (handle.style.left !== nextLeft) handle.style.left = nextLeft;
    handle.classList.toggle('is-collapsed', window.__agSidebarCollapsedState);
    const label = expanded ? '收起侧栏' : '展开侧栏';
    if (handle.getAttribute('aria-label') !== label) {
      handle.setAttribute('aria-label', label);
      handle.title = label;
    }
  }

  function ensureSidebarHandle() {
    let handle = document.getElementById('ag-sidebar-handle');
    if (!handle) {
      handle = make('button', '');
      handle.id = 'ag-sidebar-handle';
      handle.type = 'button';
      handle.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 -960 960 960" fill="currentColor"><path d="M560-240 320-480l240-240 56 56-184 184 184 184-56 56Z"></path></svg>';
      document.body.appendChild(handle);
      handle.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const root = [...document.querySelectorAll('.bg-sidebar')].find((node) => node.querySelector('[data-testid="settings-button"]'));
        const wrapper = root?.parentElement?.parentElement;
        if (!wrapper) return;

        if (typeof window.__agSidebarCollapsedState !== 'boolean') {
          window.__agSidebarCollapsedState = wrapper.getBoundingClientRect().width < 80;
        }
        const collapsed = window.__agSidebarCollapsedState;
        const width = collapsed
          ? Math.min(Number(window.__agSidebarExpandedWidth) || 360, 456)
          : Math.round(wrapper.getBoundingClientRect().width);
        if (!collapsed) window.__agSidebarExpandedWidth = width;
        window.__agSidebarCollapsedState = !collapsed;

        wrapper.style.setProperty('transition', 'width 460ms cubic-bezier(0.22, 1, 0.36, 1)', 'important');
        wrapper.style.setProperty('min-width', '0px', 'important');
        wrapper.style.setProperty('width', collapsed ? width + 'px' : '0px', 'important');
        handle.classList.toggle('is-collapsed', !collapsed);

        const started = performance.now();
        const timer = window.setInterval(() => {
          updateSidebarHandle(true);
          if (performance.now() - started > 560) {
            window.clearInterval(timer);
            updateSidebarHandle(true);
          }
        }, 16);
      });
    }
    updateSidebarHandle();
  }

  async function loadUsage(force) {
    if (!SHOW_USAGE_PANEL) return;
    if (usageState.loading) return;
    if (!force && usageState.data && Date.now() - usageState.lastFetch < 45000) return;
    usageState.loading = true;
    const panel = document.getElementById('ag-usage-panel');
    const refresh = panel ? panel.querySelector('[data-ag-usage-refresh]') : null;
    if (refresh) refresh.classList.add('is-loading');
    if (panel) renderUsage(panel);

    let payload = null;
    let lastError = null;

    try {
      payload = await fetchOfficialQuota();
    } catch (error) {
      lastError = error;
    }

    if (!payload) {
      for (const endpoint of USAGE_ENDPOINTS) {
        try {
          const response = await fetch(endpoint + (endpoint.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const data = await response.json();
          if (data && data.ok !== false) {
            payload = {
              source: 'local',
              groups: fallbackGroupsFromStats(data),
              fetchedAt: Date.now()
            };
            break;
          }
        } catch (error) {
          lastError = error;
        }
      }
    }

    usageState.loading = false;
    if (refresh) refresh.classList.remove('is-loading');

    if (payload) {
      usageState.data = payload;
      usageState.error = null;
      usageState.lastFetch = Date.now();
    } else {
      usageState.error = '额度服务未连接';
      if (!usageState.data && lastError) {
        console.warn('[Wallpaper] Usage fetch failed:', lastError);
      }
    }

    const currentPanel = document.getElementById('ag-usage-panel');
    if (currentPanel) renderUsage(currentPanel);
  }

  function insertPluginTag(plugin) {
    const composer = getComposer();
    const editor = composer ? composer.querySelector('[contenteditable="true"]') : null;
    const lexical = editor?.__lexicalEditor;
    const MentionNode = lexical?._nodes?.get('contextScopeItemMention')?.klass;
    const TextNode = lexical?._nodes?.get('text')?.klass;
    const ParagraphNode = lexical?._nodes?.get('paragraph')?.klass;

    if (!lexical || !MentionNode || !TextNode || !ParagraphNode) {
      const fallback = '使用已安装插件「' + (plugin.displayName || plugin.name) + '」（' + plugin.id + '）。' + (plugin.suggestedPrompt || plugin.description || '');
      return insertComposerText(fallback);
    }

    const skillName = plugin.skillName || plugin.id;
    const definitionPath = plugin.skillPath || (plugin.path ? plugin.path + '\\plugin.json' : plugin.id);
    const modelFacingText = plugin.skillPath
      ? '<SKILL>The user requested you read and use the "' + skillName + '" skill. The path to the skill file is:\n' + definitionPath + '</SKILL>'
      : '<PLUGIN>The user selected the installed plugin "' + (plugin.displayName || plugin.name) + '" (' + plugin.id + '). Read its plugin manifest at ' + definitionPath + ' and follow its instructions.</PLUGIN>';
    const mentionData = {
      mentionText: plugin.id,
      data: JSON.stringify({
        slashCommand: {
          info: {
            name: skillName,
            modelFacingText,
            type: 'SLASH_COMMAND_TYPE_SKILL',
            definitionPath
          }
        }
      })
    };

    try {
      lexical.update(() => {
        const root = lexical._pendingEditorState._nodeMap.get('root');
        if (!root) return;
        const paragraph = new ParagraphNode();
        paragraph.append(new MentionNode(mentionData));
        const action = plugin.suggestedPrompt || '';
        if (action) paragraph.append(new TextNode(' ' + action));
        root.append(paragraph);
        if (typeof root.selectEnd === 'function') root.selectEnd();
      }, { tag: 'ag-plugin-tag-insert' });
      lexical.focus();
      return true;
    } catch (error) {
      console.warn('[Wallpaper] Plugin tag insertion failed:', error);
      const fallback = '使用已安装插件「' + (plugin.displayName || plugin.name) + '」（' + plugin.id + '）。' + (plugin.suggestedPrompt || plugin.description || '');
      return insertComposerText(fallback);
    }
  }

  function insertSkillTag(skill) {
    if (!skill) return false;
    return insertPluginTag({
      id: skill.name,
      displayName: skill.title || skill.name,
      name: skill.name,
      skillName: skill.name,
      skillPath: skill.path,
      description: skill.description || '',
      path: String(skill.path || '').replace(/[\\/][^\\/]+$/, ''),
      suggestedPrompt: ''
    });
  }

  function pluginIconSvg() {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 -960 960 960" fill="currentColor"><path d="M360-200q-117 0-198.5-81.5T80-480q0-117 81.5-198.5T360-760h240q117 0 198.5 81.5T880-480q0 117-81.5 198.5T600-200H360Zm0-80h240q83 0 141.5-58.5T800-480q0-83-58.5-141.5T600-680H360q-83 0-141.5 58.5T160-480q0 83 58.5 141.5T360-280Zm240-80q50 0 85-35t35-85q0-50-35-85t-85-35q-50 0-85 35t-35 85q0 50 35 85t85 35Z"></path></svg>';
  }

  function readDeckFavorites() {
    try {
      const raw = localStorage.getItem(DECK_FAVORITES_KEY);
      const list = JSON.parse(raw || '[]');
      return new Set(Array.isArray(list) ? list : []);
    } catch (error) {
      return new Set();
    }
  }

  function writeDeckFavorites(favorites) {
    try {
      localStorage.setItem(DECK_FAVORITES_KEY, JSON.stringify(Array.from(favorites)));
    } catch (error) {}
  }

  function deckInitials(text) {
    return String(text || '')
      .split(/[\s\-_/]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0))
      .join('')
      .toLowerCase();
  }

  function deckMatches(haystack, initials, query) {
    if (!query) return true;
    if (haystack.includes(query)) return true;
    if (initials && initials.includes(query)) return true;
    return false;
  }

  function deckStar(key, favorite) {
    return '<button type="button" class="ag-skill-star' + (favorite ? ' is-favorite' : '') + '" data-ag-deck-star="' + escapeHtml(key) + '" aria-label="' + (favorite ? '取消收藏' : '收藏') + '" title="' + (favorite ? '取消收藏' : '收藏') + '">' + (favorite ? '★' : '☆') + '</button>';
  }

  function deckItemMarkup(kind, item, index, favorites) {
    const isSkill = kind === 'skill';
    const key = (isSkill ? 'skill:' : 'plugin:') + (item.name || item.id);
    const name = isSkill ? (item.title || item.name) : (item.displayName || item.name);
    const description = item.description || '';
    const badge = String(name || '?').trim().charAt(0).toUpperCase();
    const color = isSkill
      ? (item.source === 'personal' ? '#C4B5FD' : (item.source === 'builtin' ? '#FCD34D' : '#7DD3FC'))
      : PLUGIN_COLORS[index % PLUGIN_COLORS.length];
    const haystack = [name, item.name, item.id, description, item.path].filter(Boolean).join(' ').toLowerCase();
    const initials = deckInitials(name + ' ' + (item.name || ''));
    const title = [name, description, item.path].filter(Boolean).join('\n');
    return [
      '<div class="ag-plugin-item" role="button" tabindex="0"',
      isSkill ? ' data-skill-name="' + escapeHtml(item.name) + '"' : ' data-plugin-id="' + escapeHtml(item.id) + '"',
      ' data-deck-key="' + escapeHtml(key) + '"',
      ' data-search="' + escapeHtml(haystack) + '"',
      ' data-initials="' + escapeHtml(initials) + '"',
      ' title="' + escapeHtml(title) + '">',
      '<span class="ag-plugin-badge" style="--ag-plugin-color:' + color + '">' + escapeHtml(badge) + '</span>',
      '<span class="ag-plugin-copy">',
      '<span class="ag-plugin-name">' + escapeHtml(name) + '</span>',
      '<span class="ag-plugin-desc">' + escapeHtml(description) + '</span>',
      '</span>',
      deckStar(key, favorites.has(key)),
      isSkill
        ? '<span class="ag-plugin-version">' + escapeHtml(item.source === 'personal' ? 'Skill' : item.source) + '</span>'
        : '<span class="ag-plugin-version">' + escapeHtml(item.version || '') + '</span>',
      '</div>'
    ].join('');
  }

  function renderDeck(panel, query) {
    if (!panel) return;
    const list = panel.querySelector('.ag-plugin-list');
    if (!list) return;
    const tab = panel.dataset.deckTab || 'plugins';
    const search = String(query || '').trim().toLowerCase();
    const favorites = readDeckFavorites();
    const plugins = PLUGINS.map((item) => ({ kind: 'plugin', item }));
    const skills = SKILLS.map((item) => ({ kind: 'skill', item }));
    let entries;
    if (tab === 'favorites') {
      entries = plugins.concat(skills).filter((entry) => favorites.has((entry.kind === 'skill' ? 'skill:' : 'plugin:') + (entry.item.name || entry.item.id)));
      entries.sort((a, b) => String(a.item.title || a.item.displayName || a.item.name || '').localeCompare(String(b.item.title || b.item.displayName || b.item.name || '')));
    } else if (tab === 'skills') {
      entries = skills;
    } else {
      entries = plugins;
    }
    entries = entries.filter((entry) => {
      const item = entry.item;
      const name = entry.kind === 'skill' ? (item.title || item.name) : (item.displayName || item.name);
      const haystack = [name, item.name, item.id, item.description, item.path].filter(Boolean).join(' ').toLowerCase();
      return deckMatches(haystack, deckInitials(name + ' ' + (item.name || '')), search);
    });

    list.innerHTML = entries.length
      ? entries.map((entry, index) => deckItemMarkup(entry.kind, entry.item, index, favorites)).join('')
      : '<div class="ag-plugin-empty">' + (tab === 'favorites' ? '还没有收藏，点条目右侧的 ☆ 收藏' : '没有匹配的插件或 Skill') + '</div>';

    const count = panel.querySelector('.ag-plugin-count');
    if (count) count.textContent = String(entries.length);
    panel.querySelectorAll('.ag-plugin-tab').forEach((node) => {
      node.classList.toggle('is-active', node.getAttribute('data-ag-deck-tab') === tab);
    });
    const create = panel.querySelector('.ag-plugin-create');
    if (create) create.hidden = tab !== 'plugins';
  }

  function buildPluginPanel() {
    const panel = make('div', 'ag-plugin-panel');
    panel.dataset.deckTab = 'plugins';
    panel.innerHTML = [
      '<div class="ag-plugin-head">',
      '<div class="ag-plugin-title"><span class="ag-plugin-mark">' + pluginIconSvg() + '</span><span>技能罗盘</span><span class="ag-plugin-count">' + (PLUGINS.length + SKILLS.length) + '</span></div>',
      '<button type="button" class="ag-plugin-close" aria-label="关闭技能罗盘">',
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 -960 960 960" fill="currentColor"><path d="M256-226.23 226.23-256 480-522.15 733.77-256 704-226.23 480-480 256-226.23Z"></path></svg>',
      '</button>',
      '</div>',
      '<div class="ag-plugin-tabs" role="tablist" aria-label="技能分类">',
      '<button type="button" class="ag-plugin-tab is-active" data-ag-deck-tab="plugins" role="tab">插件</button>',
      '<button type="button" class="ag-plugin-tab" data-ag-deck-tab="skills" role="tab">技能库</button>',
      '<button type="button" class="ag-plugin-tab" data-ag-deck-tab="favorites" role="tab">收藏</button>',
      '</div>',
      '<div class="ag-plugin-search-wrap">',
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 -960 960 960" fill="currentColor"><path d="M781.69-136.92 530.46-388.16q-30 24.77-69 38.77t-80.69 14q-102.46 0-173.54-71.08T136.16-580t71.08-173.54t173.54-71.08t173.54 71.08T625.38-580q0 42.85-14.38 81.85t-38.38 67.85L823.84-179.08l-42.15 42.15ZM380.77-395.38q77.31 0 130.96-53.65T565.39-580T511.73-710.96T380.77-764.62T249.81-710.96T196.15-580t53.65 130.96t130.96 53.65Z"></path></svg>',
      '<input type="text" class="ag-plugin-search" placeholder="搜索名称 / 描述 / 首字母…" aria-label="搜索插件与 Skill">',
      '</div>',
      '<div class="ag-plugin-list" role="group" aria-label="插件与 Skill"></div>',
      '<button type="button" class="ag-plugin-create">',
      '<span class="ag-plugin-create-plus">+</span><span>创建新插件</span>',
      '</button>'
    ].join('');
    renderDeck(panel, '');
    return panel;
  }

  function ensurePluginPicker() {
    const composer = getComposer();
    if (!composer) return;
    const footer = composer.querySelector('[class*="input-footer"]');
    if (!footer) return;

    let trigger = composer.querySelector('.ag-plugin-trigger');
    if (!trigger) {
      trigger = make('button', 'ag-plugin-trigger');
      trigger.type = 'button';
      trigger.title = '选择已安装插件';
      trigger.setAttribute('aria-label', '选择已安装插件');
      trigger.innerHTML = pluginIconSvg();
      const addContext = footer.querySelector('button[aria-label="Add context"]');
      if (addContext && addContext.parentElement) addContext.after(trigger);
      else footer.prepend(trigger);
    }

    let panel = composer.querySelector('.ag-plugin-panel');
    if (!panel) {
      panel = buildPluginPanel();
      composer.appendChild(panel);
    }

    if (!pluginPanelBound) {
      pluginPanelBound = true;

      const setOpen = (open) => {
        const currentPanel = getComposer()?.querySelector('.ag-plugin-panel:not(.ag-prompt-panel)');
        const currentTrigger = getComposer()?.querySelector('.ag-plugin-trigger:not(.ag-prompt-trigger)');
        if (!currentPanel || !currentTrigger) return;
        currentPanel.classList.toggle('is-open', open);
        currentTrigger.classList.toggle('is-active', open);
        if (open) {
          const composer = getComposer();
          if (composer) {
            const rect = composer.getBoundingClientRect();
            const availableAbove = Math.max(190, rect.top - 58);
            currentPanel.style.maxHeight = Math.min(390, availableAbove) + 'px';
            composer.querySelector('.ag-prompt-panel')?.classList.remove('is-open');
            composer.querySelector('.ag-prompt-trigger')?.classList.remove('is-active');
          }
          const search = currentPanel.querySelector('.ag-plugin-search');
          if (search) {
            search.value = '';
            currentPanel.dataset.deckTab = 'plugins';
            renderDeck(currentPanel, '');
            setTimeout(() => search.focus(), 30);
          }
        } else {
          currentPanel.style.maxHeight = '';
        }
      };

      document.addEventListener('click', (event) => {
        const currentTrigger = event.target.closest?.('.ag-plugin-trigger:not(.ag-prompt-trigger)');
        if (currentTrigger) {
          event.preventDefault();
          event.stopPropagation();
          const currentPanel = getComposer()?.querySelector('.ag-plugin-panel:not(.ag-prompt-panel)');
          setOpen(!(currentPanel && currentPanel.classList.contains('is-open')));
          return;
        }

        const currentPanel = getComposer()?.querySelector('.ag-plugin-panel:not(.ag-prompt-panel)');
        if (!currentPanel || !currentPanel.classList.contains('is-open')) return;

        if (event.target.closest?.('.ag-plugin-close')) {
          event.preventDefault();
          setOpen(false);
          return;
        }

        const tab = event.target.closest?.('[data-ag-deck-tab]');
        if (tab) {
          event.preventDefault();
          currentPanel.dataset.deckTab = tab.getAttribute('data-ag-deck-tab') || 'plugins';
          renderDeck(currentPanel, currentPanel.querySelector('.ag-plugin-search')?.value || '');
          return;
        }

        const star = event.target.closest?.('[data-ag-deck-star]');
        if (star) {
          event.preventDefault();
          event.stopPropagation();
          const key = star.getAttribute('data-ag-deck-star');
          const favorites = readDeckFavorites();
          if (favorites.has(key)) favorites.delete(key);
          else favorites.add(key);
          writeDeckFavorites(favorites);
          renderDeck(currentPanel, currentPanel.querySelector('.ag-plugin-search')?.value || '');
          return;
        }

        const item = event.target.closest?.('.ag-plugin-item');
        if (item) {
          event.preventDefault();
          const skillName = item.getAttribute('data-skill-name');
          if (skillName) {
            const skill = SKILLS.find((entry) => entry.name === skillName);
            if (skill) {
              insertSkillTag(skill);
              setOpen(false);
            }
            return;
          }
          const plugin = PLUGINS.find((entry) => entry.id === item.getAttribute('data-plugin-id'));
          if (plugin) {
            insertPluginTag(plugin);
            setOpen(false);
          }
          return;
        }

        const create = event.target.closest?.('.ag-plugin-create');
        if (create) {
          event.preventDefault();
          insertComposerText('请帮我创建一个新的 Antigravity 插件：');
          setOpen(false);
          return;
        }

        if (!currentPanel.contains(event.target)) setOpen(false);
      }, true);

      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        const currentPanel = getComposer()?.querySelector('.ag-plugin-panel:not(.ag-prompt-panel)');
        if (!currentPanel || !currentPanel.classList.contains('is-open')) return;
        event.stopPropagation();
        setOpen(false);
      }, true);

      document.addEventListener('input', (event) => {
        const search = event.target.closest?.('.ag-plugin-search');
        if (!search) return;
        const currentPanel = getComposer()?.querySelector('.ag-plugin-panel:not(.ag-prompt-panel)');
        if (!currentPanel) return;
        renderDeck(currentPanel, search.value);
      }, true);

      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const item = event.target.closest?.('.ag-plugin-item[role="button"]');
        if (!item) return;
        event.preventDefault();
        item.click();
      });
    }
  }

  const FALLBACK_PROMPTS = [
    { id: 'preset-review', title: '代码审查', prompt: '请以资深工程师视角审查当前改动，优先指出真实 bug、回归风险、边界情况和缺失测试。' },
    { id: 'preset-explain', title: '解释代码', prompt: '请逐步解释下面这段代码的作用、关键数据流和潜在风险，并给出必要的调用示例。' },
    { id: 'preset-tests', title: '补充测试', prompt: '请为当前功能补充关键单元测试，覆盖正常路径、边界条件和失败路径，并说明测试意图。' },
    { id: 'preset-ui', title: '优化界面', prompt: '请在不增加多余装饰的前提下优化当前界面的层级、间距、对比度与可读性，并保持现有功能不变。' }
  ];
  const DEFAULT_PROMPTS = Array.isArray(window.__AG_DEFAULT_PROMPTS) && window.__AG_DEFAULT_PROMPTS.length
    ? window.__AG_DEFAULT_PROMPTS
    : FALLBACK_PROMPTS;
  const PROMPT_STORAGE_KEY = 'ag-prompt-presets-v2';

  let promptPresetsCache = null;
  let promptHydrated = false;

  function loadPromptPresets() {
    if (Array.isArray(promptPresetsCache)) return promptPresetsCache;
    try {
      const raw = localStorage.getItem(PROMPT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const valid = parsed.filter((item) => item && item.id && item.title && item.prompt);
          promptPresetsCache = valid;
          return valid;
        }
      }
    } catch (error) {}

    let legacy = [];
    try {
      const raw = localStorage.getItem('ag-prompt-presets-v1');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) legacy = parsed;
      }
    } catch (error) {}
    const legacyDefaults = new Set(['preset-review', 'preset-explain', 'preset-tests', 'preset-ui']);
    const custom = legacy.filter((item) => item && item.id && item.title && item.prompt && !legacyDefaults.has(item.id) && !String(item.id).startsWith('dsh-'));
    const seeded = [
      ...DEFAULT_PROMPTS.map((item) => ({
        id: String(item.id || ('dsh-' + item.title)),
        title: String(item.title || item.name || '未命名预设'),
        prompt: String(item.prompt || item.body || '')
      })),
      ...custom
    ];
    promptPresetsCache = seeded;
    try {
      localStorage.setItem(PROMPT_STORAGE_KEY, JSON.stringify(seeded));
    } catch (error) {}
    return seeded;
  }

  function savePromptPresets(presets) {
    promptPresetsCache = presets;
    try {
      localStorage.setItem(PROMPT_STORAGE_KEY, JSON.stringify(presets));
    } catch (error) {}
    fetch(SIDECAR + '/api/prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompts: presets })
    }).catch(() => {});
  }

  async function hydratePromptPresets() {
    if (promptHydrated) return;
    promptHydrated = true;
    try {
      const response = await fetch(SIDECAR + '/api/prompts', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      const list = Array.isArray(data.prompts) ? data.prompts.filter((item) => item && item.id && item.title && item.prompt) : [];
      if (list.length) {
        promptPresetsCache = list;
        try {
          localStorage.setItem(PROMPT_STORAGE_KEY, JSON.stringify(list));
        } catch (error) {}
      } else {
        const seeded = loadPromptPresets();
        fetch(SIDECAR + '/api/prompts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompts: seeded })
        }).catch(() => {});
      }
      document.querySelectorAll('.ag-prompt-panel').forEach(renderPromptList);
      document.querySelectorAll('.ag-prompt-panel').forEach((panel) => {
        const count = panel.querySelector('[data-ag-prompt-count]');
        if (count) count.textContent = String(loadPromptPresets().length);
      });
    } catch (error) {}
  }

  function insertPromptTemplate(text) {
    let output = String(text || '');
    const selection = window.getSelection?.()?.toString?.() || '';
    output = output.replace(/\{\{selection\}\}/g, selection);
    output = output.replace(/\{\{cursor\}\}/g, '');
    if (!output.includes('{{clipboard}}')) {
      return insertComposerText(output);
    }
    (async () => {
      let clipboard = '';
      try {
        clipboard = await navigator.clipboard.readText();
      } catch (error) {}
      insertComposerText(output.replace(/\{\{clipboard\}\}/g, clipboard));
    })();
    return true;
  }

  function promptIconSvg() {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 -960 960 960" fill="currentColor"><path d="M240-160v-640h480v640L480-276 240-160Zm60-91 180-78 180 78v-489H300v489Z"></path></svg>';
  }

  function buildPromptPanel() {
    const panel = make('div', 'ag-plugin-panel ag-prompt-panel');
    panel.innerHTML = [
      '<div class="ag-plugin-head">',
      '<div class="ag-plugin-title"><span class="ag-plugin-mark">' + promptIconSvg() + '</span><span>提示词预设</span><span class="ag-plugin-count" data-ag-prompt-count>0</span></div>',
      '<button type="button" class="ag-plugin-close" data-ag-prompt-close aria-label="关闭提示词预设">',
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 -960 960 960" fill="currentColor"><path d="M256-226.23 226.23-256 480-522.15 733.77-256 704-226.23 480-480 256-226.23Z"></path></svg>',
      '</button>',
      '</div>',
      '<div class="ag-plugin-list ag-prompt-list" role="group" aria-label="提示词预设"></div>',
      '<button type="button" class="ag-plugin-create ag-prompt-footer" data-ag-prompt-new>',
      '<span class="ag-plugin-create-plus">+</span><span>新建预设</span>',
      '</button>',
      '<form class="ag-prompt-form" data-ag-prompt-form>',
      '<input class="ag-prompt-input" data-ag-prompt-title type="text" maxlength="80" placeholder="预设名称">',
      '<textarea class="ag-prompt-textarea" data-ag-prompt-content placeholder="输入提示词内容..." spellcheck="false"></textarea>',
      '<div class="ag-prompt-form-actions">',
      '<button type="button" class="ag-prompt-form-btn" data-ag-prompt-cancel>取消</button>',
      '<button type="submit" class="ag-prompt-form-btn primary">保存</button>',
      '</div>',
      '</form>'
    ].join('');
    return panel;
  }

  function renderPromptList(panel) {
    const list = panel?.querySelector('.ag-prompt-list');
    if (!list) return;
    const presets = loadPromptPresets();
    const count = panel.querySelector('[data-ag-prompt-count]');
    if (count) count.textContent = String(presets.length);
    list.innerHTML = presets.map((preset, index) => {
      const color = PLUGIN_COLORS[index % PLUGIN_COLORS.length];
      return [
        '<div class="ag-plugin-item ag-prompt-item" data-ag-prompt-id="' + escapeHtml(preset.id) + '" role="button" tabindex="0" title="' + escapeHtml(preset.prompt) + '">',
        '<span class="ag-plugin-badge" style="--ag-plugin-color:' + color + '">',
        '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 -960 960 960" fill="currentColor"><path d="M240-160v-640h480v640L480-276 240-160Z"></path></svg>',
        '</span>',
        '<span class="ag-plugin-copy">',
        '<span class="ag-plugin-name">' + escapeHtml(preset.title) + '</span>',
        '<span class="ag-prompt-preview">' + escapeHtml(preset.prompt) + '</span>',
        '</span>',
        '<span class="ag-prompt-actions">',
        '<button type="button" class="ag-prompt-action" data-ag-prompt-edit aria-label="编辑预设" title="编辑预设">',
        '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 -960 960 960" fill="currentColor"><path d="M200-200h57l391-391-57-57-391 391v57Zm-80 80v-170l528-527q12-11 26.5-17t30.5-6q16 0 31 6t26 18l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T817-647L290-120H120Zm640-584-56-56 56 56Zm-141 85-28-29 57 57-29-28Z"></path></svg>',
        '</button>',
        '<button type="button" class="ag-prompt-action" data-ag-prompt-delete aria-label="删除预设" title="删除预设">',
        '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 -960 960 960" fill="currentColor"><path d="M280-120q-33 0-56.5-23.5T200-200v-520H120v-60h180v-40h360v40h180v60h-80v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h60v-360h-60v360Zm120 0h60v-360h-60v360Z"></path></svg>',
        '</button>',
        '</span>',
        '</div>'
      ].join('');
    }).join('');
  }

  function showPromptForm(panel, preset) {
    if (!panel) return;
    panel.classList.add('is-managing');
    panel.dataset.editingId = preset ? preset.id : '';
    const title = panel.querySelector('[data-ag-prompt-title]');
    const content = panel.querySelector('[data-ag-prompt-content]');
    if (title) title.value = preset ? preset.title : '';
    if (content) content.value = preset ? preset.prompt : '';
    setTimeout(() => title?.focus(), 30);
  }

  function hidePromptForm(panel) {
    if (!panel) return;
    panel.classList.remove('is-managing');
    panel.dataset.editingId = '';
  }

  function setPromptPanelOpen(open) {
    const composer = getComposer();
    const panel = composer?.querySelector('.ag-prompt-panel');
    const trigger = composer?.querySelector('.ag-prompt-trigger');
    if (!panel || !trigger) return;
    if (open) {
      composer.querySelector('.ag-plugin-panel:not(.ag-prompt-panel)')?.classList.remove('is-open');
      composer.querySelector('.ag-plugin-trigger:not(.ag-prompt-trigger)')?.classList.remove('is-active');
      const rect = composer.getBoundingClientRect();
      panel.style.maxHeight = Math.min(390, Math.max(210, rect.top - 58)) + 'px';
      renderPromptList(panel);
      hidePromptForm(panel);
    } else {
      panel.style.maxHeight = '';
      hidePromptForm(panel);
    }
    panel.classList.toggle('is-open', open);
    trigger.classList.toggle('is-active', open);
  }

  let promptPanelBound = false;

  function ensurePromptPresets() {
    const composer = getComposer();
    if (!composer) return;
    const footer = composer.querySelector('[class*="input-footer"]');
    if (!footer) return;

    let trigger = composer.querySelector('.ag-prompt-trigger');
    if (!trigger) {
      trigger = make('button', 'ag-plugin-trigger ag-prompt-trigger');
      trigger.type = 'button';
      trigger.title = '提示词预设';
      trigger.setAttribute('aria-label', '提示词预设');
      trigger.innerHTML = promptIconSvg();
      const pluginTrigger = composer.querySelector('.ag-plugin-trigger:not(.ag-prompt-trigger)');
      if (pluginTrigger) pluginTrigger.after(trigger);
      else footer.prepend(trigger);
    }

    let panel = composer.querySelector('.ag-prompt-panel');
    if (!panel) {
      panel = buildPromptPanel();
      composer.appendChild(panel);
      renderPromptList(panel);
    }

    if (promptPanelBound) return;
    promptPanelBound = true;

    document.addEventListener('click', (event) => {
      const currentTrigger = event.target.closest?.('.ag-prompt-trigger');
      if (currentTrigger) {
        event.preventDefault();
        event.stopPropagation();
        const currentPanel = getComposer()?.querySelector('.ag-prompt-panel');
        setPromptPanelOpen(!(currentPanel && currentPanel.classList.contains('is-open')));
        return;
      }

      const currentPanel = getComposer()?.querySelector('.ag-prompt-panel');
      if (!currentPanel || !currentPanel.classList.contains('is-open')) return;

      if (event.target.closest?.('[data-ag-prompt-close]')) {
        event.preventDefault();
        setPromptPanelOpen(false);
        return;
      }

      if (event.target.closest?.('[data-ag-prompt-new]')) {
        event.preventDefault();
        showPromptForm(currentPanel, null);
        return;
      }

      if (event.target.closest?.('[data-ag-prompt-cancel]')) {
        event.preventDefault();
        hidePromptForm(currentPanel);
        return;
      }

      const item = event.target.closest?.('.ag-prompt-item');
      if (item) {
        event.preventDefault();
        const id = item.getAttribute('data-ag-prompt-id');
        const presets = loadPromptPresets();
        const preset = presets.find((entry) => entry.id === id);
        if (!preset) return;

        if (event.target.closest?.('[data-ag-prompt-delete]')) {
          if (window.confirm('删除预设「' + preset.title + '」？')) {
            const next = presets.filter((entry) => entry.id !== id);
            savePromptPresets(next);
            renderPromptList(currentPanel);
          }
          return;
        }

        if (event.target.closest?.('[data-ag-prompt-edit]')) {
          showPromptForm(currentPanel, preset);
          return;
        }

        insertPromptTemplate(preset.prompt);
        setPromptPanelOpen(false);
        return;
      }

      if (!currentPanel.contains(event.target)) setPromptPanelOpen(false);
    }, true);

    document.addEventListener('submit', (event) => {
      const form = event.target.closest?.('[data-ag-prompt-form]');
      if (!form) return;
      event.preventDefault();
      event.stopPropagation();
      const panel = form.closest('.ag-prompt-panel');
      if (!panel) return;
      const title = form.querySelector('[data-ag-prompt-title]')?.value.trim();
      const content = form.querySelector('[data-ag-prompt-content]')?.value.trim();
      if (!content) {
        form.querySelector('[data-ag-prompt-content]')?.focus();
        return;
      }
      const presets = loadPromptPresets();
      const editingId = panel.dataset.editingId;
      if (editingId) {
        const target = presets.find((entry) => entry.id === editingId);
        if (target) {
          target.title = title || content.slice(0, 18);
          target.prompt = content;
        }
      } else {
        presets.unshift({
          id: 'preset-' + Date.now().toString(36),
          title: title || content.slice(0, 18),
          prompt: content
        });
      }
      savePromptPresets(presets);
      hidePromptForm(panel);
      renderPromptList(panel);
    }, true);

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const panel = getComposer()?.querySelector('.ag-prompt-panel');
      if (!panel || !panel.classList.contains('is-open')) return;
      event.stopPropagation();
      if (panel.classList.contains('is-managing')) hidePromptForm(panel);
      else setPromptPanelOpen(false);
    }, true);
  }

  function findPathInValue(value, depth) {
    if (depth > 2 || value == null) return null;
    if (typeof value === 'string') {
      const match = value.match(/[A-Za-z]:[\\/][^\n\r"'<>|]*(?:SKILL\.md|[\\/]skills[\\/][^\n\r"'<>|]+)/i);
      return match ? match[0].replace(/[),.;]+$/, '') : null;
    }
    if (typeof value !== 'object') return null;
    try {
      for (const key of Object.keys(value)) {
        if (/path|file|uri|skill/i.test(key)) {
          const found = findPathInValue(value[key], depth + 1);
          if (found) return found;
        }
      }
    } catch (error) {}
    return null;
  }

  function skillPathFromProps(card) {
    const fiberKey = Object.keys(card).find((key) => key.startsWith('__reactFiber$'));
    if (!fiberKey) return null;
    let fiber = card[fiberKey];
    for (let depth = 0; depth < 9 && fiber; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      for (const key of Object.keys(props)) {
        if (/skill|item|data|scope/i.test(key)) {
          const found = findPathInValue(props[key], 0);
          if (found) return found;
        }
      }
    }
    return null;
  }

  async function resolveSkillPath(card, copyButton) {
    const direct = skillPathFromProps(card);
    if (direct) return direct;

    if (copyButton) {
      let captured = '';
      const clipboard = navigator.clipboard;
      const original = clipboard?.writeText;
      try {
        if (clipboard && typeof original === 'function') {
          clipboard.writeText = async (text) => {
            captured = String(text || '');
            return original.call(clipboard, text);
          };
        }
        copyButton.click();
        await new Promise((resolve) => setTimeout(resolve, 120));
      } catch (error) {}
      try {
        if (clipboard && typeof original === 'function') clipboard.writeText = original;
      } catch (error) {}
      if (/^[A-Za-z]:[\\/]/.test(captured) || captured.startsWith('/')) return captured.trim();
      try {
        const text = await clipboard.readText();
        if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith('/')) return text.trim();
      } catch (error) {}
    }

    const name = card.querySelector('.text-sm.font-medium.truncate')?.textContent?.trim();
    if (!name) return null;
    return 'C:\\Users\\25350\\.gemini\\antigravity\\builtin\\skills\\' + name + '\\SKILL.md';
  }

  function ensureSkillCards() {
    const modal = document.querySelector('.settings-modal-container');
    if (!modal) return;
    const folderIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 -960 960 960" fill="currentColor"><path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Zm0-80h640v-400H447l-80-80H160v480Zm0 0v-480 480Z"></path></svg>';

    modal.querySelectorAll('.ag-skill-card').forEach((card) => {
      if (card.querySelector('.ag-skill-folder')) return;
      const copyButton = card.querySelector('button[aria-label="Copy path"]');
      const controls = copyButton?.parentElement || card.lastElementChild;
      if (!controls) return;

      const button = make('button', 'ag-skill-folder');
      button.type = 'button';
      button.title = '打开所在文件夹';
      button.setAttribute('aria-label', '打开所在文件夹');
      button.innerHTML = folderIcon;
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        button.disabled = true;
        try {
          const path = await resolveSkillPath(card, copyButton);
          if (!path || !window.electronNative?.revealInFilePicker) {
            showToast('无法确定 Skill 文件夹位置');
            return;
          }
          const uri = 'file:///' + path.replace(/\\/g, '/').replace(/^\/+/, '');
          await window.electronNative.revealInFilePicker(uri);
          showToast('已在文件管理器中显示');
        } catch (error) {
          showToast('打开 Skill 文件夹失败');
        } finally {
          button.disabled = false;
        }
      });

      if (copyButton && copyButton.parentElement) copyButton.after(button);
      else controls.appendChild(button);
    });
  }

  function showWindowMenu(anchor) {
    document.getElementById('ag-window-menu')?.remove();
    const menu = make('div', 'ag-window-menu');
    menu.id = 'ag-window-menu';
    const native = window.electronNative || {};
    const items = [
      { label: '最小化', shortcut: '', action: () => native.minimize?.() },
      { label: '最大化 / 还原', shortcut: '', action: () => { try { if (native.isMaximized?.()) native.unmaximize?.(); else native.maximize?.(); } catch (error) {} } },
      { separator: true },
      { label: '放大', shortcut: 'Ctrl +', action: () => native.zoomIn?.() },
      { label: '缩小', shortcut: 'Ctrl -', action: () => native.zoomOut?.() },
      { label: '重置缩放', shortcut: 'Ctrl 0', action: () => native.resetZoom?.() },
      { label: '开发者工具', shortcut: 'F12', action: () => native.toggleDevTools?.() },
      { separator: true },
      { label: '关闭窗口', shortcut: 'Alt F4', action: () => native.close?.() }
    ];
    items.forEach((item) => {
      if (item.separator) {
        menu.appendChild(make('div', 'ag-menu-sep'));
        return;
      }
      const button = make('button', '');
      button.type = 'button';
      const label = make('span', '', item.label);
      const shortcut = make('span', 'ag-menu-shortcut', item.shortcut || '');
      button.append(label, shortcut);
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        menu.remove();
        try {
          item.action();
        } catch (error) {
          showToast('该窗口操作不可用');
        }
      });
      menu.appendChild(button);
    });

    const rect = anchor.getBoundingClientRect();
    menu.style.left = Math.round(rect.left) + 'px';
    menu.style.top = Math.round(rect.bottom + 3) + 'px';
    document.body.appendChild(menu);

    const close = (event) => {
      if (event.type === 'keydown' && event.key !== 'Escape') return;
      if (event.type === 'pointerdown' && menu.contains(event.target)) return;
      menu.remove();
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', close, true);
    };
    window.setTimeout(() => {
      document.addEventListener('pointerdown', close, true);
      document.addEventListener('keydown', close, true);
    }, 0);
  }

  function ensureWindowMenu() {
    if (window.__agWindowMenuBound) return;
    window.__agWindowMenuBound = true;
    document.addEventListener('click', (event) => {
      const button = event.target.closest?.('[data-testid="title-menu-bar-item"]');
      if (!button || button.innerText.trim() !== 'Window') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      showWindowMenu(button);
    }, true);
  }

  function pathFromEvent(target) {
    let node = target;
    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      const values = [
        node.getAttribute?.('data-path'),
        node.getAttribute?.('data-uri'),
        node.getAttribute?.('href'),
        node.getAttribute?.('title'),
        (node.innerText || '').slice(0, 500)
      ].filter(Boolean);
      for (const value of values) {
        const text = String(value);
        const fileUrl = text.match(/file:\/\/\/?([A-Za-z]:[\\/][^\n\r"'<>]+|\/[^\n\r"'<>]+)/i);
        if (fileUrl) return fileUrl[1].replace(/\//g, '\\');
        const winPath = text.match(/[A-Za-z]:[\\/][^\n\r"'<>|]+?\.[A-Za-z0-9]{1,10}/);
        if (winPath) return winPath[0].replace(/[),.;]+$/, '');
      }
    }
    return null;
  }

  function fileUri(path) {
    return 'file:///' + String(path).replace(/\\/g, '/').replace(/^\/+/, '');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (error) {}
      area.remove();
      return ok;
    }
  }

  async function openFileContextMenu(event, path) {
    const native = window.electronNative;
    if (!native?.showContextMenu) {
      showToast('当前宿主未提供文件菜单');
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    const items = [
      { id: 'open', label: '打开文件' },
      { id: 'reveal', label: '在文件夹中显示' },
      { id: 'copy', label: '复制文件路径' },
      { type: 'separator' },
      { id: 'save-as', label: '另存为...', disabled: true }
    ];
    let selected = null;
    try {
      selected = await native.showContextMenu(items);
    } catch (error) {
      showToast('文件菜单打开失败');
      return;
    }

    if (selected === 'copy') {
      const ok = await copyText(path);
      showToast(ok ? '文件路径已复制' : '复制路径失败');
      return;
    }
    if (selected === 'reveal') {
      try {
        await native.revealInFilePicker(fileUri(path));
        showToast('已在文件管理器中显示');
      } catch (error) {
        showToast('打开文件所在位置失败');
      }
      return;
    }
    if (selected === 'open') {
      const ideUrl = 'antigravity-ide://file/' + path.replace(/\\/g, '/').replace(/^\/+/, '');
      try {
        await native.openExternal(ideUrl);
        showToast('正在打开文件');
      } catch (error) {
        showToast('打开文件失败');
      }
    }
  }

  function ensureFileContextMenu() {
    if (window.__agFileContextMenuBound) return;
    window.__agFileContextMenuBound = true;
    document.addEventListener('contextmenu', (event) => {
      if (event.defaultPrevented) return;
      if (event.target.closest?.('#antigravity\\.agentSidePanelInputBox, [role="menu"], input, textarea')) return;
      const path = pathFromEvent(event.target);
      if (!path) return;
      void openFileContextMenu(event, path);
    }, true);
  }

  function conversationTitle() {
    const raw = document.title || 'Antigravity Conversation';
    return raw.split(' - ')[0].trim() || 'Antigravity Conversation';
  }

  function articleText(article) {
    if (!article) return '';
    const clone = article.cloneNode(true);
    clone.querySelectorAll('button, [role="button"], svg, [data-testid="worked-for-collapsible"]').forEach((node) => node.remove());
    return (clone.innerText || '')
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function conversationArticles(upTo) {
    const all = Array.from(document.querySelectorAll('[role="article"]'))
      .filter((article) => /User message|Agent response/.test(article.getAttribute('aria-label') || ''));
    if (!upTo) return all;
    const index = all.indexOf(upTo);
    return index >= 0 ? all.slice(0, index + 1) : all;
  }

  function buildConversationMarkdown(upTo, forBranch) {
    const title = conversationTitle();
    const articles = conversationArticles(upTo);
    const lines = [];
    lines.push('# ' + title);
    lines.push('');
    lines.push('> 导出时间：' + new Date().toLocaleString('zh-CN'));
    lines.push('');
    lines.push('---');
    lines.push('');
    articles.forEach((article) => {
      const isUser = article.getAttribute('aria-label') === 'User message';
      const text = articleText(article);
      if (!text) return;
      lines.push('## ' + (isUser ? '用户' : 'Antigravity'));
      lines.push('');
      lines.push(text);
      lines.push('');
    });
    if (forBranch) {
      lines.push('---');
      lines.push('');
      lines.push('请基于以上对话上下文继续这个分支。先确认你已经理解上下文，再等待我的下一步指令。');
    }
    return {
      title,
      markdown: lines.join('\n'),
      count: articles.length
    };
  }

  function showToast(message) {
    let toast = document.getElementById('ag-ui-toast');
    if (!toast) {
      toast = make('div', '');
      toast.id = 'ag-ui-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('is-visible');
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove('is-visible'), 2200);
  }

  function downloadConversation(article) {
    const data = buildConversationMarkdown(article, false);
    const safeTitle = data.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    const date = new Date().toISOString().slice(0, 10);
    const blob = new Blob([data.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = date + '-' + safeTitle + '.md';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('对话文档已导出');
  }

  async function attachSnapshotFile(snapshot) {
    if (!snapshot || !snapshot.url) return false;
    let input = null;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const composer = document.getElementById('antigravity.agentSidePanelInputBox');
      input = composer?.querySelector('input[type="file"]') || document.querySelector('input[type="file"]');
      if (input) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!input) return false;
    try {
      const response = await fetch(SIDECAR + snapshot.url, { cache: 'no-store' });
      if (!response.ok) return false;
      const blob = await response.blob();
      const file = new File([blob], snapshot.name || 'branch_snapshot.md', { type: 'text/markdown' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 650));
      return document.querySelectorAll('[data-testid="input-attachment"]').length > 0;
    } catch (error) {
      return false;
    }
  }

  async function branchConversation(article) {
    const data = buildConversationMarkdown(article, true);
    showToast('正在生成分支快照…');
    let snapshot = null;
    try {
      snapshot = await sidecarJson('/api/snapshot', { title: data.title, markdown: data.markdown });
    } catch (error) {
      snapshot = null;
    }

    const newConversation = document.querySelector('[data-testid="new-conversation-button"]');
    if (!newConversation) {
      showToast('未找到新建对话入口');
      return;
    }
    newConversation.click();
    await new Promise((resolve) => setTimeout(resolve, 700));

    if (snapshot) {
      const attached = await attachSnapshotFile(snapshot);
      if (attached) {
        showToast('分支快照已附加 · ' + snapshot.name);
        return;
      }
    }

    const prompt = '基于以下对话创建分支并继续：\n\n' + data.markdown;
    const inserted = insertComposerText(prompt);
    showToast(inserted
      ? (snapshot ? '快照已保存，已回退为文本上下文' : '已在新对话中创建分支上下文')
      : '分支上下文写入失败');
  }

  function actionIcon(kind) {
    if (kind === 'retry') {
      return '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"></path></svg>';
    }
    if (kind === 'branch') {
      return '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 -960 960 960" fill="currentColor"><path d="M240-80q-50 0-85-35t-35-85q0-39 22.5-69.5T200-312v-336q-35-15-57.5-46T120-760q0-50 35-85t85-35q39 0 69.5 22.5T352-800h248q50 0 85 35t35 85q0 50-35 85t-85 35H400q-17 0-28.5 11.5T360-520q0 17 11.5 28.5T400-480h160q50 0 85 35t35 85q0 50-35 85t-85 35H352q-15 35-46 57.5T240-80Zm0-80q17 0 28.5-11.5T280-200q0-17-11.5-28.5T240-240q-17 0-28.5 11.5T200-200q0 17 11.5 28.5T240-160Zm400-360q17 0 28.5-11.5T680-560q0-17-11.5-28.5T640-600q-17 0-28.5 11.5T600-560q0 17 11.5 28.5T640-520ZM240-640q17 0 28.5-11.5T280-680q0-17-11.5-28.5T240-720q-17 0-28.5 11.5T200-680q0 17 11.5 28.5T240-640Z"></path></svg>';
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 -960 960 960" fill="currentColor"><path d="M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z"></path></svg>';
  }

  function cleanPromptText(raw) {
    const kept = String(raw || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) =>
        !/^\d{4}年\d{1,2}月\d{1,2}日(\s+\d{1,2}:\d{2})?$/.test(line) &&
        !/^\d{1,2}月\d{1,2}日(\s+\d{1,2}:\d{2})?$/.test(line) &&
        !/^\d{1,2}:\d{2}$/.test(line) &&
        !/^(今天|昨天|前天)$/.test(line) &&
        !/^\d+\s*[smhd]\s*ago$/i.test(line) &&
        !/^刚刚$/.test(line));
    return kept.join('\n')
      .replace(/\s+\d{4}年\d{1,2}月\d{1,2}日(\s+\d{1,2}:\d{2})?\s*$/, '')
      .replace(/\s+\d{1,2}月\d{1,2}日(\s+\d{1,2}:\d{2})?\s*$/, '')
      .replace(/\s+\d{1,2}:\d{2}\s*$/, '')
      .replace(/\s+\d+\s*[smhd]\s*ago\s*$/i, '')
      .trim();
  }

  function previousUserArticle(article) {
    const articles = Array.from(document.querySelectorAll('[role="article"]'));
    const index = articles.indexOf(article);
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (articles[cursor].getAttribute('aria-label') === 'User message') return articles[cursor];
    }
    return null;
  }

  function turnRootFor(source) {
    let node = source;
    for (let depth = 0; depth < 10 && node; depth += 1, node = node.parentElement) {
      if (node.querySelector?.('[data-testid="user-input-step"]') &&
          node.querySelector?.('[role="article"][aria-label="Agent response"]')) {
        return node;
      }
    }
    return source?.closest?.('[data-turn-content]') || null;
  }

  function menuItemByText(pattern) {
    return Array.from(document.querySelectorAll('[role="menuitem"], [role="menu"] button'))
      .find((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) return false;
        if (el.getAttribute('aria-disabled') === 'true' || el.disabled) return false;
        return pattern.test((el.innerText || '').replace(/\s+/g, ' ').trim());
      }) || null;
  }

  /**
   * 走应用原生的「Undo to Here」：撤回这一轮（提问 + 回复）。
   * 菜单是消息的右键菜单，弹出后再点确认框里的撤销按钮。
   */
  async function undoLastTurn(article) {
    if (!article) return false;
    const rect = article.getBoundingClientRect();
    const x = Math.round(rect.left + Math.min(140, Math.max(24, rect.width / 2)));
    const y = Math.round(Math.min(Math.max(rect.top + 40, 120), window.innerHeight - 140));
    article.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y,
    }));

    let item = null;
    for (let attempt = 0; attempt < 12 && !item; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      item = menuItemByText(/undo to here|撤销到此处/i);
    }
    if (!item) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      return false;
    }
    item.click();

    let confirm = null;
    for (let attempt = 0; attempt < 20 && !confirm; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      confirm = Array.from(document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button'))
        .find((button) => !button.disabled && /^(undo|确认撤销|确认|撤销)$/i.test((button.innerText || '').trim()));
    }
    confirm?.click();
    return true;
  }

  async function retryMessage(source) {
    const turnRoot = turnRootFor(source);
    const step = turnRoot?.querySelector('[data-testid="user-input-step"]');
    let text = cleanPromptText(step?.innerText || '');
    if (!text) {
      const article = source?.closest?.('[role="article"]') || (source?.matches?.('[role="article"]') ? source : null);
      const user = article ? previousUserArticle(article) : null;
      // 只认 user-input-step：退回整段 article 文本会把「2d ago」这类操作栏文字也带进来
      const userStep = user?.querySelector('[data-testid="user-input-step"]');
      text = cleanPromptText(userStep?.innerText || '');
    }
    if (!text) {
      showToast('没找到这条回复对应的提问');
      return;
    }

    // 先撤回这一轮，再重新提问；撤不掉就只填入、不发送，避免重复提问
    const agentArticle = turnRoot?.querySelector('[role="article"][aria-label="Agent response"]')
      || (source?.closest?.('[role="article"]') || null);
    const undone = await undoLastTurn(agentArticle);
    if (!undone) {
      if (!replaceComposerText(text)) {
        showToast('输入框未就绪，稍后再试');
        return;
      }
      showToast('没找到撤回入口，已只填入未发送（避免重复提问）');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));

    if (!replaceComposerText(text)) {
      showToast('已撤回，但输入框未就绪，请手动输入');
      return;
    }
    let send = null;
    for (let attempt = 0; attempt < 18; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      send = document.querySelector('button[aria-label*="Send"], [data-testid="send-button"], button[aria-label*="发送"]');
      if (send && !send.disabled) break;
    }
    if (!send || send.disabled) {
      showToast('已撤回并填入，请手动发送');
      return;
    }
    send.click();
    showToast('已撤回并重新发送');
  }

  function ensureConversationActions() {
    const badButtons = Array.from(document.querySelectorAll('button[aria-label="Bad response"]'));
    badButtons.forEach((bad) => {
      const group = bad.parentElement;
      if (!group) return;
      const article = bad.closest('[role="article"]');

      if (!group.querySelector('.ag-download-conversation')) {
        const download = bad.cloneNode(false);
        download.className = bad.className + ' ag-message-action ag-download-conversation';
        download.removeAttribute('data-tooltip-id');
        download.setAttribute('aria-label', '下载对话文档');
        download.title = '下载对话文档';
        download.innerHTML = actionIcon('download');
        group.appendChild(download);

        const branch = bad.cloneNode(false);
        branch.className = bad.className + ' ag-message-action ag-branch-conversation';
        branch.removeAttribute('data-tooltip-id');
        branch.setAttribute('aria-label', '创建新对话分支');
        branch.title = '创建新对话分支（复制当前上下文）';
        branch.innerHTML = actionIcon('branch');
        group.appendChild(branch);

        download.dataset.agArticleKey = article?.getAttribute('data-message-id') || '';
      }

      if (!group.querySelector('.ag-retry-message')) {
        const retry = bad.cloneNode(false);
        retry.className = bad.className + ' ag-message-action ag-retry-message';
        retry.removeAttribute('data-tooltip-id');
        retry.removeAttribute('disabled');
        retry.setAttribute('aria-label', '重试');
        retry.title = '重试这条回复（重新发送上一条提问）';
        retry.innerHTML = actionIcon('retry');
        bad.after(retry);
      }
    });

    if (!window.__agMessageActionsBound) {
      window.__agMessageActionsBound = true;
      document.addEventListener('click', (event) => {
        const retry = event.target.closest?.('.ag-retry-message');
        if (retry) {
          event.preventDefault();
          event.stopPropagation();
          retryMessage(retry);
          return;
        }
        const download = event.target.closest?.('.ag-download-conversation');
        if (download) {
          event.preventDefault();
          event.stopPropagation();
          downloadConversation(download.closest('[role="article"]'));
          return;
        }
        const branch = event.target.closest?.('.ag-branch-conversation');
        if (branch) {
          event.preventDefault();
          event.stopPropagation();
          branchConversation(branch.closest('[role="article"]'));
        }
      }, true);
    }
  }

  function skillPathFromRow(row) {
    const fiberKey = Object.keys(row).find((key) => key.startsWith('__reactFiber$'));
    if (!fiberKey) return '';
    let fiber = row[fiberKey];
    for (let depth = 0; depth < 18 && fiber; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      const candidates = [props.path, props.skill?.path, props.item?.path, props.data?.path];
      const found = candidates.find((value) => typeof value === 'string' && /[\\/]/.test(value));
      if (found) return found;
    }
    return '';
  }

  async function captureSkillPath(copyButton) {
    let previous = null;
    try {
      previous = await navigator.clipboard.readText();
    } catch (error) {}
    const clipboard = navigator.clipboard;
    const originalWrite = clipboard?.writeText;
    let captured = '';
    if (clipboard && originalWrite) {
      try {
        clipboard.writeText = function (text) {
          captured = text;
          return originalWrite.call(clipboard, text);
        };
      } catch (error) {}
    }
    copyButton.click();
    await new Promise((resolve) => setTimeout(resolve, 180));
    if (clipboard && originalWrite) {
      try { clipboard.writeText = originalWrite; } catch (error) {}
    }
    if (!captured) {
      try { captured = await navigator.clipboard.readText(); } catch (error) {}
    }
    if (previous != null && previous !== captured) {
      try { await navigator.clipboard.writeText(previous); } catch (error) {}
    }
    return String(captured || '').trim();
  }

  function collectSkillPathsFromReact(row) {
    if (window.__agSkillMapCollected || !row) return;
    const copy = row.querySelector('button[aria-label="Copy path"]');
    if (!copy) return;
    const fiberKey = Object.keys(copy).find((key) => key.startsWith('__reactFiber$'));
    if (!fiberKey) return;
    const paths = new Set();
    const seen = new Set();
    const scan = (value, depth) => {
      if (depth > 3 || value == null || seen.has(value)) return;
      if (typeof value === 'string') {
        if (/^[A-Za-z]:[\\/].*SKILL\.md$/i.test(value)) paths.add(value);
        return;
      }
      if (typeof value !== 'object') return;
      seen.add(value);
      try {
        for (const key of Object.keys(value)) {
          if (/^__|^_|children|props|stateNode|return|child|sibling|alternate/i.test(key)) continue;
          scan(value[key], depth + 1);
        }
      } catch (error) {}
    };

    let fiber = copy[fiberKey];
    for (let depth = 0; depth < 10 && fiber; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      for (const key of Object.keys(props)) {
        if (key === 'children') continue;
        scan(props[key], 0);
      }
    }
    if (!paths.size) return;

    const map = window.__AG_SKILL_PATHS || {};
    paths.forEach((fullPath) => {
      const name = fullPath.split(/[\\/]/).slice(-2, -1)[0];
      if (!name) return;
      map[name] = fullPath;
      map[name.toLowerCase()] = fullPath;
      map[name.toLowerCase().replace(/_/g, '-')] = fullPath;
    });
    window.__AG_SKILL_PATHS = map;
    window.__agSkillMapCollected = true;
  }

  function attachConversationDownloadItem(attempt) {
    const menu = [...document.querySelectorAll('[role="menu"]')].find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 100 && rect.height > 30 && /Rename|Pin|Copy|Split|重命名|置顶|复制|拆分/.test(node.innerText);
    });
    if (!menu) {
      if (attempt < 5) window.setTimeout(() => attachConversationDownloadItem(attempt + 1), 80);
      return;
    }
    if (menu.querySelector('.ag-conversation-download')) return;
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    // 用普通菜单项做模板：「复制」是带箭头和 space-between 的二级菜单触发器，
    // 拿它当模板会把新项挤成居中/缩进错位。
    const isPlainItem = (item) => !/space-between/.test(String(item.className)) &&
      !/Alt\+|Ctrl\+/.test(item.innerText || '');
    const template = items.find((item) => isPlainItem(item) && /^(Rename|Pin|重命名|置顶|Mark Unread)/.test(item.innerText.trim()))
      || items.find(isPlainItem)
      || items[0];
    if (!template) return;
    const item = template.cloneNode(false);
    item.classList.add('ag-conversation-download');
    item.setAttribute('role', 'menuitem');
    item.setAttribute('tabindex', '0');
    item.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 -960 960 960" fill="currentColor" class="text-secondary-foreground shrink-0"><path d="M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z"></path></svg><span>下载为 Markdown</span>';
    item.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const target = window.__agConversationDownloadTarget;
      if (!target) {
        showToast('无法确定当前对话');
        return;
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      if (!document.querySelector('[role="article"]')) {
        const row = document.querySelector('[data-testid="conversation-row-sidebar"][data-cascade-id="' + target.id + '"]');
        const link = row?.querySelector('a[href^="/c/"]');
        if (!link) {
          showToast('无法打开当前对话');
          return;
        }
        link.click();
        for (let i = 0; i < 30; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 120));
          if (document.querySelector('[role="article"]')) break;
        }
      }
      if (!document.querySelector('[role="article"]')) {
        showToast('当前对话尚未加载，无法导出');
        return;
      }
      downloadConversation(null);
    });
    const copyItem = items.find((el) => /^(Copy|复制)/.test((el.innerText || '').trim()));
    if (copyItem) copyItem.after(item);
    else template.after(item);
    // 注入的同时就把菜单翻译掉：单靠兜底扫描会晚半秒，看起来像"没变化"
    translateMenuLabels(menu);
  }

  function ensureConversationDownloadButton() {
    document.querySelectorAll('[data-testid="conversation-row-sidebar"]').forEach((row) => {
      if (row.querySelector('.ag-conversation-download-button')) return;
      const kebab = row.querySelector('button[data-testid="conversation-kebab"]');
      if (!kebab) return;
      const button = kebab.cloneNode(false);
      button.className = kebab.className + ' ag-conversation-download-button';
      button.removeAttribute('id');
      button.removeAttribute('data-testid');
      button.removeAttribute('aria-haspopup');
      button.removeAttribute('aria-expanded');
      button.setAttribute('aria-label', '下载');
      button.title = '下载';
      button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 -960 960 960" fill="currentColor"><path d="M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z"></path></svg>';
      kebab.parentElement.insertBefore(button, kebab);
    });

    if (window.__agConversationDownloadButtonBound) return;
    window.__agConversationDownloadButtonBound = true;
    document.addEventListener('click', async (event) => {
      const button = event.target.closest?.('.ag-conversation-download-button');
      if (!button) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const row = button.closest('[data-testid="conversation-row-sidebar"]');
      if (!row) return;
      const selected = row.getAttribute('data-selected') === 'true';
      if (!selected || !document.querySelector('[role="article"]')) {
        const link = row.querySelector('a[href^="/c/"]');
        if (!link) {
          showToast('无法打开当前对话');
          return;
        }
        link.click();
        for (let i = 0; i < 30; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 120));
          if (document.querySelector('[role="article"]')) break;
        }
      }
      if (!document.querySelector('[role="article"]')) {
        showToast('当前对话尚未加载，无法导出');
        return;
      }
      downloadConversation(null);
    }, true);
  }

  // 菜单是后渲染的浮层，只在点击后 400ms 内抓一次会漏（用户看到过英文/缺项的实例）。
  // 这里在每次扫描时兜底：任何可见菜单都补翻译 + 补菜单项。
  const AG_MENU_LABELS = {
    'Rename': '重命名',
    'Pin': '置顶',
    'Unpin': '取消置顶',
    'Mark Unread': '标为未读',
    'Mark Read': '标为已读',
    'Copy': '复制',
    'Split': '拆分',
    'Archive': '归档',
    'Delete': '删除',
    'Copy Project Name': '复制项目名称',
    'Project Settings': '项目设置',
    'Show in File Explorer': '在资源管理器中显示',
    'Delete Project': '删除项目',
  };

  function translateMenuLabels(menu) {
    menu.querySelectorAll('[role="menuitem"]').forEach((item) => {
      item.childNodes.forEach((node) => {
        if (node.nodeType !== 3) return;
        const raw = node.textContent.trim();
        const hit = AG_MENU_LABELS[raw];
        if (hit) node.textContent = node.textContent.replace(raw, hit);
      });
    });
  }

  let agMenuSweepAt = 0;
  function ensureMenuSweep() {
    const now = performance.now();
    if (now - agMenuSweepAt < 120) return;
    const menus = Array.from(document.querySelectorAll('[role="menu"]')).filter((menu) => {
      const rect = menu.getBoundingClientRect();
      return rect.width > 80 && rect.height > 30;
    });
    if (!menus.length) return;
    agMenuSweepAt = now;
    menus.forEach((menu) => {
      translateMenuLabels(menu);
      const looksLikeConversation = /Rename|Pin|Copy|Split|重命名|置顶|复制|拆分/.test(menu.innerText || '');
      if (looksLikeConversation && !menu.querySelector('.ag-conversation-download')) {
        attachConversationDownloadItem(0);
      }
    });
  }

  function ensureConversationDownloadMenu() {
    if (window.__agConversationDownloadBound) return;
    window.__agConversationDownloadBound = true;
    document.addEventListener('click', (event) => {
      const trigger = event.target.closest?.('button[data-testid="conversation-kebab"]');
      if (!trigger) return;
      const row = trigger.closest('[data-testid="conversation-row-sidebar"]');
      if (!row) return;
      window.__agConversationDownloadTarget = {
        id: row.getAttribute('data-cascade-id') || '',
        title: row.querySelector('span')?.textContent?.trim() || '',
        href: row.querySelector('a[href^="/c/"]')?.getAttribute('href') || ''
      };
      window.setTimeout(() => attachConversationDownloadItem(0), 80);
    }, true);
  }

  function attachPluginLocationItem(attempt) {
    const menu = [...document.querySelectorAll('[role="menu"]')].find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 80 && rect.height > 20 && /Disable|Remove|禁用|移除/.test(node.innerText);
    });
    if (!menu) {
      if (attempt < 5) window.setTimeout(() => attachPluginLocationItem(attempt + 1), 80);
      return;
    }
    if (menu.querySelector('.ag-plugin-open-location')) return;
    const template = menu.querySelector('[role="menuitem"]');
    if (!template) return;
    const item = template.cloneNode(false);
    item.classList.add('ag-plugin-open-location');
    item.setAttribute('role', 'menuitem');
    item.setAttribute('tabindex', '0');
    item.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 -960 960 960" fill="currentColor"><path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Zm0-80h640v-400H447l-80-80H160v480Z"></path></svg><span>打开插件位置</span>';
    item.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const pluginId = window.__agPluginMenuId;
      if (!pluginId) {
        showToast('无法确定插件目录');
        return;
      }
      const path = 'C:\\Users\\25350\\.gemini\\config\\plugins\\' + pluginId + '\\plugin.json';
      const uri = 'file:///' + path.replace(/\\/g, '/').replace(/^\/+/, '');
      try {
        window.electronNative?.revealInFilePicker(uri);
        showToast('已打开插件所在位置');
      } catch (error) {
        showToast('打开插件文件夹失败');
      }
    });
    menu.appendChild(item);
  }

  function ensurePluginLocationMenu() {
    if (window.__agPluginLocationBound) return;
    window.__agPluginLocationBound = true;
    document.addEventListener('click', (event) => {
      const trigger = event.target.closest?.('button[aria-label^="More actions for "]');
      if (!trigger) return;
      const card = trigger.closest('[data-testid="customization-card"]');
      const href = card?.querySelector('a[href*="/customizations/plugins/"]')?.getAttribute('href') || '';
      const pluginId = href.split('/').filter(Boolean).pop();
      if (!pluginId) return;
      window.__agPluginMenuId = pluginId;
      window.setTimeout(() => attachPluginLocationItem(0), 80);
    }, true);
  }

  function ensureCustomizationsPage() {
    document.body.classList.toggle('ag-customizations-page', location.pathname.includes('/customizations'));
    ensurePluginLocationMenu();
  }

  function allSkillPathsFromRow(row) {
    const copy = row?.querySelector('button[aria-label="Copy path"]');
    if (!copy) return [];
    const fiberKey = Object.keys(copy).find((key) => key.startsWith('__reactFiber$'));
    if (!fiberKey) return [];
    const paths = new Set();
    const seen = new Set();
    const scan = (value, depth) => {
      if (depth > 3 || value == null || seen.has(value)) return;
      if (typeof value === 'string') {
        if (/^[A-Za-z]:[\\/].*SKILL\.md$/i.test(value)) paths.add(value);
        return;
      }
      if (typeof value !== 'object') return;
      seen.add(value);
      try {
        for (const key of Object.keys(value)) {
          if (/^__|^_|children|props|stateNode|return|child|sibling|alternate/i.test(key)) continue;
          scan(value[key], depth + 1);
        }
      } catch (error) {}
    };
    let fiber = copy[fiberKey];
    for (let depth = 0; depth < 12 && fiber; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      for (const key of Object.keys(props)) {
        if (key === 'children') continue;
        scan(props[key], 0);
      }
    }
    return Array.from(paths);
  }

  function enhanceSkillCards() {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!dialog) return;
    const heading = [...dialog.querySelectorAll('h2, h3, h4')].find((node) => {
      const text = node.textContent.replace(/\s+/g, '').trim();
      // 汉化后标题会变成「技能 79」，只认英文会让整段增强直接失效（只剩复制按钮）
      return /^(Skills|技能)/.test(text) || text === '系统核心技能' || text === '系统核心技能集' || text.startsWith('系统核心技能');
    });
    if (!heading) return;
    const section = heading.closest('.space-y-2') || heading.parentElement?.parentElement?.parentElement;
    if (!section) return;
    const container = [...section.querySelectorAll('.border.rounded-xl.overflow-hidden')]
      .find((node) => node.querySelector('button[aria-label="Copy path"]'));
    if (!container) return;

    container.classList.add('ag-skill-grid');
    if (!section.querySelector('.ag-skill-search')) {
      const box = document.createElement('div');
      box.className = 'ag-skill-search';
      box.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor"><path d="M784-120 532-372q-30 24-69 38t-83 14q-109 0-184.5-75.5T120-580q0-109 75.5-184.5T380-840q109 0 184.5 75.5T640-580q0 44-14 83t-38 69l252 252-56 56ZM380-400q75 0 127.5-52.5T560-580q0-75-52.5-127.5T380-760q-75 0-127.5 52.5T200-580q0 75 52.5 127.5T380-400Z"/></svg><input type="text" placeholder="搜索技能（名称或描述）" aria-label="搜索技能" />';
      container.parentElement.insertBefore(box, container);
      const input = box.querySelector('input');
      input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        let shown = 0;
        container.querySelectorAll('.ag-skill-card').forEach((card) => {
          const hit = !q || (card.innerText || '').toLowerCase().includes(q);
          card.style.display = hit ? '' : 'none';
          if (hit) shown += 1;
        });
        box.dataset.empty = shown ? '' : '1';
      });
    }
    collectSkillPathsFromReact(container.querySelector('.ag-skill-card') || container.querySelector(':scope > .group'));
    container.querySelectorAll(':scope > .group').forEach((row) => {
      row.classList.add('ag-skill-card');
      const copy = row.querySelector('button[aria-label="Copy path"]');
      if (!copy || row.querySelector('.ag-skill-folder')) return;
      const folder = copy.cloneNode(false);
      folder.className = copy.className + ' ag-skill-folder';
      folder.removeAttribute('data-tooltip-id');
      folder.setAttribute('aria-label', 'Open folder');
      folder.title = '打开文件夹位置';
      folder.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 -960 960 960" fill="currentColor"><path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640H447l-80-80H160v480l96-320h684L837-217q-8 26-29.5 41.5T760-160H160Zm84-80h516l72-240H316l-72 240ZM316-440Zm-60-200Z"></path></svg>';
      copy.after(folder);
    });

    if (window.__agSkillFolderBound) return;
    window.__agSkillFolderBound = true;
    document.addEventListener('click', async (event) => {
      const folder = event.target.closest?.('.ag-skill-folder');
      if (!folder) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const row = folder.closest('.ag-skill-card');
      const copy = row?.querySelector('button[aria-label="Copy path"]');
      const skillName = row?.querySelector('.text-sm.font-medium.truncate')?.textContent?.trim() || '';
      let path = row ? skillPathFromRow(row) : '';
      if (!path && copy) path = await captureSkillPath(copy);
      if (!path && skillName) {
        const normalize = (value) => String(value || '').toLowerCase().replace(/_/g, '-');
        const wanted = normalize(skillName);
        path = allSkillPathsFromRow(row).find((candidate) => {
          const folder = candidate.split(/[\\/]/).slice(-2, -1)[0];
          return normalize(folder) === wanted;
        }) || '';
      }
      if (!path && skillName) {
        const key = skillName.toLowerCase().replace(/_/g, '-');
        path = window.__AG_SKILL_PATHS?.[skillName] ||
          window.__AG_SKILL_PATHS?.[skillName.toLowerCase()] ||
          window.__AG_SKILL_PATHS?.[key] || '';
      }
      if (!path) {
        showToast('无法读取技能路径');
        return;
      }
      const uri = path.startsWith('file://')
        ? path
        : 'file:///' + path.replace(/\\/g, '/').replace(/^\/+/, '');
      try {
        await window.electronNative?.revealInFilePicker(uri);
        showToast('已打开技能所在位置');
      } catch (error) {
        showToast('打开文件夹失败');
      }
    }, true);
  }

  function installSectionTransitions() {
    if (window.__agSectionTransitionBound) return;
    window.__agSectionTransitionBound = true;
    document.addEventListener('click', (event) => {
      if (window.__agSectionTransitionBypass) return;
      const button = event.target.closest?.('.bg-sidebar [data-testid="section-header"] h2 > button[aria-expanded]');
      if (!button || typeof document.startViewTransition !== 'function') return;
      const section = button.closest('[data-testid="section-header"]')?.parentElement;
      if (!section) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      section.style.viewTransitionName = 'ag-section-motion';
      window.__agSectionTransitionBypass = true;

      const transition = document.startViewTransition(async () => {
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 80));
      });

      const finish = () => {
        section.style.viewTransitionName = '';
        window.__agSectionTransitionBypass = false;
      };
      transition.finished.then(finish).catch(finish);
    }, true);
  }

  function projectTransitionTarget(button) {
    return button.closest('.flex-1.min-h-0.overflow-y-auto') ||
      button.closest('.overflow-y-auto') ||
      button.closest('.bg-sidebar');
  }

  function installProjectTransitions() {
    if (window.__agProjectTransitionBound) return;
    window.__agProjectTransitionBound = true;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    document.addEventListener('click', (event) => {
      if (window.__agProjectTransitionBypass) return;
      const button = event.target.closest?.('.bg-sidebar [data-testid="project-header"][aria-expanded]');
      if (!button || typeof document.startViewTransition !== 'function' || reduceMotion.matches) return;
      const target = projectTransitionTarget(button);
      if (!target || window.__agProjectViewTransitioning) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      window.__agProjectViewTransitioning = true;
      target.style.viewTransitionName = 'ag-project-motion';
      window.__agProjectTransitionBypass = true;

      const transition = document.startViewTransition(async () => {
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 110));
      });

      const finish = () => {
        target.style.viewTransitionName = '';
        window.__agProjectTransitionBypass = false;
        window.__agProjectViewTransitioning = false;
      };
      transition.finished.then(finish).catch(finish);
    }, true);
  }

  function sidecarJson(path, body) {
    return fetch(SIDECAR + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + response.status));
      return data;
    });
  }

  function minimapTurns() {
    return Array.from(document.querySelectorAll('[data-testid="conversation-navigator-turn"]'));
  }

  function minimapDotTop(map, index, total) {
    const trackTop = 30;
    // Cached height keeps this layout-free; ensureChatMinimap refreshes it whenever it reads the viewport.
    const trackHeight = Math.max(40, (Number(map.dataset.trackHeight) || 0) - trackTop - 10);
    return trackTop + ((index + 0.5) / Math.max(1, total)) * trackHeight;
  }

  function minimapPreview(turn, index) {
    const raw = String(turn?.dataset.agPreview || '').replace(/\s+/g, ' ').trim();
    return raw || ('第 ' + (index + 1) + ' 轮');
  }

  function closeMinimapList() {
    const list = document.getElementById('ag-minimap-list');
    if (list) list.classList.remove('is-visible');
    const head = document.querySelector('#ag-chat-minimap .ag-minimap-head');
    if (head) {
      head.classList.remove('is-open');
      head.setAttribute('aria-expanded', 'false');
    }
  }

  function positionMinimapList() {
    const map = document.getElementById('ag-chat-minimap');
    const list = document.getElementById('ag-minimap-list');
    if (!map || !list) return;
    // Cached rail box keeps an open picker from forcing a layout on every scan.
    const left = Number(map.dataset.trackLeft);
    const top = Number(map.dataset.trackTop);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return;
    list.style.left = Math.max(8, left - 298) + 'px';
    list.style.top = Math.max(8, top) + 'px';
    list.style.maxHeight = Math.max(180, Math.min(620, window.innerHeight - Math.max(8, top) - 16)) + 'px';
  }

  function renderMinimapList(turns, activeIndex) {
    const list = document.getElementById('ag-minimap-list');
    if (!list) return;
    const sig = turns.length + '|' + activeIndex + '|' + turns.map((turn) => turn.dataset.agPreview || '').join('|');
    if (list.dataset.sig !== sig) {
      list.dataset.sig = sig;
      list.innerHTML = '<div class="ag-minimap-list-head"><strong>对话选择</strong><span>' + turns.length + ' 轮</span></div>' +
        turns.map((turn, index) => {
          const label = minimapPreview(turn, index);
          return '<button type="button" class="ag-minimap-item ' + (index === activeIndex ? 'is-current' : '') + '" data-index="' + index + '">' +
            '<span class="ag-minimap-item-index">' + (index + 1) + '</span>' +
            '<span class="ag-minimap-item-text">' + escapeHtml(label) + '</span>' +
            '</button>';
        }).join('');
      list.querySelectorAll('.ag-minimap-item').forEach((item) => {
        item.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const index = Number(item.dataset.index);
          const currentTurns = minimapTurns();
          currentTurns[index]?.click();
          closeMinimapList();
        });
      });
    } else {
      list.querySelectorAll('.ag-minimap-item').forEach((item, index) => {
        item.classList.toggle('is-current', index === activeIndex);
      });
    }
  }

  // innerText forces layout, so previews are captured lazily — only for a turn the user is looking at.
  function fillTurnPreview(turn) {
    if (!turn || turn.dataset.agPreview) return;
    const step = turn.querySelector('[data-testid="user-input-step"]');
    const text = cleanPromptText((step || turn).innerText || '').slice(0, 220);
    if (text) turn.dataset.agPreview = text;
  }

  function updateMinimapTurnActive(turns, map) {
    const activeIndex = turns.findIndex((turn) => turn.getAttribute('aria-current') === 'true' || turn.getAttribute('data-active') === 'true');
    if (map.dataset.activeTurn !== String(activeIndex) || map.dataset.turnCount !== String(turns.length)) {
      map.dataset.activeTurn = String(activeIndex);
      map.dataset.turnCount = String(turns.length);
      map.querySelectorAll('.ag-minimap-dot').forEach((dot, index) => dot.classList.toggle('is-current', index === activeIndex));
      const head = map.querySelector('.ag-minimap-head');
      if (head) {
        head.textContent = activeIndex >= 0 ? String(activeIndex + 1) : '☰';
        head.title = '对话选择（' + (activeIndex >= 0 ? (activeIndex + 1) + ' / ' + turns.length : turns.length + ' 轮') + '）';
      }
    }

    const thumb = map.querySelector('.ag-minimap-thumb');
    if (thumb) {
      if (activeIndex >= 0) {
        const top = minimapDotTop(map, activeIndex, turns.length) + 'px';
        if (thumb.style.top !== top) thumb.style.top = top;
        if (thumb.style.display !== 'block') thumb.style.display = 'block';
      } else if (thumb.style.display !== 'none') {
        thumb.style.display = 'none';
      }
    }

    // The picker list and its previews are only worth building while it is actually open.
    const list = document.getElementById('ag-minimap-list');
    if (list?.classList.contains('is-visible')) {
      fillTurnPreview(turns[activeIndex]);
      renderMinimapList(turns, activeIndex);
    }
  }

  function showMinimapTip(dot, turn, tip) {
    fillTurnPreview(turn);
    const label = turn.getAttribute('aria-label') || ('Turn ' + (Number(dot.dataset.index) + 1));
    const preview = turn.dataset.agPreview || '';
    tip.innerHTML = '<strong>' + escapeHtml(label) + '</strong><p>' + escapeHtml(preview || '点击跳转到该轮对话') + '</p>';
    const rect = dot.getBoundingClientRect();
    tip.style.left = Math.max(8, rect.left - 246) + 'px';
    tip.style.top = Math.max(8, Math.min(window.innerHeight - 110, rect.top - 10)) + 'px';
    tip.classList.add('is-visible');
  }

  const MINIMAP_OVERLAY_SELECTORS = [
    '#ag-memory-page.is-open',
    '.settings-modal-container',
    '.settings-modal-backdrop',
    '[data-testid="artifact-view"]',
    '[role="dialog"][aria-modal="true"]'
  ];

  /** The minimap is a chat-only rail; it must not leak through overlays or the right pane. */
  function chatMinimapCovered() {
    // Existence check first: a plain chat has none of these, so the hot path pays no style/layout at all.
    const candidates = [];
    for (const selector of MINIMAP_OVERLAY_SELECTORS) {
      const found = document.querySelector(selector);
      if (found) candidates.push(found);
    }
    if (!candidates.length) return false;
    // checkVisibility with contentVisibilityAuto disabled reads style, not layout.
    return candidates.some((el) => (typeof el.checkVisibility === 'function'
      ? el.checkVisibility({ contentVisibilityAuto: false, opacity: true, visibility: true })
      : Number(getComputedStyle(el).opacity) > 0));
  }

  function ensureChatMinimap() {
    const turns = minimapTurns();
    const viewport = document.querySelector('[data-testid="autoscroll-viewport"]');
    const content = document.querySelector('[data-testid="turn-cards-container"]');
    const map = document.getElementById('ag-chat-minimap');
    const tip = document.getElementById('ag-minimap-preview');
    if (chatMinimapCovered() || turns.length < 2 || !viewport) {
      map?.classList.remove('is-visible');
      tip?.classList.remove('is-visible');
      closeMinimapList();
      return;
    }

    let node = map;
    if (!node) {
      node = document.createElement('div');
      node.id = 'ag-chat-minimap';
      document.body.appendChild(node);
    }
    let preview = tip;
    if (!preview) {
      preview = document.createElement('div');
      preview.id = 'ag-minimap-preview';
      preview.className = 'ag-minimap-preview';
      document.body.appendChild(preview);
    }
    let list = document.getElementById('ag-minimap-list');
    if (!list) {
      list = document.createElement('div');
      list.id = 'ag-minimap-list';
      list.className = 'ag-minimap-list';
      document.body.appendChild(list);
    }

    let head = node.querySelector('.ag-minimap-head');
    if (!head) {
      head = document.createElement('button');
      head.type = 'button';
      head.className = 'ag-minimap-head';
      head.textContent = '☰';
      head.setAttribute('aria-label', '打开对话选择');
      head.setAttribute('aria-expanded', 'false');
      head.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (list.classList.contains('is-visible')) {
          closeMinimapList();
          return;
        }
        positionMinimapList();
        list.classList.add('is-visible');
        head.classList.add('is-open');
        head.setAttribute('aria-expanded', 'true');
        updateMinimapTurnActive(minimapTurns(), node);
      });
      node.appendChild(head);
    }
    let thumb = node.querySelector('.ag-minimap-thumb');
    if (!thumb) {
      thumb = document.createElement('span');
      thumb.className = 'ag-minimap-thumb';
      node.appendChild(thumb);
    }

    // Geometry reads force a full relayout of Antigravity's deep document (~45ms each), so the rail
    // re-measures only when something could have moved it; a 2.5s safety net catches manual pane drags.
    // 右侧面板展开/收起是逐帧动画：ResizeObserver 会在每一帧后触发，强制刷新一次几何，轨道才跟手。
    const now = performance.now();
    const sinceGeom = node.dataset.geomAt ? now - Number(node.dataset.geomAt) : Infinity;
    const sizeKey = window.innerWidth + 'x' + window.innerHeight + ':' + turns.length;
    const forceGeom = node.dataset.geomForce === '1';
    if (forceGeom) node.dataset.geomForce = '';
    if (forceGeom || (sinceGeom > 500 && (node.dataset.sizeKey !== sizeKey || sinceGeom > 2500))) {
      const rect = viewport.getBoundingClientRect();
      const contentRect = content ? content.getBoundingClientRect() : null;
      const measured = Math.max(140, rect.height - 24);
      // 优先不压住消息内容：复制/点赞那排图标比内容容器还宽出一截，
      // 所以直接量一下操作行的右边缘，按真实边界让位；内容窄时仍贴视口右缘。
      let contentRight = contentRect ? contentRect.right : 0;
      if (contentRect) {
        const actions = document.querySelector('[role="article"] [aria-label="Bad response"]')?.parentElement;
        const actionsRect = actions ? actions.getBoundingClientRect() : null;
        if (actionsRect && actionsRect.width > 0) contentRight = Math.max(contentRight, actionsRect.right);
      }
      const left = contentRect
        ? Math.round(Math.min(rect.right - 22, Math.max(rect.right - 26, contentRight + 9)))
        : Math.round(rect.right - 22);
      node.dataset.geomAt = String(Math.round(now));
      node.dataset.sizeKey = sizeKey;
      node.dataset.trackHeight = String(Math.round(measured));
      node.dataset.trackLeft = String(left);
      node.dataset.trackTop = String(Math.round(rect.top + 12));
      node.style.left = left + 'px';
      node.style.top = Math.round(rect.top + 12) + 'px';
      node.style.height = measured + 'px';
    }
    if (!viewport.__agMinimapResizeBound && typeof ResizeObserver === 'function') {
      viewport.__agMinimapResizeBound = true;
      // ResizeObserver 回调发生在布局之后，直接重算即可；
      // 不要再包 requestAnimationFrame —— 窗口不产帧时 rAF 是冻结的，轨道会一直不跟。
      const reflow = () => {
        const live = document.getElementById('ag-chat-minimap');
        if (!live) return;
        live.dataset.geomForce = '1';
        ensureChatMinimap();
      };
      const observer = new ResizeObserver(reflow);
      observer.observe(viewport);
      if (content) observer.observe(content);
      viewport.__agMinimapResizeObserver = observer;
    }
    node.classList.add('is-visible');

    const height = Number(node.dataset.trackHeight) || 140;
    const left = Number(node.dataset.trackLeft) || 0;
    const signature = turns.length + ':' + height + ':' + left;
    if (node.dataset.signature !== signature) {
      node.dataset.signature = signature;
      node.querySelectorAll('.ag-minimap-dot').forEach((dot) => dot.remove());
      turns.forEach((turn, index) => {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'ag-minimap-dot';
        dot.textContent = String(index + 1);
        dot.dataset.index = String(index);
        dot.style.top = minimapDotTop(node, index, turns.length) + 'px';
        dot.setAttribute('aria-label', turn.getAttribute('aria-label') || ('跳转到第 ' + (index + 1) + ' 轮'));
        dot.addEventListener('mouseenter', () => showMinimapTip(dot, turn, preview));
        dot.addEventListener('focus', () => showMinimapTip(dot, turn, preview));
        dot.addEventListener('mouseleave', () => preview.classList.remove('is-visible'));
        dot.addEventListener('blur', () => preview.classList.remove('is-visible'));
        dot.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          turn.click();
          closeMinimapList();
        });
        node.appendChild(dot);
      });
    }

    if (!node.__agMinimapTrackBound) {
      node.__agMinimapTrackBound = true;
      node.addEventListener('click', (event) => {
        if (event.target.closest('.ag-minimap-dot, .ag-minimap-head')) return;
        const currentTurns = minimapTurns();
        if (!currentTurns.length) return;
        const radius = node.getBoundingClientRect();
        const trackTop = 30;
        const trackHeight = Math.max(1, radius.height - trackTop - 10);
        const ratio = Math.max(0, Math.min(1, (event.clientY - radius.top - trackTop) / trackHeight));
        const index = Math.max(0, Math.min(currentTurns.length - 1, Math.floor(ratio * currentTurns.length)));
        currentTurns[index]?.click();
        closeMinimapList();
      });
    }

    if (!window.__agMinimapListBound) {
      window.__agMinimapListBound = true;
      document.addEventListener('click', (event) => {
        if (event.target.closest?.('#ag-chat-minimap, #ag-minimap-list')) return;
        closeMinimapList();
      }, true);
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeMinimapList();
      });
      window.addEventListener('resize', () => {
        const rail = document.getElementById('ag-chat-minimap');
        if (rail) rail.dataset.geomAt = '';
        const current = document.getElementById('ag-minimap-list');
        if (current?.classList.contains('is-visible')) positionMinimapList();
      }, { passive: true });
    }

    if (!viewport.__agMinimapScrollBound) {
      viewport.__agMinimapScrollBound = true;
      let scheduled = false;
      viewport.addEventListener('scroll', () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          const currentMap = document.getElementById('ag-chat-minimap');
          if (currentMap) updateMinimapTurnActive(minimapTurns(), currentMap);
        });
      }, { passive: true });
    }

    updateMinimapTurnActive(turns, node);
    if (list.classList.contains('is-visible')) positionMinimapList();
  }

  function ensureGlobalStarfield() {
    let layer = document.getElementById('ag-global-stars');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'ag-global-stars';
      layer.setAttribute('aria-hidden', 'true');
      let seed = 431;
      const rand = () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647;
      };
      const stars = [];
      for (let index = 0; index < 10; index += 1) {
        const sparkle = index % 4 === 0;
        const left = 2 + rand() * 96;
        const top = 2 + rand() * 92;
        const size = (sparkle ? (6.5 + rand() * 4.5) : (2.5 + rand() * 4)).toFixed(1);
        const delay = (-rand() * 12).toFixed(2);
        const duration = (6 + rand() * 7).toFixed(1);
        const peak = (sparkle ? (0.32 + rand() * 0.22) : (0.2 + rand() * 0.3)).toFixed(2);
        stars.push('<i' + (sparkle ? ' class="is-sparkle"' : '') + ' style="left:' + left.toFixed(2) + '%;top:' + top.toFixed(2) + '%;width:' + size + 'px;height:' + size + 'px;--delay:' + delay + 's;--dur:' + duration + 's;--peak:' + peak + '"></i>');
      }
      [
        { left: 3.5, top: 5, size: 9 },
        { left: 96, top: 8, size: 8 },
        { left: 94, top: 20, size: 7 },
        { left: 4, top: 88, size: 8 },
        { left: 92, top: 82, size: 9 },
        { left: 36, top: 4, size: 7 },
        { left: 68, top: 5, size: 6 },
        { left: 60, top: 90, size: 7 }
      ].forEach((star) => {
        stars.push('<i class="is-sparkle is-bright" style="left:' + star.left + '%;top:' + star.top + '%;width:' + star.size + 'px;height:' + star.size + 'px;--delay:-' + (2 + Math.random() * 6).toFixed(2) + 's;--dur:' + (7 + Math.random() * 5).toFixed(1) + 's;--peak:' + (0.5 + Math.random() * 0.22).toFixed(2) + '"></i>');
      });
      layer.innerHTML = stars.join('');
      document.body.appendChild(layer);
    } else if (layer.parentElement !== document.body) {
      document.body.appendChild(layer);
    }
  }

  let starCosmosEngine = null;

  function ensureStarCosmos() {
    let canvas = document.getElementById('ag-star-cosmos');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'ag-star-cosmos';
      canvas.setAttribute('aria-hidden', 'true');
      document.body.appendChild(canvas);
    }
    if (!starCosmosEngine || starCosmosEngine.canvas !== canvas) {
      starCosmosEngine = createStarCosmos(canvas);
    }
    starCosmosEngine.sync();
  }

  function createStarCosmos(canvas) {
    const ctx = canvas.getContext('2d');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let width = 0;
    let height = 0;
    let dpr = 1;
    let raf = 0;
    let last = 0;
    let lastDraw = 0;
    let lastMeteor = 0;
    let meteors = [];
    let bursts = [];
    const orbit = Array.from({ length: 7 }, (_, index) => ({
      base: (index / 7) * Math.PI * 2,
      speed: 0.22 + (index % 3) * 0.035,
      size: 0.8 + (index % 4) * 0.12
    }));
    const state = { mode: 'orbit-meteor', intensity: 0.85, frequency: 0.6 };

    function config() {
      return Object.assign({ mode: 'orbit-meteor', intensity: 0.85, frequency: 0.6 }, window.__AG_STAR_CONFIG || {});
    }

    let composerBox = null;
    let composerBoxAt = 0;

    function composerRect(now) {
      // drawOrbit runs every animation frame and a rect read can force a full relayout,
      // so the composer box is cached and only re-measured twice a second.
      if (composerBoxAt && now - composerBoxAt < 500) return composerBox;
      composerBoxAt = now;
      const node = document.getElementById('antigravity.agentSidePanelInputBox') ||
        document.querySelector('.surface-composer') ||
        document.querySelector('[data-testid="composer"]');
      if (!node) {
        composerBox = null;
        return null;
      }
      const rect = node.getBoundingClientRect();
      composerBox = rect.width > 80 && rect.height > 20
        ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
        : null;
      return composerBox;
    }

    function resize() {
      dpr = Math.min(1, window.devicePixelRatio || 1);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      composerBoxAt = 0;
    }

    function drawStar(x, y, radius, rotation, alpha, color) {
      if (radius < 0.4) return;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rotation || 0);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color || '#F6D893';
      ctx.shadowColor = 'rgba(246,216,147,.8)';
      ctx.shadowBlur = radius * 1.8;
      ctx.beginPath();
      for (let index = 0; index < 10; index += 1) {
        const angle = -Math.PI / 2 + (index * Math.PI) / 5;
        const r = index % 2 === 0 ? radius : radius * 0.44;
        const px = Math.cos(angle) * r;
        const py = Math.sin(angle) * r;
        if (index === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(0.6, radius * 0.18);
      ctx.strokeStyle = color || '#F6D893';
      ctx.stroke();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = alpha * 0.6;
      ctx.fillStyle = 'rgba(255,255,255,.75)';
      ctx.beginPath();
      ctx.ellipse(-radius * 0.18, -radius * 0.22, radius * 0.22, radius * 0.13, -0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    function spawnMeteor() {
      const fromLeft = Math.random() > 0.5;
      const speed = 420 + Math.random() * 180;
      const angle = (fromLeft ? 0.4 : Math.PI - 0.4) + (Math.random() - 0.5) * 0.2;
      meteors.push({
        x: fromLeft ? -40 : width + 40,
        y: height * (0.08 + Math.random() * 0.3),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        max: 1.7 + Math.random() * 0.7,
        size: 4 + Math.random() * 3
      });
      if (meteors.length > 3) meteors.shift();
    }

    function spawnBurst(x, y) {
      const count = Math.round(10 + state.intensity * 10);
      for (let index = 0; index < count; index += 1) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 40 + Math.random() * 160;
        bursts.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 30,
          life: 0,
          max: 0.6 + Math.random() * 0.4,
          size: 2 + Math.random() * 3
        });
      }
    }

    function drawOrbit(now) {
      if (state.mode !== 'orbit-meteor') return;
      const rect = composerRect(now);
      if (!rect) return;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const rx = Math.max(rect.width * 0.58, 210);
      const ry = Math.max(rect.height * 0.9 + 24, 56);
      const tilt = -0.18;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(tilt);
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx.setLineDash([2, 10]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(246,216,147,.10)';
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      const back = [];
      const front = [];
      orbit.forEach((star, index) => {
        const angle = star.base + now * 0.00022 * star.speed * 1.7;
        const s = Math.sin(angle);
        const item = {
          x: cx + Math.cos(angle) * rx,
          y: cy + s * ry,
          rot: angle + tilt,
          size: (4 + (index % 3) * 1.3) * (0.8 + state.intensity * 0.5) * star.size
        };
        (s < 0 ? back : front).push(item);
      });
      back.forEach((star) => {
        if (star.x > rect.left + 4 && star.x < rect.right - 4 && star.y > rect.top + 4 && star.y < rect.bottom - 4) return;
        drawStar(star.x, star.y, star.size * 0.62, star.rot, 0.30 + state.intensity * 0.24);
      });
      front.forEach((star) => drawStar(star.x, star.y, star.size * 1.12, star.rot, 0.45 + state.intensity * 0.4));
      const charmAlpha = 0.28 + state.intensity * 0.35;
      const bob = Math.sin(now / 900) * 3;
      drawStar(rect.right - 12, rect.top - 16 + bob, 6 + state.intensity * 3, 0.2, charmAlpha);
      drawStar(rect.left + 12, rect.bottom + 14 - bob, 5 + state.intensity * 2.5, -0.3, charmAlpha * 0.85);
    }

    function drawMeteors(dt) {
      if (!['orbit-meteor', 'meteor-stars'].includes(state.mode)) return;
      for (let index = meteors.length - 1; index >= 0; index -= 1) {
        const meteor = meteors[index];
        meteor.life += dt;
        meteor.x += meteor.vx * dt;
        meteor.y += meteor.vy * dt;
        if (meteor.life > meteor.max || meteor.x < -120 || meteor.x > width + 120 || meteor.y > height + 120) {
          meteors.splice(index, 1);
          continue;
        }
        const progress = meteor.life / meteor.max;
        const alpha = Math.sin(Math.min(1, progress) * Math.PI) * (0.5 + state.intensity * 0.4);
        const tailX = meteor.x - meteor.vx * 0.16;
        const tailY = meteor.y - meteor.vy * 0.16;
        const gradient = ctx.createLinearGradient(tailX, tailY, meteor.x, meteor.y);
        gradient.addColorStop(0, 'rgba(246,216,147,0)');
        gradient.addColorStop(0.65, 'rgba(246,216,147,.18)');
        gradient.addColorStop(1, 'rgba(255,240,190,.7)');
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = gradient;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(tailX, tailY);
        ctx.lineTo(meteor.x, meteor.y);
        ctx.stroke();
        ctx.restore();
        drawStar(meteor.x, meteor.y, meteor.size * (0.8 + state.intensity * 0.4), 0.3, alpha);
      }
    }

    function drawBursts(dt) {
      for (let index = bursts.length - 1; index >= 0; index -= 1) {
        const particle = bursts[index];
        particle.life += dt;
        if (particle.life > particle.max) {
          bursts.splice(index, 1);
          continue;
        }
        particle.vy += 120 * dt;
        particle.x += particle.vx * dt;
        particle.y += particle.vy * dt;
        const alpha = 1 - particle.life / particle.max;
        drawStar(particle.x, particle.y, particle.size * (0.7 + alpha * 0.6), particle.life * 4, alpha * 0.9);
      }
    }

    function frame(now) {
      raf = 0;
      if (document.hidden || window.__agUiDisabled || state.mode === 'off' || state.mode === 'minimal') return;
      if (now - lastDraw < 40) {
        raf = requestAnimationFrame(frame);
        return;
      }
      lastDraw = now;
      const dt = Math.min(0.05, Math.max(0.001, (now - (last || now)) / 1000));
      last = now;
      ctx.clearRect(0, 0, width, height);
      const interval = 14000 - state.frequency * 8500;
      if (now - lastMeteor > interval && meteors.length < 2) {
        lastMeteor = now;
        spawnMeteor();
        if (state.frequency > 0.75 && Math.random() > 0.6) spawnMeteor();
      }
      drawMeteors(dt);
      drawOrbit(now);
      drawBursts(dt);
      raf = requestAnimationFrame(frame);
    }

    function stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      ctx.clearRect(0, 0, width, height);
    }

    function sync() {
      const next = config();
      state.mode = next.mode || 'orbit-meteor';
      state.intensity = Math.max(0, Math.min(1, Number(next.intensity) || 0));
      state.frequency = Math.max(0, Math.min(1, Number(next.frequency) || 0));
      document.documentElement.classList.toggle('ag-stars-off', state.mode === 'off');
      const active = !document.hidden && !window.__agUiDisabled && state.mode !== 'off' && state.mode !== 'minimal' && !reduceMotion.matches;
      canvas.style.display = state.mode === 'off' || state.mode === 'minimal' ? 'none' : '';
      if (active) {
        if (!raf) {
          last = 0;
          lastDraw = 0;
          lastMeteor = performance.now() - 4000;
          raf = requestAnimationFrame(frame);
        }
      } else {
        stop();
      }
    }

    window.__agUpdateStarCosmos = sync;
    resize();
    window.addEventListener('resize', resize, { passive: true });
    document.addEventListener('visibilitychange', sync);
    document.addEventListener('click', (event) => {
      const send = event.target.closest?.('[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="发送"]');
      if (!send) return;
      const rect = send.getBoundingClientRect();
      spawnBurst(rect.left + rect.width / 2, rect.top + rect.height / 2);
    }, true);
    return { sync, canvas };
  }

  let promptStickyBound = false;
  let promptStickyRaf = 0;

  function updatePromptStuck() {
    const enabled = document.documentElement.classList.contains('ag-prompt-sticky');
    const wrappers = document.querySelectorAll('.sticky.top-0.z-10');
    wrappers.forEach((el) => {
      if (!el.querySelector('[data-testid="user-input-step"]')) return;
      const viewport = el.closest('[data-testid="autoscroll-viewport"]');
      const viewportTop = viewport ? viewport.getBoundingClientRect().top : 0;
      if (!enabled) {
        el.classList.remove('ag-prompt-stuck');
        el.removeAttribute('data-ag-prompt-preview');
        return;
      }
      const rect = el.getBoundingClientRect();
      const stuck = rect.top <= viewportTop + 1 && rect.bottom > viewportTop + 8;
      if (!stuck) {
        el.classList.remove('ag-prompt-stuck');
        return;
      }
      if (!el.classList.contains('ag-prompt-stuck')) {
        const raw = (el.querySelector('[data-testid="user-input-step"]')?.innerText || '').replace(/\s+/g, ' ').trim();
        const preview = raw.replace(/ZIP\s+\S+/gi, '').replace(/\s+/g, ' ').trim().slice(0, 120) || '当前提问';
        el.setAttribute('data-ag-prompt-preview', preview);
        el.classList.add('ag-prompt-stuck');
      }
    });
  }

  function schedulePromptStuck() {
    if (promptStickyRaf) return;
    promptStickyRaf = requestAnimationFrame(() => {
      promptStickyRaf = 0;
      updatePromptStuck();
    });
  }

  function ensurePromptStickyMode() {
    window.__agUpdatePromptSticky = updatePromptStuck;
    if (!promptStickyBound) {
      promptStickyBound = true;
      document.addEventListener('scroll', schedulePromptStuck, true);
      window.addEventListener('resize', schedulePromptStuck, { passive: true });
    }
    updatePromptStuck();
  }

  let effortSwitching = false;
  let effortDragging = false;

  function reopenModelMenu() {
    let attempts = 0;
    const tick = () => {
      const trigger = getModelTrigger();
      if (!trigger) return;
      if (trigger.getAttribute('aria-expanded') === 'true') return;
      trigger.click();
      attempts += 1;
      if (attempts < 3) window.setTimeout(tick, 240);
    };
    window.setTimeout(tick, 280);
  }

  async function switchEffort(level) {
    if (effortSwitching) return;
    const current = modelBaseFromTrigger();
    if (!current) {
      showToast('未识别当前模型');
      return;
    }
    if (current.effort === level) return;
    const isMenuOpen = () => getVisibleMenus().some((menu) => menu.querySelector('[data-testid="model-selector-panel"]'));
    const menuWasOpen = isMenuOpen();
    const pill = document.getElementById('ag-effort-pill');
    effortSwitching = true;
    pill?.classList.add('is-applying');
    if (!menuWasOpen) document.documentElement.classList.add('ag-cloak-model-menu');
    document.documentElement.classList.add('ag-effort-switching');
    const cloakTimer = window.setTimeout(() => {
      document.documentElement.classList.remove('ag-cloak-model-menu');
    }, 6000);
    try {
      const trigger = getModelTrigger();
      if (trigger && !isMenuOpen()) {
        trigger.click();
        for (let attempt = 0; attempt < 24 && !isMenuOpen(); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      }
      const success = await applyEffort(level, current.base);
      if (!success) {
        showToast('切换思考强度失败');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 260));
      if (!menuWasOpen) closeModelMenu();
      await new Promise((resolve) => setTimeout(resolve, 100));
      showToast('思考强度 · ' + EFFORT_LABELS[level]);
    } finally {
      window.clearTimeout(cloakTimer);
      if (!menuWasOpen) closeModelMenu();
      else reopenModelMenu();
      document.documentElement.classList.remove('ag-cloak-model-menu');
      document.documentElement.classList.remove('ag-effort-switching');
      if (!menuWasOpen) getModelTrigger()?.blur();
      effortSwitching = false;
      pill?.classList.remove('is-applying');
      stopEffortSpring(pill);
      ensureEffortPill();
    }
  }

  function effortSliderMarkup(info) {
    return [
      '<span class="ag-effort-kicker">思考</span>',
      '<span class="ag-effort-track" role="slider" tabindex="0" aria-label="思考强度" aria-valuemin="0" aria-valuemax="2" aria-valuenow="' + info.index + '" aria-valuetext="' + EFFORT_LABELS[info.effort] + '" style="--pos:' + (info.index / 2) + '">',
      '<span class="ag-effort-rail"></span>',
      '<span class="ag-effort-fill"></span>',
      '<span class="ag-effort-ticks"><i></i><i></i><i></i></span>',
      '<span class="ag-effort-thumb"></span>',
      '</span>',
      '<span class="ag-effort-value">' + EFFORT_LABELS[info.effort] + '</span>'
    ].join('');
  }

  function setEffortVisual(pill, pos) {
    const track = pill?.querySelector('.ag-effort-track');
    if (!track) return 0;
    const clamped = Math.max(0, Math.min(1, Number(pos) || 0));
    track.style.setProperty('--pos', String(clamped));
    const levelIndex = Math.max(0, Math.min(2, Math.round(clamped * 2)));
    const value = pill.querySelector('.ag-effort-value');
    if (value) value.textContent = EFFORT_LABELS[EFFORTS[levelIndex]];
    track.setAttribute('aria-valuenow', String(levelIndex));
    track.setAttribute('aria-valuetext', EFFORT_LABELS[EFFORTS[levelIndex]]);
    track.dataset.level = String(levelIndex);
    return levelIndex;
  }

  function stopEffortSpring(pill) {
    if (!pill) return;
    if (pill.__agPosRaf) {
      cancelAnimationFrame(pill.__agPosRaf);
      pill.__agPosRaf = 0;
    }
    window.clearTimeout(pill.__agSpringWatchdog);
    pill.__agSpringWatchdog = 0;
    pill.__agEffortSpringing = false;
  }

  function animateEffortTo(pill, targetPos) {
    const track = pill?.querySelector('.ag-effort-track');
    if (!track) return;
    stopEffortSpring(pill);
    let pos = parseFloat(track.style.getPropertyValue('--pos'));
    if (!Number.isFinite(pos)) pos = targetPos;
    if (Math.abs(pos - targetPos) < 0.004) {
      setEffortVisual(pill, targetPos);
      return;
    }
    let velocity = 0;
    let last = performance.now();
    const stiffness = 420;
    const damping = 32;
    pill.__agEffortSpringing = true;
    pill.__agSpringWatchdog = window.setTimeout(() => {
      if (!pill.__agEffortSpringing) return;
      stopEffortSpring(pill);
      ensureEffortPill();
    }, 1400);
    const tick = (now) => {
      const dt = Math.min(0.032, Math.max(0.001, (now - last) / 1000));
      last = now;
      const force = -stiffness * (pos - targetPos) - damping * velocity;
      velocity += force * dt;
      pos += velocity * dt;
      if (pos < 0) {
        pos = 0;
        if (velocity < 0) velocity = 0;
      } else if (pos > 1) {
        pos = 1;
        if (velocity > 0) velocity = 0;
      }
      if (Math.abs(pos - targetPos) < 0.0008 && Math.abs(velocity) < 0.02) {
        setEffortVisual(pill, targetPos);
        stopEffortSpring(pill);
        pill.__agPosRaf = 0;
        return;
      }
      setEffortVisual(pill, pos);
      pill.__agPosRaf = requestAnimationFrame(tick);
    };
    pill.__agPosRaf = requestAnimationFrame(tick);
  }

  function setEffortSliderVisual(pill, index) {
    animateEffortTo(pill, index / 2);
  }

  function bindEffortSlider(pill) {
    const track = pill.querySelector('.ag-effort-track');
    if (!track) return;
    let activePointer = null;

    const updateTravel = () => {
      const width = track.getBoundingClientRect().width;
      track.style.setProperty('--track-travel', Math.max(0, width - 10) + 'px');
    };
    updateTravel();
    if (typeof ResizeObserver === 'function') {
      pill.__agTrackResizeObserver = new ResizeObserver(updateTravel);
      pill.__agTrackResizeObserver.observe(track);
    }

    const updateFromPointer = (event) => {
      const rect = track.getBoundingClientRect();
      if (!rect.width) return 0;
      const pad = 5;
      const travel = Math.max(1, rect.width - pad * 2);
      const pos = Math.max(0, Math.min(1, (event.clientX - rect.left - pad) / travel));
      setEffortVisual(pill, pos);
      return pos;
    };

    track.addEventListener('pointerdown', (event) => {
      if (typeof event.button === 'number' && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      activePointer = event.pointerId;
      effortDragging = true;
      stopEffortSpring(pill);
      updateTravel();
      track.classList.add('is-dragging');
      try { track.setPointerCapture(activePointer); } catch (error) {}
      try { track.focus({ preventScroll: true }); } catch (error) {}
      updateFromPointer(event);
    });

    track.addEventListener('pointermove', (event) => {
      if (!effortDragging || activePointer !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      updateFromPointer(event);
    });

    const finish = (event) => {
      if (!effortDragging) return;
      event.stopPropagation();
      effortDragging = false;
      if (activePointer !== null) {
        try { track.releasePointerCapture(activePointer); } catch (error) {}
        activePointer = null;
      }
      const currentPos = parseFloat(track.style.getPropertyValue('--pos')) || 0;
      const index = Math.max(0, Math.min(2, Math.round(currentPos * 2)));
      track.classList.remove('is-dragging');
      animateEffortTo(pill, index / 2);
      const current = modelBaseFromTrigger();
      if (current && current.effort !== EFFORTS[index]) {
        switchEffort(EFFORTS[index]).catch(() => {});
      }
    };

    track.addEventListener('pointerup', finish);
    track.addEventListener('pointercancel', finish);
    track.addEventListener('click', (event) => event.stopPropagation());

    track.addEventListener('keydown', (event) => {
      const currentIndex = Number(track.getAttribute('aria-valuenow') || 2);
      let next = currentIndex;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = currentIndex - 1;
      else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = currentIndex + 1;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = 2;
      else return;
      event.preventDefault();
      event.stopPropagation();
      next = Math.max(0, Math.min(2, next));
      setEffortSliderVisual(pill, next);
      if (modelBaseFromTrigger()?.effort !== EFFORTS[next]) {
        switchEffort(EFFORTS[next]).catch(() => {});
      }
    });
  }

  function stabilizeEffortTriggerWidth(info) {
    const trigger = getModelTrigger();
    if (!trigger || !info) return;
    if (trigger.__agEffortBase === info.base) return;
    trigger.__agEffortBase = info.base;
    trigger.style.minWidth = '';
    let maxWidth = 0;
    let currentWidth = 0;
    try {
      const style = getComputedStyle(trigger);
      const canvas = window.__agEffortMeasureCanvas || (window.__agEffortMeasureCanvas = document.createElement('canvas'));
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.font = [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].join(' ');
      maxWidth = Math.max.apply(null, EFFORTS.map((effort) => ctx.measureText(info.base + ' ' + effort).width));
      currentWidth = ctx.measureText(info.base + ' ' + info.effort).width;
    } catch (error) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const target = Math.ceil(rect.width + Math.max(0, maxWidth - currentWidth));
    if (target > 0) trigger.style.minWidth = target + 'px';
  }

  function ensureEffortPill() {
    const trigger = getModelTrigger();
    const existing = document.getElementById('ag-effort-pill');
    if (!trigger) {
      existing?.remove();
      return;
    }
    const info = modelBaseFromTrigger();
    if (!info) {
      existing?.remove();
      return;
    }
    stabilizeEffortTriggerWidth(info);
    let pill = existing;
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'ag-effort-pill';
    }
    if (!pill.querySelector('.ag-effort-track')) {
      pill.innerHTML = effortSliderMarkup(info);
    }
    if (!pill.__agSmoothBound) {
      pill.__agSmoothBound = true;
      bindEffortSlider(pill);
      pill.addEventListener('pointerdown', (event) => event.stopPropagation());
    }
    const host = trigger.closest('.no-focus-agent-input') || trigger.parentElement;
    if (host && pill.previousElementSibling !== host) host.after(pill);
    if (pill.__agEffortSpringing && !pill.__agPosRaf) pill.__agEffortSpringing = false;
    if (!effortSwitching && !effortDragging && !pill.__agEffortSpringing) setEffortSliderVisual(pill, info.index);
    pill.title = '思考强度：拖动切换（低 / 中 / 高），Alt+1/2/3 快捷键';
  }

  let immersiveBound = false;

  function ensureImmersiveToggle() {
    let button = document.getElementById('ag-immersive-toggle');
    if (!button) {
      button = document.createElement('button');
      button.id = 'ag-immersive-toggle';
      button.type = 'button';
      button.title = '沉浸观星 (Alt+Z)';
      button.setAttribute('aria-label', '切换沉浸观星模式');
      button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 -960 960 960" fill="currentColor"><path d="M480-280q-73 0-127.5-45.5T284-440q0-11 2-21t6-20q-40-4-68-33.5T196-584q0-48 34-82t82-34h336q48 0 82 34t34 82q0 48-34 82t-82 34q-6 0-11-.5t-10-1.5q4 10 6 20t2 21q0 55-54.5 100.5T480-280Z"></path></svg>';
      document.body.appendChild(button);
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleImmersive();
      });
    }
    const anchor = document.querySelector('#ag-starlight-launch') || document.querySelector('[data-testid="titlebar-more-actions"]');
    const host = anchor?.parentElement;
    if (host && button.parentElement !== host) host.insertBefore(button, anchor);
    if (immersiveBound) return;
    immersiveBound = true;
    document.addEventListener('keydown', (event) => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && (event.code === 'KeyZ' || event.key.toLowerCase() === 'z')) {
        event.preventDefault();
        event.stopPropagation();
        toggleImmersive();
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey && /^Digit[1-3]$/.test(event.code)) {
        event.preventDefault();
        event.stopPropagation();
        const index = Number(event.code.slice(-1)) - 1;
        const pill = document.getElementById('ag-effort-pill');
        if (pill) setEffortSliderVisual(pill, index);
        switchEffort(EFFORTS[index]).catch(() => {});
      }
    }, true);
    document.addEventListener('pointerover', (event) => {
      if (!document.documentElement.classList.contains('ag-immersive')) return;
      const insideUi = event.target.closest?.('.bg-sidebar, #antigravity.agentSidePanelInputBox');
      document.documentElement.classList.toggle('ag-immersive-awake', Boolean(insideUi));
    }, { passive: true });
  }

  function toggleImmersive() {
    const root = document.documentElement;
    const next = !root.classList.contains('ag-immersive');
    root.classList.toggle('ag-immersive', next);
    if (!next) root.classList.remove('ag-immersive-awake');
    showToast(next ? '沉浸观星已开启 · Alt+Z 退出' : '已退出沉浸观星');
  }

  let questAudio = null;

  function playQuestChime() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!questAudio) questAudio = new Ctx();
      const ctx = questAudio;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const now = ctx.currentTime;
      [880, 1174.66, 1567.98].forEach((freq, index) => {
        const start = now + index * 0.07;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.028, start + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.25);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 1.35);
      });
    } catch (error) {}
  }

  function showQuestBanner(elapsed) {
    let banner = document.getElementById('ag-quest-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'ag-quest-banner';
      document.body.appendChild(banner);
    }
    const seconds = Math.max(1, Math.round(elapsed / 1000));
    banner.innerHTML = '<span class="ag-quest-star">✦</span><span>星轨推演完成</span><span class="ag-quest-sub">Quest Complete · ' + seconds + 's</span>';
    banner.classList.add('is-visible');
    window.clearTimeout(showQuestBanner.timer);
    showQuestBanner.timer = window.setTimeout(() => banner.classList.remove('is-visible'), 3600);
    playQuestChime();
  }

  function installQuestMonitor() {
    if (window.__agQuestMonitor) return;
    window.__agQuestMonitor = true;
    let questStart = 0;
    let questFired = false;
    window.__agQuestTimer = window.setInterval(() => {
      if (window.__agUiDisabled) return;
      const stopButton = Array.from(document.querySelectorAll('[aria-label="Stop execution"], [data-testid*="stop-execution"], button[aria-label*="Stop"]'))
        .find((node) => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
      if (stopButton) {
        if (!questStart) {
          questStart = Date.now();
          questFired = false;
        }
        return;
      }
      if (!questStart) return;
      const elapsed = Date.now() - questStart;
      questStart = 0;
      if (!questFired && elapsed >= 8000 && !document.hidden) {
        questFired = true;
        showQuestBanner(elapsed);
      }
    }, 700);
  }

  function scan() {
    if (window.__agUiDisabled) return;
    scanCount += 1;
    ensureUsagePanel();
    ensurePluginPicker();
    ensurePromptPresets();
    ensureConversationActions();
    ensureSidebarHandle();
    ensureWindowMenu();
    ensureFileContextMenu();
    ensureCustomizationsPage();
    ensureConversationDownloadMenu();
    ensureConversationDownloadButton();
    ensureMenuSweep();
    enhanceSkillCards();
    installSectionTransitions();
    installProjectTransitions();
    installEffortMenuGuard();
    ensureModelEffort();
    ensureChatMinimap();
    ensureGlobalStarfield();
    ensureStarCosmos();
    ensurePromptStickyMode();
    ensureEffortPill();
    ensureImmersiveToggle();
    installQuestMonitor();
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = window.setTimeout(() => {
      scanTimer = 0;
      scan();
    }, 240);
  }

  function shouldIgnoreMutation(mutation) {
    const target = mutation.target;
    if (!target) return false;
    const element = target.nodeType === 1 ? target : target.parentElement;
    if (!element) return false;
    if (document.documentElement.classList.contains('ag-attachment-reordering')) return true;
    if (element.closest('.ag-attachment-ghost, [data-testid="input-attachment"]')) return true;
    if (element.closest('[data-markdown-root]')) return true;
    if (element.closest('[contenteditable="true"]')) return true;
    if (element.closest('#ag-chat-minimap, #ag-minimap-preview, #ag-minimap-list, .ag-minimap-head, .ag-minimap-thumb, #ag-quest-banner, #ag-effort-pill, #ag-immersive-toggle, #ag-ui-toast, .ag-usage-strip, .ag-skill-star, .ag-plugin-tab, .ag-plugin-empty')) return true;
    return false;
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (!shouldIgnoreMutation(mutation)) {
        scheduleScan();
        return;
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  window.addEventListener('resize', scheduleScan, { passive: true });

  window.__agExtendedUiRefresh = scan;
  window.__agPerf = { scans: () => scanCount };
  scan();
  hydratePromptPresets();
  window.setTimeout(scan, 300);
  window.setTimeout(scan, 1200);
  const maintenanceTimer = window.setInterval(() => {
    if (window.__agUiDisabled) return;
    ensureUsagePanel();
    ensurePluginPicker();
    ensurePromptPresets();
    ensureConversationActions();
    ensureSidebarHandle();
    ensureWindowMenu();
    ensureFileContextMenu();
    ensureCustomizationsPage();
    ensureConversationDownloadMenu();
    ensureConversationDownloadButton();
    enhanceSkillCards();
    ensureChatMinimap();
    ensureGlobalStarfield();
    ensureStarCosmos();
    ensurePromptStickyMode();
    ensureEffortPill();
    const panel = document.getElementById('ag-usage-panel');
    if (panel) renderUsage(panel);
    loadUsage(false);
  }, 30000);

  window.__agUiPause = () => {
    window.__agUiDisabled = true;
  };
  window.__agUiDispose = window.__agUiPause;
})();
