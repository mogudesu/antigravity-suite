#!/usr/bin/env python3
"""Playwright regression & layout test for Stage 2: Right Reading Pane Enhancement & Starlight Mask."""

import json
import re
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
PLUGIN_ROOT = HERE.parent
APPLY_JS = HERE / "apply.js"
UI_ENHANCE_JS = HERE / "ui-enhance.js"
SETTINGS_JS = HERE / "starlight-settings.js"
LIVE_DAEMON_JS = HERE / "live-daemon.js"
RESTORE_JS = HERE / "restore.js"
CONFIG_JSON = PLUGIN_ROOT / "config" / "config.json"

results = []


def check(name, ok, detail=""):
    results.append({"name": name, "ok": bool(ok), "detail": str(detail)[:320]})
    print(("PASS  " if ok else "FAIL  ") + name + (("  -> " + str(detail)[:240]) if detail and not ok else ""))


def build_theme_css_and_daemon_helpers():
    node_script = r"""
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const here = process.argv[1];
const pluginRoot = path.dirname(here);
const applySrc = fs.readFileSync(path.join(here, 'apply.js'), 'utf8');
const daemonSrc = fs.readFileSync(path.join(here, 'live-daemon.js'), 'utf8');
const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'config', 'config.json'), 'utf8'));

const resIdx = applySrc.indexOf('function resolveRightReadingStyleVars(');
const genIdx = applySrc.indexOf('function generateThemeCss(');
const startGenIdx = resIdx >= 0 ? Math.min(resIdx, genIdx) : genIdx;
const nextFnIdx = applySrc.indexOf('\nfunction ', genIdx + 10);
const genSlice = applySrc.slice(startGenIdx, nextFnIdx);
const ctx1 = { console, Math, Number, String, Boolean, JSON, Array, Object, parseInt, parseFloat, isFinite };
vm.runInNewContext(genSlice + '\nglobalThis.__gen = generateThemeCss;', ctx1);
const css = ctx1.__gen('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', config);

const buildIdx = daemonSrc.indexOf('function buildExpression(');
const mainIdx = daemonSrc.indexOf('\nasync function applyPayload(', buildIdx);
const daemonSlice = daemonSrc.slice(buildIdx, mainIdx);
const ctx2 = { Math, Number, String, Boolean, JSON, parseInt, parseFloat, isFinite };
vm.runInNewContext(daemonSlice + '\nglobalThis.__buildExpr = buildExpression;', ctx2);

const payloads = {
  defaultExpr: ctx2.__buildExpr({
    opacity: config.opacity,
    blur: config.blur,
    hueShift: config.hueShift,
    glow: config.glow,
    stars: config.stars,
    starDensity: config.starDensity,
    starFrequency: config.starFrequency,
    themeColor: config.themeColor,
    composerOpacity: config.composerOpacity,
    rightReadingEnabled: config.rightReadingEnabled,
    rightReadingBg: config.rightReadingBg,
    rightReadingOpacity: config.rightReadingOpacity,
    rightReadingFontSize: config.rightReadingFontSize,
    videoPreviewEnabled: config.videoPreviewEnabled,
  }),
  customExpr: ctx2.__buildExpr({
    opacity: config.opacity,
    blur: config.blur,
    hueShift: config.hueShift,
    glow: config.glow,
    stars: config.stars,
    starDensity: config.starDensity,
    starFrequency: config.starFrequency,
    themeColor: config.themeColor,
    composerOpacity: config.composerOpacity,
    rightReadingEnabled: true,
    rightReadingBg: '#1b1038',
    rightReadingOpacity: 0.85,
    rightReadingFontSize: 16,
    videoPreviewEnabled: true,
  }),
  disabledExpr: ctx2.__buildExpr({
    opacity: config.opacity,
    blur: config.blur,
    hueShift: config.hueShift,
    glow: config.glow,
    stars: config.stars,
    starDensity: config.starDensity,
    starFrequency: config.starFrequency,
    themeColor: config.themeColor,
    composerOpacity: config.composerOpacity,
    rightReadingEnabled: false,
    rightReadingBg: '#140f29',
    rightReadingOpacity: 0.94,
    rightReadingFontSize: 14,
    videoPreviewEnabled: false,
  }),
};

process.stdout.write(JSON.stringify({ css, payloads }));
"""
    proc = subprocess.run(["node", "-e", node_script, str(HERE)], capture_output=True, text=True, check=True)
    return json.loads(proc.stdout)


HTML_FIXTURE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    width: 1440px;
    height: 900px;
    overflow: hidden;
    background: #100c20;
    color: #e6e8f0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .layout-shell {
    position: relative;
    display: flex;
    width: 100%;
    height: 100%;
    z-index: 1;
  }
  .chat-column {
    flex: 1;
    padding: 20px 24px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
  [data-testid="conversation-view"] {
    padding: 16px;
  }
  [data-testid="conversation-view"] pre {
    background: rgb(16, 18, 32);
    padding: 12px;
    border-radius: 8px;
  }
  [data-testid="conversation-view"] pre code {
    font-family: Consolas, monospace;
    font-size: 13px;
    line-height: 1.45;
  }
  .composer-box {
    position: relative;
    padding: 12px;
    border-radius: 12px;
    background: rgba(24, 24, 44, 0.8);
  }
  .ag-plugin-panel {
    position: relative;
    margin-top: 8px;
    padding: 10px;
    font-size: 12px;
    line-height: 1.4;
    background: #181a30;
  }
  [data-side-panel-open="true"] {
    width: 680px;
    height: 100%;
    display: flex;
  }
  [data-side-panel-open="true"] > [data-side-panel-focus-scope="true"] {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: transparent;
  }
  [data-side-panel-strip="true"] {
    display: flex;
    gap: 6px;
    padding: 6px 10px;
    border-bottom: 0px solid transparent;
  }
  .agy-aux-tab {
    display: inline-flex;
    align-items: center;
    padding: 4px 10px;
  }
  [data-side-panel-body="true"] {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  [aria-label="File Viewer"] {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: rgba(25, 22, 42, 0.5);
    min-width: 0;
  }
  [aria-label="File Viewer header"] {
    padding: 6px 12px;
    border-bottom: 0px solid transparent;
  }
  .file-viewer-root {
    flex: 1;
    padding: 10px 12px;
    background: rgba(25, 22, 42, 0.5);
  }
  .file-viewer-root .code-line {
    display: flex;
    gap: 12px;
    font-size: 12px;
    line-height: 16px;
  }
  .file-viewer-root [data-testid="code-gutter"] {
    width: 32px;
    text-align: right;
    user-select: none;
  }
  .monaco-editor {
    margin-top: 12px;
    background: rgba(15, 16, 28, 0.6);
    padding: 8px;
  }
  .monaco-editor .view-lines,
  .monaco-editor .line-numbers {
    font-size: 12px;
    line-height: 16px;
  }
  [data-testid="tab-file-tree-sidebar"] {
    width: 220px;
    height: 100%;
    background: transparent;
  }
  [data-testid="tab-file-tree-sidebar"] [role="tree"] {
    position: relative;
    height: 160px;
  }
  .tree-virtual-box {
    position: relative;
    height: 120px;
  }
  [data-index] {
    position: absolute;
    left: 0;
    right: 0;
    height: 22px;
  }
  [role="treeitem"] {
    height: 22px;
    display: flex;
    align-items: center;
    padding: 0 8px;
    font-size: 12px;
  }
  .ag-right-corner-hud {
    position: fixed;
    top: 8px;
    right: 185px;
  }
  .selected-text {
    display: inline-block;
    width: 60px;
    height: 16px;
  }
</style>
</head>
<body>
  <div class="layout-shell agy-shell">
    <div class="chat-column">
      <div data-testid="conversation-view">
        <pre><code id="chat-code">const chatSample = 42;</code></pre>
      </div>
      <div class="composer-box" id="antigravity.agentSidePanelInputBox">
        <div class="ag-plugin-panel" id="composer-popup-sample">Composer popup item</div>
      </div>
    </div>

    <div data-side-panel-open="true">
      <div data-side-panel-focus-scope="true" id="outer-right-pane">
        <div data-side-panel-strip="true" data-active-tab-id="app.ts" id="tab-strip">
          <div class="agy-aux-tab bg-secondary" id="tab-active">
            <button type="button" data-tab-id="app.ts">app.ts</button>
          </div>
          <div class="agy-aux-tab" id="tab-inactive">
            <button type="button" data-tab-id="README.md">README.md</button>
          </div>
        </div>
        <div data-side-panel-body="true">
          <div data-side-panel-focus-scope="true" aria-label="File Viewer" id="inner-file-viewer">
            <div aria-label="File Viewer header" id="viewer-header">
              <nav aria-label="File path breadcrumbs">
                <button type="button">src</button>
                <button type="button">app.ts</button>
              </nav>
            </div>
            <div class="file-viewer-root" id="viewer-root">
              <div class="code-line">
                <div data-testid="code-gutter" class="line-number" id="code-gutter-1">1</div>
                <div class="line-content" id="code-line-1">
                  <span id="tok-kw" style="color: rgb(198, 120, 221);">const</span>
                  <span id="tok-fn" style="color: rgb(97, 175, 239);">render</span>
                  <span> = </span>
                  <span class="findMatch" id="search-hit">starlight</span>
                </div>
              </div>
              <div class="monaco-editor" id="monaco-box">
                <div class="margin-view-overlays"><div class="line-numbers" id="monaco-ln">1</div></div>
                <div class="view-lines" id="monaco-lines">const monacoLine = true;</div>
                <div class="selected-text" id="monaco-sel"></div>
                <div class="findMatch" id="monaco-find">match</div>
              </div>
            </div>
          </div>

          <div data-testid="tab-file-tree-sidebar" id="file-tree-pane">
            <div role="tree">
              <div class="tree-virtual-box">
                <div data-index="0" id="tree-row-0" style="transform: translateY(0px);">
                  <div role="treeitem" aria-selected="true" id="tree-item-0">app.ts</div>
                </div>
                <div data-index="1" id="tree-row-1" style="transform: translateY(22px);">
                  <div role="treeitem" aria-selected="false" id="tree-item-1">README.md</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>
"""


def main():
    bundle = build_theme_css_and_daemon_helpers()
    ui_source = UI_ENHANCE_JS.read_text(encoding="utf-8")
    settings_source = SETTINGS_JS.read_text(encoding="utf-8")
    restore_raw = RESTORE_JS.read_text(encoding="utf-8")
    m_restore = re.search(r"(?:const|let)\s+code\s*=\s*`\s*([\s\S]*?)\s*`;", restore_raw)
    if not m_restore:
        raise RuntimeError("Could not extract browser restore expression from restore.js")
    restore_source = m_restore.group(1)
    config = json.loads(CONFIG_JSON.read_text(encoding="utf-8"))

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        context.set_default_timeout(5000)
        page = context.new_page()
        page_errors = []
        page.on("pageerror", lambda err: page_errors.append(str(err)))

        live_state = dict(config)

        def handle_sidecar_route(route):
            req = route.request
            url = req.url
            if "/api/config" in url:
                if req.method == "POST":
                    patch = json.loads(req.post_data or "{}")
                    live_state.update(patch)
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({"ok": True, "config": live_state, "applied": True}),
                )
                return
            if "/api/live-sync" in url:
                patch = json.loads(req.post_data or "{}")
                live_state.update(patch)
                route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True}))
                return
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True}))

        page.route("**://127.0.0.1:*/api/*", handle_sidecar_route)
        page.set_content(HTML_FIXTURE)

        # Inject generated CSS via dedicated style tag (matches apply.js id style id)
        page.evaluate(
            """(cssText) => {
              let style = document.getElementById('ag-starlight-theme-css');
              if (!style) {
                style = document.createElement('style');
                style.id = 'ag-starlight-theme-css';
                document.head.appendChild(style);
              }
              style.textContent = cssText;
            }""",
            bundle["css"],
        )

        # Apply initial live payload from live-daemon.js
        page.evaluate(bundle["payloads"]["defaultExpr"])
        # Mock runtime config for starlight-settings.js (before injecting settings script)
        page.evaluate(
            """(cfg) => {
              window.__agConfig = Object.assign({}, cfg, { sidecarPort: 58999, sidecarToken: 'test-token' });
            }""",
            live_state,
        )
        page.evaluate(ui_source)
        page.evaluate(settings_source)

        # Ensure #ag-global-stars has test stars in both left chat pane and right reading pane
        page.evaluate(
            """() => {
              const stars = document.getElementById('ag-global-stars');
              if (stars) {
                const leftStar = document.createElement('i');
                leftStar.id = 'test-left-star';
                leftStar.style.cssText = 'position:absolute;left:120px;top:160px;width:4px;height:4px;opacity:0.9;';
                const rightStar = document.createElement('i');
                rightStar.id = 'test-right-star';
                rightStar.style.cssText = 'position:absolute;left:1080px;top:240px;width:4px;height:4px;opacity:0.9;';
                stars.appendChild(leftStar);
                stars.appendChild(rightStar);
              }
              window.__agUpdateReadingMask?.();
            }"""
        )
        page.wait_for_timeout(120)

        metrics = page.evaluate(
            """() => {
              const outer = document.getElementById('outer-right-pane');
              const inner = document.getElementById('inner-file-viewer');
              const viewerRoot = document.getElementById('viewer-root');
              const strip = document.getElementById('tab-strip');
              const header = document.getElementById('viewer-header');
              const tabActive = document.getElementById('tab-active');
              const tabInactive = document.getElementById('tab-inactive');
              const lineContent = document.getElementById('code-line-1');
              const gutter = document.getElementById('code-gutter-1');
              const monacoLines = document.getElementById('monaco-lines');
              const monacoLn = document.getElementById('monaco-ln');
              const monacoSel = document.getElementById('monaco-sel');
              const tokKw = document.getElementById('tok-kw');
              const tokFn = document.getElementById('tok-fn');
              const hit = document.getElementById('search-hit');
              const chatCode = document.getElementById('chat-code');
              const popup = document.getElementById('composer-popup-sample');
              const treeRow1 = document.getElementById('tree-row-1');
              const treeItem0 = document.getElementById('tree-item-0');
              const treeItem1 = document.getElementById('tree-item-1');
              const starsEl = document.getElementById('ag-global-stars');
              const cosmosEl = document.getElementById('ag-star-cosmos');
              const leftStar = document.getElementById('test-left-star');
              const rightStar = document.getElementById('test-right-star');

              // Draw a green pixel inside right pane center on #ag-star-cosmos and wait one rAF frame
              if (cosmosEl instanceof HTMLCanvasElement) {
                const ctx = cosmosEl.getContext('2d');
                if (ctx) {
                  ctx.fillStyle = 'rgba(0, 255, 128, 1)';
                  ctx.fillRect(1000, 260, 10, 10);
                }
              }

              return {
                hasClass: document.documentElement.classList.contains('ag-right-reading'),
                outerBg: getComputedStyle(outer).backgroundColor,
                outerBgImg: getComputedStyle(outer).backgroundImage,
                innerBg: getComputedStyle(inner).backgroundColor,
                viewerBg: getComputedStyle(viewerRoot).backgroundColor,
                stripBorderBottom: parseFloat(getComputedStyle(strip).borderBottomWidth),
                headerBorderBottom: parseFloat(getComputedStyle(header).borderBottomWidth),
                tabActiveBorder: getComputedStyle(tabActive).borderColor,
                tabInactiveBorder: getComputedStyle(tabInactive).borderColor,
                lineFontSize: getComputedStyle(lineContent).fontSize,
                lineHeight: parseFloat(getComputedStyle(lineContent).lineHeight),
                lineFontFamily: getComputedStyle(lineContent).fontFamily,
                gutterFontSize: getComputedStyle(gutter).fontSize,
                gutterColor: getComputedStyle(gutter).color,
                monacoFontSize: getComputedStyle(monacoLines).fontSize,
                monacoLineHeight: parseFloat(getComputedStyle(monacoLines).lineHeight),
                monacoLnFontSize: getComputedStyle(monacoLn).fontSize,
                monacoSelBg: getComputedStyle(monacoSel).backgroundColor,
                tokKwColor: getComputedStyle(tokKw).color,
                tokFnColor: getComputedStyle(tokFn).color,
                hitBg: getComputedStyle(hit).backgroundColor,
                chatCodeFontSize: getComputedStyle(chatCode).fontSize,
                chatCodeLineHeight: parseFloat(getComputedStyle(chatCode).lineHeight),
                popupFontSize: getComputedStyle(popup).fontSize,
                treeRow1Pos: getComputedStyle(treeRow1).position,
                treeRow1Transform: getComputedStyle(treeRow1).transform,
                treeRow1Height: getComputedStyle(treeRow1).height,
                treeItem0Bg: getComputedStyle(treeItem0).backgroundColor,
                treeItem1Bg: getComputedStyle(treeItem1).backgroundColor,
                readingRect: window.__agRightReadingRect || null,
                starsClip: starsEl ? starsEl.style.clipPath : '',
                cosmosClip: cosmosEl ? cosmosEl.style.clipPath : '',
                leftStarVis: leftStar ? getComputedStyle(leftStar).visibility : 'missing',
                rightStarVis: rightStar ? getComputedStyle(rightStar).visibility : 'missing',
              };
            }"""
        )

        # Wait 1 rAF so createStarCosmos frame() clears the right-pane pixel
        page.wait_for_timeout(80)
        canvas_alpha = page.evaluate(
            """() => {
              const c = document.getElementById('ag-star-cosmos');
              if (!(c instanceof HTMLCanvasElement)) return -1;
              const rr = window.__agRightReadingRect;
              if (!rr) return -2;
              const cx = Math.round(rr.left + rr.width / 2);
              const cy = Math.round(rr.top + rr.height / 2);
              const data = c.getContext('2d').getImageData(cx, cy, 1, 1).data;
              return data[3];
            }"""
        )

        check("ag-right-reading class enabled", metrics["hasClass"] is True)
        check(
            "outer right pane uses deep-purple 94% backdrop",
            metrics["outerBg"] == "rgba(20, 15, 41, 0.94)" and "gradient" in metrics["outerBgImg"],
            f"bg={metrics['outerBg']} img={metrics['outerBgImg'][:80]}",
        )
        check(
            "inner File Viewer wrapper transparent (no double backdrop stacking)",
            metrics["innerBg"] == "rgba(0, 0, 0, 0)" and metrics["viewerBg"] == "rgba(0, 0, 0, 0)",
            f"inner={metrics['innerBg']} viewer={metrics['viewerBg']}",
        )
        check(
            "tab strip & header have visible 1px+ boundary",
            metrics["stripBorderBottom"] >= 1 and metrics["headerBorderBottom"] >= 1,
            f"strip={metrics['stripBorderBottom']} header={metrics['headerBorderBottom']}",
        )
        check(
            "active tab boundary differs visually from inactive tab",
            metrics["tabActiveBorder"] != metrics["tabInactiveBorder"],
            f"active={metrics['tabActiveBorder']} inactive={metrics['tabInactiveBorder']}",
        )
        check(
            "code-line defaults to 14px monospace + 1.6x line-height (~22.4px)",
            metrics["lineFontSize"] == "14px"
            and 22.0 <= metrics["lineHeight"] <= 22.8
            and "monospace" in metrics["lineFontFamily"].lower(),
            f"size={metrics['lineFontSize']} lh={metrics['lineHeight']} font={metrics['lineFontFamily']}",
        )
        check(
            "gutter & monaco editor also use 14px + 1.6x line-height + visible selection/search",
            metrics["gutterFontSize"] == "14px"
            and metrics["monacoFontSize"] == "14px"
            and 22.0 <= metrics["monacoLineHeight"] <= 22.8
            and metrics["monacoLnFontSize"] == "14px"
            and metrics["monacoSelBg"] != "rgba(0, 0, 0, 0)"
            and metrics["hitBg"] != "rgba(0, 0, 0, 0)",
            f"gutter={metrics['gutterFontSize']} monaco={metrics['monacoFontSize']}/{metrics['monacoLineHeight']} sel={metrics['monacoSelBg']} hit={metrics['hitBg']}",
        )
        check(
            "syntax token inline colors preserved inside code viewer",
            metrics["tokKwColor"] == "rgb(198, 120, 221)" and metrics["tokFnColor"] == "rgb(97, 175, 239)",
            f"kw={metrics['tokKwColor']} fn={metrics['tokFnColor']}",
        )
        check(
            "chat conversation code block & composer popup unaffected by right-reading rules (14px reading rule does not bleed)",
            metrics["chatCodeFontSize"] != "14px"
            and metrics["chatCodeFontSize"] == "12.5px"
            and 20.0 <= metrics["chatCodeLineHeight"] <= 21.0
            and metrics["popupFontSize"] == "12px",
            f"chat={metrics['chatCodeFontSize']}/{metrics['chatCodeLineHeight']} popup={metrics['popupFontSize']}",
        )
        check(
            "virtualized file tree preserves position/transform/height & active item highlight",
            metrics["treeRow1Pos"] == "absolute"
            and metrics["treeRow1Transform"] == "matrix(1, 0, 0, 1, 0, 22)"
            and metrics["treeRow1Height"] == "22px"
            and metrics["treeItem0Bg"] != metrics["treeItem1Bg"],
            f"pos={metrics['treeRow1Pos']} tr={metrics['treeRow1Transform']} h={metrics['treeRow1Height']} bg0={metrics['treeItem0Bg']} bg1={metrics['treeItem1Bg']}",
        )
        rr = metrics["readingRect"] or {}
        check(
            "decorative stars & cosmos canvas clipped out of reading pane while left stars stay visible",
            rr.get("width", 0) >= 600
            and "evenodd" in metrics["starsClip"]
            and "evenodd" in metrics["cosmosClip"]
            and metrics["leftStarVis"] == "visible"
            and metrics["rightStarVis"] == "hidden"
            and canvas_alpha == 0,
            f"rr={rr} left={metrics['leftStarVis']} right={metrics['rightStarVis']} alpha={canvas_alpha}",
        )

        # Open Starlight Settings window -> verify Efficiency controls exist & bind
        page.evaluate("() => window.__agStarlight?.open?.()")
        page.locator('[data-starlight-tab="efficiency"]').click()
        eff_labels = page.locator('[data-starlight-tab="efficiency"]').locator("..").locator("..").inner_text()
        check(
            "Starlight settings panel exposes all 4 Stage 2 controls",
            all(k in eff_labels for k in ["右侧阅读增强", "阅读底色", "代码字号", "视频预览"]),
            eff_labels[:220],
        )

        # Hot-update config via live-daemon expression: #1b1038, 0.85 alpha, 16px code
        page.evaluate(bundle["payloads"]["customExpr"])
        page.wait_for_timeout(40)
        hot_metrics = page.evaluate(
            """() => {
              const outer = document.getElementById('outer-right-pane');
              const lineContent = document.getElementById('code-line-1');
              return {
                outerBg: getComputedStyle(outer).backgroundColor,
                lineFontSize: getComputedStyle(lineContent).fontSize,
                lineHeight: parseFloat(getComputedStyle(lineContent).lineHeight),
              };
            }"""
        )
        check(
            "hot config update changes reading backdrop to #1b1038 @ 85% and code to 16px / 25.6px",
            hot_metrics["outerBg"] == "rgba(27, 16, 56, 0.85)"
            and hot_metrics["lineFontSize"] == "16px"
            and 25.2 <= hot_metrics["lineHeight"] <= 26.0,
            str(hot_metrics),
        )

        # Hot-disable reading enhancement & video preview
        page.evaluate(bundle["payloads"]["disabledExpr"])
        page.wait_for_timeout(40)
        off_metrics = page.evaluate(
            """() => {
              const outer = document.getElementById('outer-right-pane');
              const starsEl = document.getElementById('ag-global-stars');
              const rightStar = document.getElementById('test-right-star');
              return {
                hasReading: document.documentElement.classList.contains('ag-right-reading'),
                hasVideoDisabled: document.documentElement.classList.contains('ag-video-preview-disabled'),
                outerBg: getComputedStyle(outer).backgroundColor,
                starsClip: starsEl ? starsEl.style.clipPath : '',
                rightStarVis: rightStar ? getComputedStyle(rightStar).visibility : 'missing',
                rectCleared: !window.__agRightReadingRect,
              };
            }"""
        )
        check(
            "disabling rightReadingEnabled strips class, backdrop, starlight clip & mask cleanly",
            off_metrics["hasReading"] is False
            and off_metrics["hasVideoDisabled"] is True
            and off_metrics["outerBg"] == "rgba(0, 0, 0, 0)"
            and off_metrics["starsClip"] == ""
            and off_metrics["rightStarVis"] == "visible"
            and off_metrics["rectCleared"] is True,
            str(off_metrics),
        )

        # Re-enable default and then run restore.js + __agUiDispose()
        page.evaluate(bundle["payloads"]["defaultExpr"])
        page.wait_for_timeout(40)
        page.evaluate(restore_source)
        page.wait_for_timeout(40)
        restored = page.evaluate(
            """() => ({
              hasReading: document.documentElement.classList.contains('ag-right-reading'),
              hasVideoDisabled: document.documentElement.classList.contains('ag-video-preview-disabled'),
              cssVarBg: document.documentElement.style.getPropertyValue('--ag-right-reading-rgb'),
              cssVarSize: document.documentElement.style.getPropertyValue('--ag-right-code-size'),
              rectCleared: !window.__agRightReadingRect,
            })"""
        )
        check(
            "restore.js cleans reading classes, CSS variables, and mask state",
            restored["hasReading"] is False
            and restored["hasVideoDisabled"] is False
            and restored["cssVarBg"] == ""
            and restored["cssVarSize"] == ""
            and restored["rectCleared"] is True,
            str(restored),
        )

        check("Zero uncaught page errors during Playwright run", len(page_errors) == 0, str(page_errors))
        browser.close()

    passed = sum(1 for r in results if r["ok"])
    failed = [r for r in results if not r["ok"]]
    print(json.dumps({"suite": "right-reading", "total": len(results), "passed": passed, "failed": len(failed), "failures": failed}, ensure_ascii=False))
    sys.exit(0 if not failed else 1)


if __name__ == "__main__":
    main()
