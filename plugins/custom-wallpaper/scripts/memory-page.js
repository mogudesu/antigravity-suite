(() => {
  'use strict';

  if (window.__agMemoryPageInstalled) {
    if (typeof window.__agEnsureMemoryPage === 'function') window.__agEnsureMemoryPage();
    return;
  }
  window.__agMemoryPageInstalled = '1.0.0';

  const SIDECAR = 'http://127.0.0.1:' + (window.__AG_SIDECAR_PORT || 39290);
  const FILES = [
    {
      key: 'persona',
      name: 'PERSONA.md',
      title: 'AI 人设',
      desc: '身份、语气、工程品味与边界，每次会话固定注入',
      icon: 'spark',
      placeholder: '定义 AI 的名字、角色设定、沟通语气与禁忌'
    },
    {
      key: 'user',
      name: 'USER.md',
      title: '用户画像',
      desc: '稳定的偏好、习惯与技术栈，占用每轮上下文',
      icon: 'user',
      placeholder: '技术栈、习惯、审美偏好，以及对回答方式的要求'
    },
    {
      key: 'memory',
      name: 'MEMORY.md',
      title: '工作记忆',
      desc: '当前项目、决策与约束，保持短而新',
      icon: 'pin',
      placeholder: '跨项目关键架构约定、进行中的决定与长期目标'
    }
  ];

  const ICONS = {
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.4 13.8 8l4.6.35-3.5 3 1.1 4.55L12 13.3l-4 2.6 1.1-4.55-3.5-3L10.2 8 12 3.4Z"/><path d="M12 13.3v7.1"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.2"/><path d="M5.5 20c.55-3.5 3.1-5.4 6.5-5.4s5.95 1.9 6.5 5.4"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4.5h8v5l1.8 2.2v1.4H6.2v-1.4L8 9.5v-5Z"/><path d="M12 13.2v6.3"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5 8 12l6.5 6.5"/></svg>',
    drive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5.5" width="17" height="6" rx="2"/><rect x="3.5" y="12.5" width="17" height="6" rx="2"/><path d="M7 8.5h.01M7 15.5h.01"/></svg>',
    nav: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="4"/><path d="M9 2.8v2.2M15 2.8v2.2M9 19v2.2M15 19v2.2M2.8 9h2.2M2.8 15h2.2M19 9h2.2M19 15h2.2"/><path d="m12 8.5.8 2.1 2.2.1-1.7 1.35.6 2.15L12 12.9l-1.9 1.3.6-2.15L9 10.7l2.2-.1.8-2.1Z"/></svg>'
  };

  const state = {
    open: false,
    openedAt: '',
    loading: false,
    active: 'persona',
    values: null,
    saved: null,
    status: null,
    items: [],
    candidates: [],
    candidateBusy: false,
    query: '',
    lastDirty: false
  };

  const refs = {};
  const lifecycle = typeof AbortController === 'function' ? new AbortController() : null;
  let overlay = null;
  let tickTimer = 0;

  function make(tag, className, html) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html != null) node.innerHTML = html;
    return node;
  }

  function memoryIsEn() {
    return String((window.__AG_CONFIG || {}).language || 'zh-CN').toLowerCase() === 'en';
  }

  function memoryText(zh, en) {
    return memoryIsEn() ? en : zh;
  }

  function activeFile() {
    return FILES.find((file) => file.key === state.active) || FILES[0];
  }

  function isDirty() {
    if (!state.values || !state.saved) return false;
    return FILES.some((file) => (state.values[file.key] || '') !== (state.saved[file.key] || ''));
  }

  function dirtyKeys() {
    if (!state.values || !state.saved) return [];
    return FILES.filter((file) => (state.values[file.key] || '') !== (state.saved[file.key] || '')).map((file) => file.key);
  }

  function formatBytes(size) {
    const value = Number(size) || 0;
    if (value < 1024) return value + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
    return (value / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }

  function setStatus(message, kind) {
    if (!refs.status) return;
    refs.status.textContent = message || '';
    refs.status.className = 'ag-memory-status' + (kind ? ' ' + kind : '');
  }

  function updateButtons() {
    if (refs.save) refs.save.disabled = state.loading || !state.values || !isDirty();
    if (refs.refresh) refs.refresh.disabled = state.loading;
    if (refs.backup) refs.backup.disabled = state.loading;
  }

  async function api(path, options) {
    const attempts = options?.method ? 1 : 2;
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 12000);
      try {
        const request = Object.assign({ cache: 'no-store', signal: controller.signal }, options || {});
        if (request.body) {
          request.headers = Object.assign({ 'Content-Type': 'application/json' }, request.headers || {});
        }
        const response = await fetch(SIDECAR + path, request);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return await response.json();
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await new Promise((resolve) => window.setTimeout(resolve, 220));
      } finally {
        window.clearTimeout(timer);
      }
    }
    throw lastError || new Error('request failed');
  }

  function buildOverlay() {
    if (overlay) return;
    overlay = make('div', '');
    overlay.id = 'ag-memory-page';
    overlay.setAttribute('role', 'region');
    overlay.setAttribute('aria-label', '记忆管理');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = [
      '<div class="ag-memory-shell">',
      '<header class="ag-memory-head">',
      '<button type="button" class="ag-memory-back" data-mem-back aria-label="返回对话" title="返回对话（Esc）">' + ICONS.arrow + '</button>',
      '<div class="ag-memory-title">',
      '<div class="ag-memory-kicker">MNEMON · LAYERED MEMORY</div>',
      '<h1>记忆管理</h1>',
      '<p class="ag-memory-sub">固定人设、用户画像与工作记忆；长期事实归档到记忆空间。</p>',
      '</div>',
      '<div class="ag-memory-actions">',
      '<button type="button" class="ag-memory-btn" data-mem-refresh>刷新</button>',
      '<button type="button" class="ag-memory-btn" data-mem-backup>备份</button>',
      '<button type="button" class="ag-memory-btn primary" data-mem-save disabled>保存更改</button>',
      '</div>',
      '</header>',
      '<div class="ag-memory-body">',
      '<aside class="ag-memory-side">',
      '<section class="ag-memory-card">',
      '<h2>常驻记忆层</h2>',
      '<div class="ag-memory-files" data-mem-files></div>',
      '</section>',
      '<section class="ag-memory-card">',
      '<h2>存储与快照</h2>',
      '<div class="ag-memory-vault" data-mem-vault></div>',
      '<div class="ag-memory-chips" data-mem-chips></div>',
      '<div class="ag-memory-snapshot" data-mem-snapshot>尚未读取快照</div>',
      '</section>',
      '<section class="ag-memory-card ag-memory-candidates-card">',
      '<div class="ag-memory-card-head"><h2>待拍板候选</h2><span class="ag-memory-count" data-mem-cand-count>0</span></div>',
      '<div class="ag-memory-candidates" data-mem-candidates></div>',
      '</section>',
      '<section class="ag-memory-card ag-memory-items-card">',
      '<div class="ag-memory-card-head"><h2>记忆空间</h2><span class="ag-memory-count" data-mem-count>0</span></div>',
      '<input type="text" class="ag-memory-search" data-mem-search placeholder="筛选记忆..." aria-label="筛选记忆">',
      '<div class="ag-memory-items" data-mem-items></div>',
      '</section>',
      '</aside>',
      '<section class="ag-memory-editor">',
      '<div class="ag-memory-editor-head">',
      '<div class="ag-memory-editor-file"><span class="ag-memory-editor-dot"></span><span class="ag-memory-editor-name" data-mem-file>PERSONA.md</span><span class="ag-memory-editor-meta" data-mem-meta>尚未读取</span></div>',
      '<span class="ag-memory-editor-desc" data-mem-desc></span>',
      '</div>',
      '<textarea class="ag-memory-textarea" data-mem-textarea spellcheck="false" disabled placeholder="正在读取 mnemon 记忆..."></textarea>',
      '<footer class="ag-memory-editor-foot">',
      '<span class="ag-memory-status" data-mem-status>正在读取 mnemon 记忆...</span>',
      '<span class="ag-memory-tip">Ctrl+S 保存 · 自动同步镜像</span>',
      '</footer>',
      '</section>',
      '</div>',
      '</div>'
    ].join('');
    document.body.appendChild(overlay);

    refs.back = overlay.querySelector('[data-mem-back]');
    refs.refresh = overlay.querySelector('[data-mem-refresh]');
    refs.backup = overlay.querySelector('[data-mem-backup]');
    refs.save = overlay.querySelector('[data-mem-save]');
    refs.files = overlay.querySelector('[data-mem-files]');
    refs.vault = overlay.querySelector('[data-mem-vault]');
    refs.chips = overlay.querySelector('[data-mem-chips]');
    refs.snapshot = overlay.querySelector('[data-mem-snapshot]');
    refs.candidates = overlay.querySelector('[data-mem-candidates]');
    refs.candCount = overlay.querySelector('[data-mem-cand-count]');
    refs.items = overlay.querySelector('[data-mem-items]');
    refs.count = overlay.querySelector('[data-mem-count]');
    refs.search = overlay.querySelector('[data-mem-search]');
    refs.file = overlay.querySelector('[data-mem-file]');
    refs.meta = overlay.querySelector('[data-mem-meta]');
    refs.desc = overlay.querySelector('[data-mem-desc]');
    refs.textarea = overlay.querySelector('[data-mem-textarea]');
    refs.status = overlay.querySelector('[data-mem-status]');

    refs.back.addEventListener('click', closePage);
    refs.refresh.addEventListener('click', () => refresh(true));
    refs.backup.addEventListener('click', backup);
    refs.save.addEventListener('click', save);
    refs.search.addEventListener('input', () => {
      state.query = refs.search.value;
      renderItems();
    });
    refs.textarea.addEventListener('input', onEditorInput);
    refs.vault.addEventListener('click', (event) => {
      const row = event.target.closest?.('.ag-memory-vault-row');
      if (row && row.dataset.path) copyPath(row.dataset.path);
    });
    refs.items.addEventListener('click', (event) => {
      if (event.target.closest?.('[data-mem-close]')) closePage();
    });
    refs.candidates.addEventListener('click', (event) => {
      const button = event.target.closest?.('[data-cand-action]');
      if (!button || state.candidateBusy) return;
      resolveCandidate(button.dataset.candAction, button.dataset.candId, button);
    });

    positionOverlay();
  }

  function positionOverlay() {
    if (!overlay) return;
    const navLink = document.querySelector('.bg-sidebar a[href="/customizations"]');
    const sidebar = navLink?.closest('.bg-sidebar') ||
      Array.from(document.querySelectorAll('.bg-sidebar')).find((node) => node.getBoundingClientRect().height > 200);
    const rect = sidebar?.getBoundingClientRect();
    if (rect && rect.width > 0) {
      overlay.style.left = Math.round(rect.right) + 'px';
      overlay.style.top = Math.round(rect.top) + 'px';
      return;
    }
    const shell = document.querySelector('.flex-1.flex.min-h-0.relative');
    const shellRect = shell?.getBoundingClientRect();
    overlay.style.left = Math.max(0, Math.round(shellRect?.left || 0)) + 'px';
    overlay.style.top = Math.max(0, Math.round(shellRect?.top || 0)) + 'px';
  }

  function fileMeta(file) {
    const runtime = state.status?.runtime?.[file.name];
    if (!runtime || !runtime.exists) return '尚未创建';
    const parts = [formatBytes(runtime.size)];
    if (runtime.updated) parts.push(runtime.updated);
    return parts.join(' · ');
  }

  function renderFiles() {
    if (!refs.files) return;
    refs.files.textContent = '';
    FILES.forEach((file) => {
      const button = make('button', 'ag-memory-file');
      button.type = 'button';
      button.dataset.fileKey = file.key;
      button.title = file.name + ' · ' + file.desc;
      button.innerHTML = [
        '<span class="ag-memory-file-glyph">' + ICONS[file.icon] + '</span>',
        '<span class="ag-memory-file-main"><span class="ag-memory-file-name"></span><span class="ag-memory-file-meta"></span></span>',
        '<span class="ag-memory-file-state"></span>'
      ].join('');
      button.querySelector('.ag-memory-file-name').textContent = file.name;
      button.querySelector('.ag-memory-file-meta').textContent = fileMeta(file);
      button.classList.toggle('is-active', file.key === state.active);
      button.classList.toggle('is-dirty', dirtyKeys().includes(file.key));
      button.addEventListener('click', () => selectFile(file.key));
      refs.files.appendChild(button);
    });
  }

  function renderEditor() {
    if (!refs.textarea) return;
    const file = activeFile();
    const runtime = state.status?.runtime?.[file.name];
    refs.file.textContent = file.name;
    refs.meta.textContent = [file.title, runtime?.updated || '', state.values ? ((state.values[file.key] || '').length + ' 字符') : '']
      .filter(Boolean)
      .join(' · ');
    refs.desc.textContent = file.desc;
    refs.textarea.placeholder = state.values ? file.placeholder : '正在读取 mnemon 记忆...';
    refs.textarea.disabled = !state.values || state.loading;
    if (state.values) refs.textarea.value = state.values[file.key] || '';
    updateButtons();
  }

  function renderVault() {
    if (!refs.vault) return;
    refs.vault.textContent = '';
    const status = state.status;
    const rows = status ? [
      { label: '主库 VAULT', path: status.vault || '', ok: status.vaultExists },
      { label: '镜像 MIRROR', path: status.mirror || '', ok: status.mirrorExists }
    ] : [{ label: '记忆引擎', path: '尚未连接 mnemon 侧车', ok: false }];
    rows.forEach((row) => {
      const node = make('div', 'ag-memory-vault-row');
      node.dataset.path = row.path;
      node.title = row.path ? row.path + '（点击复制）' : '';
      node.innerHTML = [
        '<span class="ag-memory-vault-icon">' + ICONS.drive + '</span>',
        '<span class="ag-memory-vault-main"><span class="ag-memory-vault-label"></span><span class="ag-memory-vault-path"></span></span>'
      ].join('');
      node.querySelector('.ag-memory-vault-label').textContent = row.label;
      node.querySelector('.ag-memory-vault-path').textContent = row.path || '—';
      refs.vault.appendChild(node);
    });

    refs.chips.textContent = '';
    if (status) {
      const addChip = (text, kind) => {
        const chip = make('span', 'ag-memory-chip' + (kind ? ' ' + kind : ''), '');
        chip.textContent = text;
        refs.chips.appendChild(chip);
      };
      addChip(status.vaultExists ? '主库在线' : '主库缺失', status.vaultExists ? 'ok' : 'warn');
      addChip(status.mirrorExists ? '镜像在线' : '镜像缺失', status.mirrorExists ? 'ok' : 'warn');
      addChip((status.snapshotCount || 0) + ' 份快照');
    }

    refs.snapshot.textContent = '';
    if (!status) {
      refs.snapshot.textContent = '记忆引擎尚未就绪';
      return;
    }
    const latest = Array.isArray(status.snapshots) && status.snapshots.length ? status.snapshots[0] : '';
    refs.snapshot.textContent = latest ? '最近快照 · ' : '暂无快照 · 点击「备份」生成';
    if (latest) {
      const strong = document.createElement('strong');
      strong.textContent = latest;
      refs.snapshot.appendChild(strong);
    }
  }

  function itemText(item) {
    const value = item?.text || item?.content || item?.summary || item?.title || item?.note;
    if (typeof value === 'string') return value;
    if (value != null) return String(value);
    return '';
  }

  function renderCandidates() {
    if (!refs.candidates) return;
    const list = Array.isArray(state.candidates) ? state.candidates : [];
    refs.candCount.textContent = String(list.length);
    refs.candidates.textContent = '';
    if (!list.length) {
      const empty = make('div', 'ag-memory-candidates-empty');
      empty.innerHTML = '<strong>' + memoryText('暂无待拍板候选', 'No pending candidates') + '</strong>' +
        '<span>' + memoryText('自动捕获会先入队，采纳后才写入', 'Auto-capture queues first; nothing is stored until adopted') + '</span>';
      refs.candidates.appendChild(empty);
      return;
    }
    list.slice(0, 30).forEach((candidate) => {
      const node = make('div', 'ag-memory-candidate');
      const meta = make('div', 'ag-memory-candidate-meta');
      const source = make('span', '', '');
      source.textContent = candidate?.source === 'auto-capture'
        ? memoryText('自动捕获', 'Auto-captured')
        : memoryText('手动候选', 'Manual');
      const time = make('span', '', '');
      time.textContent = formatTime(candidate?.createdAt);
      meta.appendChild(source);
      meta.appendChild(time);
      node.appendChild(meta);

      const text = make('div', 'ag-memory-candidate-text', '');
      text.textContent = String(candidate?.text || '');
      text.title = String(candidate?.text || '');
      node.appendChild(text);

      const actions = make('div', 'ag-memory-candidate-actions');
      const adopt = make('button', 'ag-memory-candidate-btn adopt', '');
      adopt.type = 'button';
      adopt.dataset.candAction = 'adopt';
      adopt.dataset.candId = candidate.id;
      adopt.textContent = memoryText('采纳', 'Adopt');
      adopt.disabled = state.candidateBusy;
      const reject = make('button', 'ag-memory-candidate-btn', '');
      reject.type = 'button';
      reject.dataset.candAction = 'reject';
      reject.dataset.candId = candidate.id;
      reject.textContent = memoryText('驳回', 'Reject');
      reject.disabled = state.candidateBusy;
      actions.appendChild(adopt);
      actions.appendChild(reject);
      node.appendChild(actions);
      refs.candidates.appendChild(node);
    });
  }

  async function resolveCandidate(action, id, button) {
    if (!id || !['adopt', 'reject'].includes(action) || state.candidateBusy) return;
    state.candidateBusy = true;
    if (button) button.disabled = true;
    setStatus(action === 'adopt' ? '正在采纳候选并写入记忆空间...' : '正在驳回候选...', 'busy');
    try {
      await api('/api/memory/candidates', {
        method: 'POST',
        body: JSON.stringify({ id, action, space: 'default' })
      });
      state.candidateBusy = false;
      await loadAll(true);
      setStatus(action === 'adopt' ? '候选已采纳并写入记忆空间' : '候选已驳回', 'ok');
    } catch (error) {
      state.candidateBusy = false;
      renderCandidates();
      setStatus('候选处理失败：' + (error.message || error), 'error');
    }
  }

  function renderItems() {
    if (!refs.items) return;
    const all = Array.isArray(state.items) ? state.items : [];
    refs.count.textContent = String(all.length);
    refs.search.style.display = all.length ? '' : 'none';
    refs.items.textContent = '';

    if (!all.length) {
      refs.items.innerHTML = [
        '<div class="ag-memory-empty">',
        '<span class="ag-memory-empty-star">✦</span>',
        '<strong>还没有长期记忆</strong>',
        '在对话中让 Antigravity 记住一件事，或运行 /mnemon-remember，事实会归档到记忆空间。',
        '<button type="button" class="ag-memory-btn" data-mem-close style="margin-top:9px">返回对话</button>',
        '</div>'
      ].join('');
      return;
    }

    const query = state.query.trim().toLowerCase();
    const filtered = query
      ? all.filter((item) => {
          const text = itemText(item).toLowerCase();
          const space = String(item?.space || '').toLowerCase();
          const tags = Array.isArray(item?.tags) ? item.tags.join(' ').toLowerCase() : '';
          return text.includes(query) || space.includes(query) || tags.includes(query);
        })
      : all;

    if (!filtered.length) {
      refs.items.innerHTML = '<div class="ag-memory-empty"><strong>没有匹配的记忆</strong>换个关键词试试。</div>';
      return;
    }

    filtered.slice(0, 80).forEach((item) => {
      const node = make('div', 'ag-memory-item');
      const top = make('div', 'ag-memory-item-top');
      const space = make('span', 'ag-memory-item-space', '');
      space.textContent = item?.space || 'memory';
      top.appendChild(space);
      if (item?.pinned) {
        const pin = make('span', 'ag-memory-item-pin', '★ 置顶');
        top.appendChild(pin);
      }
      const time = make('span', 'ag-memory-item-time', '');
      time.textContent = formatTime(item?.updatedAt || item?.createdAt);
      top.appendChild(time);
      node.appendChild(top);

      const text = make('div', 'ag-memory-item-text', '');
      text.textContent = itemText(item);
      text.title = itemText(item);
      node.appendChild(text);

      const tags = Array.isArray(item?.tags) ? item.tags.filter(Boolean).slice(0, 3) : [];
      if (tags.length) {
        const tagRow = make('div', 'ag-memory-item-tags');
        tags.forEach((tag) => {
          const tagNode = make('span', 'ag-memory-tag', '');
          tagNode.textContent = '#' + tag;
          tagRow.appendChild(tagNode);
        });
        node.appendChild(tagRow);
      }
      refs.items.appendChild(node);
    });
  }

  function renderAll() {
    renderFiles();
    renderVault();
    renderCandidates();
    renderItems();
    renderEditor();
    updateButtons();
  }

  function selectFile(key) {
    if (!FILES.some((file) => file.key === key)) return;
    state.active = key;
    renderFiles();
    renderEditor();
    refs.textarea?.focus({ preventScroll: true });
  }

  function updateDirtyUi() {
    if (!refs.textarea) return;
    const dirty = isDirty();
    dirtyKeys().forEach((key) => {
      const row = refs.files.querySelector('.ag-memory-file[data-file-key="' + key + '"]');
      if (row) row.classList.add('is-dirty');
    });
    refs.files.querySelectorAll('.ag-memory-file').forEach((row) => {
      if (!dirtyKeys().includes(row.dataset.fileKey)) row.classList.remove('is-dirty');
    });
    const file = activeFile();
    refs.meta.textContent = [file.title, state.values ? ((state.values[file.key] || '').length + ' 字符') : ''].filter(Boolean).join(' · ');
    updateButtons();
    if (dirty !== state.lastDirty) {
      state.lastDirty = dirty;
      setStatus(dirty ? '有未保存的修改 · Ctrl+S 保存' : '无未保存修改 · 已与主库同步', dirty ? 'busy' : 'ok');
    }
  }

  function onEditorInput() {
    if (!state.values) return;
    state.values[state.active] = refs.textarea.value;
    updateDirtyUi();
  }

  async function loadAll(force) {
    if (state.loading) return;
    state.loading = true;
    if (refs.textarea) refs.textarea.disabled = true;
    updateButtons();
    setStatus('正在同步 mnemon 记忆...', 'busy');
    try {
      const runtime = await api('/api/memory/runtime');
      state.status = runtime.status || state.status;
      state.saved = {
        persona: runtime.persona || '',
        user: runtime.user || '',
        memory: runtime.memory || ''
      };
      if (!state.values || !isDirty() || force) state.values = Object.assign({}, state.saved);
      try {
        const items = await api('/api/memory/items');
        state.items = Array.isArray(items.items) ? items.items : [];
      } catch (error) {
        state.items = [];
      }
      try {
        const candidates = await api('/api/memory/candidates');
        state.candidates = Array.isArray(candidates.items) ? candidates.items : [];
      } catch (error) {
        state.candidates = [];
      }
      state.loading = false;
      state.lastDirty = false;
      renderAll();
      setStatus('已同步 ' + formatTime(new Date().toISOString()) + ' · mnemon 记忆引擎在线', 'ok');
    } catch (error) {
      state.loading = false;
      updateButtons();
      refs.textarea.disabled = !state.values;
      if (!state.values) {
        refs.textarea.placeholder = '无法读取 mnemon 记忆：' + (error.message || error) + '。点击右上角「刷新」重试。';
        refs.meta.textContent = '尚未连接';
      }
      renderFiles();
      renderVault();
      renderCandidates();
      renderItems();
      setStatus('读取失败：' + (error.message || error), 'error');
    }
  }

  async function save() {
    if (state.loading || !state.values || !isDirty()) return;
    const snapshot = Object.assign({}, state.values);
    state.loading = true;
    if (refs.textarea) refs.textarea.disabled = true;
    updateButtons();
    setStatus('正在写入 mnemon 主库...', 'busy');
    try {
      const result = await api('/api/memory/runtime', {
        method: 'POST',
        body: JSON.stringify({
          persona: snapshot.persona,
          user: snapshot.user,
          memory: snapshot.memory
        })
      });
      state.saved = snapshot;
      state.lastDirty = false;
      if (result.status) state.status = result.status;
      state.loading = false;
      renderAll();
      if (isDirty()) setStatus('已保存，但编辑器中还有新的修改', 'busy');
      else setStatus('已保存并同步镜像 · ' + formatTime(new Date().toISOString()), 'ok');
    } catch (error) {
      state.loading = false;
      if (refs.textarea) refs.textarea.disabled = !state.values;
      updateButtons();
      setStatus('保存失败：' + (error.message || error), 'error');
    }
  }

  async function backup() {
    if (state.loading) return;
    state.loading = true;
    updateButtons();
    setStatus('正在启动镜像 / 快照任务...', 'busy');
    try {
      await api('/api/memory/backup', { method: 'POST', body: '{}' });
      state.loading = false;
      updateButtons();
      setStatus('备份任务已启动 · 稍后点击「刷新」查看新快照', 'ok');
    } catch (error) {
      state.loading = false;
      updateButtons();
      setStatus('备份失败：' + (error.message || error), 'error');
    }
  }

  async function refresh(confirmDirty) {
    if (state.loading) return;
    if (confirmDirty && isDirty() && !window.confirm('刷新会丢弃未保存的修改，继续？')) return;
    if (isDirty()) {
      state.values = state.saved ? Object.assign({}, state.saved) : null;
      state.lastDirty = false;
    }
    await loadAll(true);
    refs.textarea?.focus({ preventScroll: true });
  }

  async function copyPath(path) {
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      setStatus('路径已复制到剪贴板', 'ok');
    } catch (error) {
      const input = document.createElement('textarea');
      input.value = path;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      try { document.execCommand('copy'); setStatus('路径已复制到剪贴板', 'ok'); }
      catch (err) { setStatus('复制失败，请手动选择路径', 'error'); }
      input.remove();
    }
  }

  function openPage() {
    buildOverlay();
    positionOverlay();
    document.querySelectorAll('.ag-plugin-panel.is-open, .ag-prompt-panel.is-open').forEach((panel) => panel.classList.remove('is-open'));
    document.querySelectorAll('.ag-plugin-trigger.is-active').forEach((trigger) => trigger.classList.remove('is-active'));
    state.open = true;
    state.openedAt = location.pathname || '';
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('ag-memory-open');
    updateNavState();
    loadAll(false);
    window.setTimeout(() => {
      refs.textarea?.focus({ preventScroll: true });
    }, 80);
  }

  function closePage() {
    if (!state.open) return;
    state.open = false;
    overlay?.classList.remove('is-open');
    overlay?.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('ag-memory-open');
    updateNavState();
    const nav = document.querySelector('.ag-memory-nav');
    nav?.focus({ preventScroll: true });
  }

  function togglePage() {
    if (state.open) closePage();
    else openPage();
  }

  function updateNavState() {
    const nav = document.querySelector('.ag-memory-nav');
    if (!nav) return;
    nav.classList.toggle('is-active', state.open);
    nav.setAttribute('aria-expanded', state.open ? 'true' : 'false');
    nav.setAttribute('aria-current', state.open ? 'page' : 'false');
  }

  function ensureNav() {
    if (!document.body) return;
    const link = document.querySelector('.bg-sidebar a[href="/customizations"]') ||
      Array.from(document.querySelectorAll('.bg-sidebar a'))
        .find((node) => (node.textContent || '').trim() === '自定义配置');
    if (!link) return;
    const group = link.parentElement;
    if (!group) return;
    let nav = document.querySelector('.ag-memory-nav');
    if (!nav) {
      nav = make('button', 'ag-memory-nav');
      nav.type = 'button';
      nav.dataset.agMemoryNav = '';
      nav.setAttribute('aria-label', '记忆管理');
      nav.setAttribute('aria-expanded', 'false');
      nav.title = 'Mnemon 记忆管理 · PERSONA / USER / MEMORY';
      nav.innerHTML = [
        '<span class="ag-memory-nav-icon">' + ICONS.nav + '</span>',
        '<span class="ag-memory-nav-label">记忆管理</span>',
        '<span class="ag-memory-nav-dot" title="mnemon 记忆引擎"></span>'
      ].join('');
      nav.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        togglePage();
      });
    }
    if (nav.parentElement !== group || nav.previousElementSibling !== link) {
      group.insertBefore(nav, link.nextSibling);
    }
    const navLabel = nav.querySelector('.ag-memory-nav-label');
    if (navLabel) navLabel.textContent = memoryText('记忆管理', 'Memory');
    nav.setAttribute('aria-label', memoryText('记忆管理', 'Memory'));
    nav.title = memoryText('Mnemon 记忆管理 · PERSONA / USER / MEMORY', 'Mnemon memory · PERSONA / USER / MEMORY');
    const linkLabel = link.querySelector('span.truncate.text-sm') || link.querySelector('span:last-child');
    if (linkLabel && !linkLabel.querySelector('.ag-memory-nav-icon')) {
      linkLabel.textContent = memoryText('自定义配置', 'Customizations');
    }
    updateNavState();
    localizeMemoryUi();
  }

  function localizeMemoryUi() {
    if (!overlay) return;
    const title = overlay.querySelector('.ag-memory-title h1');
    if (title) title.textContent = memoryText('记忆管理', 'Memory');
    const sub = overlay.querySelector('.ag-memory-sub');
    if (sub) sub.textContent = memoryText(
      '固定人设、用户画像与工作记忆；长期事实归档到记忆空间。',
      'Persona, user profile and working memory; durable facts live in memory spaces.'
    );
    const candidatesTitle = overlay.querySelector('.ag-memory-candidates-card h2');
    if (candidatesTitle) candidatesTitle.textContent = memoryText('待拍板候选', 'Pending candidates');
    const spaceTitle = overlay.querySelector('.ag-memory-items-card h2');
    if (spaceTitle) spaceTitle.textContent = memoryText('记忆空间', 'Memory spaces');
    const back = overlay.querySelector('[data-mem-back]');
    if (back) {
      back.setAttribute('aria-label', memoryText('返回对话', 'Back to chat'));
      back.title = memoryText('返回对话（Esc）', 'Back to chat (Esc)');
    }
    const actions = overlay.querySelectorAll('.ag-memory-actions .ag-memory-btn');
    const labels = [['刷新', 'Refresh'], ['备份', 'Back up'], ['保存更改', 'Save changes']];
    actions.forEach((button, index) => {
      if (labels[index]) button.textContent = memoryText(labels[index][0], labels[index][1]);
    });
    const tip = overlay.querySelector('.ag-memory-tip');
    if (tip) tip.textContent = memoryText('Ctrl+S 保存 · 自动同步镜像', 'Ctrl+S save · auto mirror');
  }

  function tick() {
    ensureNav();
    if (!state.open) return;
    if ((location.pathname || '') !== state.openedAt) {
      closePage();
      return;
    }
    positionOverlay();
  }

  function boot() {
    ensureNav();
    window.__agEnsureMemoryPage = ensureNav;
    window.__agOpenMemoryPage = openPage;
    window.__agMemoryDispose = dispose;
    window.addEventListener('resize', positionOverlay, { passive: true, signal: lifecycle?.signal });
    window.addEventListener('keydown', (event) => {
      if (!state.open) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closePage();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 's') {
        event.preventDefault();
        event.stopPropagation();
        save();
      }
    }, { capture: true, signal: lifecycle?.signal });
    document.addEventListener('click', (event) => {
      if (!state.open) return;
      const item = event.target.closest?.('.bg-sidebar a, .bg-sidebar button');
      if (item && !item.closest('.ag-memory-nav')) closePage();
    }, { capture: true, signal: lifecycle?.signal });
    tickTimer = window.setInterval(tick, 1200);
  }

  function dispose() {
    closePage();
    if (tickTimer) window.clearInterval(tickTimer);
    tickTimer = 0;
    try { lifecycle?.abort(); } catch (error) {}
    if (overlay) overlay.remove();
    overlay = null;
    document.querySelectorAll('.ag-memory-nav').forEach((node) => node.remove());
    document.documentElement.classList.remove('ag-memory-open');
    delete window.__agMemoryPageInstalled;
    delete window.__agEnsureMemoryPage;
    delete window.__agOpenMemoryPage;
    delete window.__agMemoryDispose;
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
