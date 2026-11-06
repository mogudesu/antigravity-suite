/**
 * 把「antigravity远程-mogu」挂进 Antigravity 原生设置页。
 *
 * 做法：CDP 注入一个导航项 + 一个 iframe，iframe 直接加载守护进程的面板页面。
 * 这样侧栏面板和设置页共用同一套 UI，不需要维护两份前端。
 *
 * 幂等 + 自愈：MutationObserver + 定时兜底；每次 ensure 都重新绑定事件（脚本会被反复求值）。
 */
import { Workbench } from '../bridge/cdp-executor.mjs';

export const NAV_TESTID = 'settings-nav-item-AntigravityRemoteMogu';
export const PANEL_NAME = 'antigravity远程-mogu';

export function buildScript(panelUrl) {
  return `(() => {
  const NAV_ID = '${NAV_TESTID}';
  const NAME = ${JSON.stringify(PANEL_NAME)};
  const URL = ${JSON.stringify(panelUrl)};
  const findDialog = () => document.querySelector('[role="dialog"][aria-label="Settings"]');
  const findNav = () => document.querySelector('[data-testid="' + NAV_ID + '"]');
  const findFrame = () => document.querySelector('[data-agb="frame"]');
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none'; };

  function contentPane(dlg) {
    let root = dlg.querySelector(':scope > div');
    for (let i = 0; i < 5 && root; i += 1) {
      const kids = [...root.children];
      const navCol = kids.find((k) => k.querySelector('[data-testid^="settings-nav-item-"]'));
      if (!navCol) return null;
      const content = kids.find((k) => k !== navCol && !k.querySelector('[data-testid^="settings-nav-item-"]'));
      if (content) return content;
      root = navCol;
    }
    return null;
  }

  function ensureStyle() {
    if (document.querySelector('style[data-agb="style"]')) return;
    const style = document.createElement('style');
    style.setAttribute('data-agb', 'style');
    style.textContent = \`
      [data-agb-hidden] { display: none !important; }
      [data-testid="\${NAV_ID}"][data-active="true"] { background: var(--sidebar-secondary, rgba(255,255,255,.08)); }
      [data-agb="frame"] { flex: 1 1 0%; min-width: 0; height: 100%; border: 0; background: transparent; }
    \`;
    document.head.appendChild(style);
  }

  function bindNav(btn, dlg) {
    btn.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); open(dlg, btn); };
  }

  function bindDialog(dlg) {
    dlg.onclick = (ev) => {
      const other = ev.target.closest && ev.target.closest('[data-testid^="settings-nav-item-"]');
      if (other && other.getAttribute('data-testid') !== NAV_ID) close(dlg);
    };
  }

  function injectNav(dlg) {
    const anchor = dlg.querySelector('[data-testid="settings-nav-item-Conversations"]')
      || dlg.querySelector('[data-testid^="settings-nav-item-"]');
    if (!anchor) return false;
    const wrap = anchor.closest('div[class*="nav-item"]') || anchor.parentElement;
    if (!wrap || !wrap.parentElement) return false;
    const clone = wrap.cloneNode(true);
    const buttons = [...clone.querySelectorAll('button')];
    buttons.slice(1).forEach((b) => b.remove());
    const btn = clone.querySelector('button') || clone;
    btn.setAttribute('data-testid', NAV_ID);
    btn.removeAttribute('aria-label');
    btn.removeAttribute('data-active');
    const span = btn.querySelector('span');
    if (span) span.textContent = NAME; else btn.textContent = NAME;
    clone.querySelectorAll('svg').forEach((s) => { if (s.closest('button') !== btn) s.remove(); });
    wrap.after(clone);
    bindNav(btn, dlg);
    return true;
  }

  function frameTip(message) {
    let tip = document.querySelector('[data-agb="tip"]');
    if (!message) { if (tip) tip.remove(); return; }
    if (!tip) {
      tip = document.createElement('div');
      tip.setAttribute('data-agb', 'tip');
      tip.style.cssText = 'padding:10px 14px;font:12px/1.6 system-ui;color:#f6d893;' +
        'background:rgba(12,10,26,.88);border-radius:8px;margin:8px';
      document.querySelector('[data-agb="frame"]')?.after(tip);
    }
    if (tip.textContent !== message) tip.textContent = message;
  }

  /**
   * iframe 只建一次就再不回头看它了：守护进程换端口（或上次加载失败）后，
   * 面板会永久白屏，而 status() 仍然报 open:true。这里校正 src，并用 ping/pong
   * 确认面板真的启动了（父页与面板跨源，读不到 contentDocument），失败就重试并给出提示。
   */
  function syncFrame(frame) {
    if (frame.dataset.agbUrl !== URL) {
      frame.dataset.agbUrl = URL;
      frame.dataset.agbLoaded = '';
      frame.dataset.agbStarted = '';
      frame.dataset.agbTried = '0';
      frame.setAttribute('src', URL);
    }
    // 早期版本误判失败时留下过 display:none 的内联样式；不清回来面板就永远看不见。
    if (frame.style.display === 'none') frame.style.display = '';
    if (!window.__AGB_PONG_HOOK__) {
      window.__AGB_PONG_HOOK__ = true;
      window.addEventListener('message', (event) => {
        if (!event.data || event.data.agb !== 'pong') return;
        const live = findFrame();
        if (live) { live.dataset.agbLoaded = '1'; frameTip(''); }
      });
    }
    if (frame.dataset.agbLoaded === '1') { frameTip(''); return; }
    try {
      if (frame.contentWindow) frame.contentWindow.postMessage({ agb: 'ping' }, '*');
    } catch (e) { /* 还没加载完，下一轮再问 */ }
    const started = Number(frame.dataset.agbStarted || 0);
    if (!started) { frame.dataset.agbStarted = String(Date.now()); return; }
    if (Date.now() - started < 9000) return;
    const tried = Number(frame.dataset.agbTried || 0);
    if (tried >= 3) {
      // 只提示不隐藏：误判把正常面板藏起来比白屏更难解释
      frameTip('远程面板没有响应：' + URL + '（守护进程端口可能变了；重启插件后即可恢复）');
      return;
    }
    frame.dataset.agbTried = String(tried + 1);
    frame.dataset.agbStarted = String(Date.now());
    frame.setAttribute('src', URL + (URL.indexOf('?') >= 0 ? '&' : '?') + 'agbRetry=' + (tried + 1));
  }

  function open(dlg, btn) {
    const pane = contentPane(dlg);
    if (!pane) return false;
    ensureStyle();
    pane.setAttribute('data-agb-hidden', '1');
    let frame = findFrame();
    if (!frame) {
      frame = document.createElement('iframe');
      frame.setAttribute('data-agb', 'frame');
      frame.setAttribute('src', URL);
      pane.after(frame);
    }
    syncFrame(frame);
    if (btn) btn.setAttribute('data-active', 'true');
    return true;
  }

  function close(dlg) {
    const frame = findFrame();
    if (frame) frame.remove();
    const pane = dlg ? contentPane(dlg) : null;
    if (pane) pane.removeAttribute('data-agb-hidden');
    const btn = findNav();
    if (btn) btn.removeAttribute('data-active');
  }

  function ensure() {
    if (window.__AGB_DISABLED__) return { ok: true, disabled: true };
    const dlg = findDialog();
    if (!dlg) return { ok: true, dialog: false, injected: false };
    ensureStyle();
    bindDialog(dlg);
    let nav = findNav();
    if (!nav) { injectNav(dlg); nav = findNav(); }
    if (nav) bindNav(nav, dlg);
    // 面板已经开着时也要自愈：守护进程换端口不该把用户永久留在白屏上
    const frame = findFrame();
    if (frame) syncFrame(frame);
    return { ok: true, dialog: true, injected: !!nav, open: !!frame, frameLoaded: frame ? frame.dataset.agbLoaded === '1' : null };
  }

  function teardown() {
    window.__AGB_DISABLED__ = true;
    if (window.__AGB_TIMER__) { clearInterval(window.__AGB_TIMER__); window.__AGB_TIMER__ = null; }
    if (window.__AGB_OBSERVER__) { try { window.__AGB_OBSERVER__.disconnect(); } catch (e) {} window.__AGB_OBSERVER__ = null; }
    close(findDialog());
    const nav = findNav();
    if (nav) { const wrap = nav.closest('div[class*="nav-item"]') || nav; wrap.remove(); }
    document.querySelector('style[data-agb="style"]')?.remove();
    return true;
  }

  window.__AGB__ = {
    ensure,
    open() {
      const btn = document.querySelector('[data-testid="settings-button"]');
      if (btn && !findDialog()) btn.click();
      setTimeout(() => { const dlg = findDialog(); if (dlg) { ensure(); findNav()?.click(); } }, 350);
      return true;
    },
    close() { return close(findDialog()); },
    status() {
      const frame = findFrame();
      return {
        dialog: !!findDialog(),
        injected: !!findNav(),
        open: !!frame,
        frameLoaded: frame ? frame.dataset.agbLoaded === '1' : null,
        panelUrl: URL,
      };
    },
    remove() { return teardown(); },
  };

  if (!window.__AGB_OBSERVER__) {
    window.__AGB_OBSERVER__ = new MutationObserver(() => { try { ensure(); } catch (e) {} });
    window.__AGB_OBSERVER__.observe(document.documentElement, { childList: true, subtree: true });
  }
  if (!window.__AGB_TIMER__) window.__AGB_TIMER__ = setInterval(() => { try { ensure(); } catch (e) {} }, 1500);

  return ensure();
})()`;
}

export class SettingsInjector {
  constructor({ workbench = new Workbench(), panelUrl = 'http://127.0.0.1:8791/ui/panel.html', intervalMs = 6000, logger = console } = {}) {
    this.workbench = workbench;
    this.panelUrl = panelUrl;
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.timer = null;
  }

  async ensure() {
    try {
      const client = await this.workbench.ensure();
      await client.evaluate('window.__AGB_DISABLED__ = false');
      return await client.evaluate(buildScript(this.panelUrl));
    } catch (error) {
      this.logger.debug?.('注入失败：', error?.message || error);
      return { ok: false, error: error?.message || String(error) };
    }
  }

  async openPanel() {
    await this.ensure();
    try {
      const client = await this.workbench.ensure();
      await client.evaluate('window.__AGB__ && window.__AGB__.open()');
      await new Promise((resolve) => setTimeout(resolve, 800));
      return await this.status();
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  async status() {
    try {
      const client = await this.workbench.ensure();
      return await client.evaluate('window.__AGB__ ? window.__AGB__.status() : { installed: false }');
    } catch {
      return { installed: false };
    }
  }

  async remove() {
    try {
      const client = await this.workbench.ensure();
      return await client.evaluate('window.__AGB__ ? window.__AGB__.remove() : false');
    } catch {
      return false;
    }
  }

  start() {
    if (this.timer) return;
    this.ensure();
    this.timer = setInterval(() => this.ensure(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
