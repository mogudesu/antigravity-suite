#!/usr/bin/env python3
"""Playwright regression & UI geometry test for adaptive Starlight Flowing Effort Slider (v5.2.0)."""

import json
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
APPLY_JS = HERE / "apply.js"
UI_ENHANCE_JS = HERE / "ui-enhance.js"

results = []


def check(name, ok, detail=""):
    results.append({"name": name, "ok": bool(ok), "detail": str(detail)[:300]})
    print(("PASS  " if ok else "FAIL  ") + name + (("  -> " + str(detail)[:220]) if detail and not ok else ""))


def extract_effort_css(apply_source: str) -> str:
    m_panel = re.search(r"/\* 18\. 模型选择面板.*?(?=/\* 19\.)", apply_source, re.S)
    m_pill = re.search(r"/\* 底栏思考强度：自适应流动星光条 \*/.*?(?=/\* Quest Complete)", apply_source, re.S)
    if not m_panel or not m_pill:
        raise RuntimeError("Could not locate starlight effort CSS blocks inside apply.js")
    return m_panel.group(0) + "\n" + m_pill.group(0)


HTML_FIXTURE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  body {
    margin: 0;
    padding: 32px;
    background: #0d1024;
    color: #e5e7eb;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .composer-bar {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: rgba(18, 20, 42, 0.72);
    border-radius: 12px;
  }
  .no-focus-agent-input {
    display: inline-flex;
    align-items: center;
  }
  [data-testid="model-selector-trigger"] {
    padding: 4px 10px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.06);
    color: #e5e7eb;
    border: 1px solid rgba(255, 255, 255, 0.14);
    font-size: 12px;
  }
  .menu-host {
    margin-top: 24px;
  }
  [role="menu"] {
    display: none;
    background: #141836;
    border-radius: 12px;
    border: 1px solid rgba(165, 180, 252, 0.22);
  }
  [role="menu"].is-open {
    display: block;
  }
</style>
</head>
<body>
  <div id="antigravity.agentSidePanelInputBox">
    <div contenteditable="true" aria-label="Message input"></div>
    <div class="composer-bar">
      <div class="no-focus-agent-input">
        <button data-testid="model-selector-trigger" type="button" aria-label="Select model, current: Gemini 4 Hydrogen Extra">
          Gemini 4 Hydrogen Extra
        </button>
      </div>
    </div>
  </div>
  <div class="menu-host">
    <div id="mock-menu" role="menu">
      <div data-testid="model-selector-panel">
        <div role="menuitem" aria-haspopup="menu">
          <div data-testid="model-selector-effort-group" data-model-base="Gemini 4 Hydrogen">Gemini 4 Hydrogen</div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>
"""


def setup_fiber_models():
    return """() => {
      const trigger = document.querySelector('[data-testid="model-selector-trigger"]');
      const makeOpt = (modelId, label, triggerLabel) => ({
        modelId,
        label,
        triggerLabel: triggerLabel || label,
      });

      const hydroMap = new Map([
        ['high', makeOpt('hydro-high', 'Gemini 4 Hydrogen (High)')],
        ['xhigh', makeOpt('hydro-xhigh', 'Gemini 4 Hydrogen (XHigh)', 'Gemini 4 Hydrogen Extra')],
        ['medium', makeOpt('hydro-med', 'Gemini 4 Hydrogen (Medium)')],
        ['low', makeOpt('hydro-low', 'Gemini 4 Hydrogen (Low)')],
      ]);

      const argonMap = new Map([
        ['high', makeOpt('argon-high', 'Gemini 4 Argon (High)')],
        ['low', makeOpt('argon-low', 'Gemini 4 Argon (Low)')],
        ['medium', makeOpt('argon-med', 'Gemini 4 Argon (Medium)')],
      ]);

      const duoMap = new Map([
        ['max', makeOpt('duo-max', 'Nova Dual (Max)')],
        ['minimal', makeOpt('duo-min', 'Nova Dual (Minimal)')],
      ]);

      const gptOssMap = new Map([
        ['medium', makeOpt('gpt-oss-120b', 'GPT-OSS 120B (Medium)')],
      ]);

      const effortIndex = new Map([
        ['Gemini 4 Hydrogen', hydroMap],
        ['Gemini 4 Argon', argonMap],
        ['Nova Dual', duoMap],
        ['GPT-OSS 120B', gptOssMap],
      ]);

      const ctx = {
        effortIndex,
        selectedModel: hydroMap.get('xhigh'),
        selectionLog: [],
        setSelectedModel(opt) {
          ctx.selectedModel = opt;
          ctx.selectionLog.push(opt.modelId);
          trigger.setAttribute('aria-label', 'Select model, current: ' + opt.triggerLabel);
          trigger.textContent = opt.triggerLabel;
          window.__agExtendedUiRefresh?.();
        },
      };

      trigger.__reactFiber$mock = {
        return: {
          memoizedProps: { value: ctx },
          return: null,
        },
      };
      window.__MOCK_CTX__ = ctx;
      window.__MOCK_MODELS__ = { hydroMap, argonMap, duoMap, gptOssMap };
      return true;
    }"""


def main():
    apply_src = APPLY_JS.read_text(encoding="utf-8")
    css_src = extract_effort_css(apply_src)
    ui_src = UI_ENHANCE_JS.read_text(encoding="utf-8")

    check("extracted starlight CSS from apply.js contains keyframes & pill",
          "@keyframes agStarlightFlow" in css_src and "#ag-effort-pill" in css_src and ".ag-model-effort" in css_src)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page_errors = []
        page.on("pageerror", lambda err: page_errors.append(str(err)))
        page.on("console", lambda msg: page_errors.append(f"[{msg.type}] {msg.text}") if msg.type == "error" else None)
        page.set_content(HTML_FIXTURE, wait_until="load")
        page.add_style_tag(content=css_src)
        page.evaluate(setup_fiber_models())
        page.add_script_tag(content=ui_src)
        page.wait_for_timeout(150)
        if page_errors:
            print("PAGE_ERRORS:", page_errors)

        # 1. Version & initial 4-tier Hydrogen Extra state
        state = page.evaluate("""() => {
          const pill = document.getElementById('ag-effort-pill');
          const track = pill?.querySelector('.ag-effort-track');
          const fill = pill?.querySelector('.ag-effort-fill');
          const thumb = pill?.querySelector('.ag-effort-thumb');
          const value = pill?.querySelector('.ag-effort-value');
          const ticks = Array.from(pill?.querySelectorAll('.ag-effort-ticks i') || []);
          const pillStyle = pill ? getComputedStyle(pill) : null;
          const fillStyle = fill ? getComputedStyle(fill) : null;
          const fillAfterStyle = fill ? getComputedStyle(fill, '::after') : null;
          const thumbStyle = thumb ? getComputedStyle(thumb) : null;
          const pillRect = pill ? pill.getBoundingClientRect() : null;
          const valRect = value ? value.getBoundingClientRect() : null;
          return {
            version: window.__agExtendedUiVersion,
            hasPill: !!pill,
            fixed: pill?.getAttribute('data-fixed'),
            role: track?.getAttribute('role'),
            min: track?.getAttribute('aria-valuemin'),
            max: track?.getAttribute('aria-valuemax'),
            now: track?.getAttribute('aria-valuenow'),
            valueText: value?.textContent?.trim(),
            tickCount: ticks.length,
            activeTicks: ticks.filter((n) => n.getAttribute('data-active') === 'true').map((n) => n.dataset.index),
            reachedTicks: ticks.filter((n) => n.getAttribute('data-reached') === 'true').map((n) => n.dataset.index),
            trackTravel: track?.style.getPropertyValue('--track-travel'),
            fillAnim: fillStyle?.animationName,
            fillBgSize: fillStyle?.backgroundSize,
            fillAfterAnim: fillAfterStyle?.animationName,
            thumbAnim: thumbStyle?.animationName,
            pillOverflow: pillStyle?.overflow,
            valScrollW: value?.scrollWidth,
            valClientW: value?.clientWidth,
            valInsidePill: !!(pillRect && valRect && valRect.right <= pillRect.right + 0.5 && valRect.left >= pillRect.left - 0.5),
          };
        }""")

        check("UI_VERSION is 5.3.0 and #ag-effort-pill mounted", state["version"] == "5.3.0" and state["hasPill"], state)
        check("4-tier Hydrogen Extra: unsorted Map sorted to 4 ticks at index 3 (极高)",
              state["fixed"] is None and state["role"] == "slider" and state["min"] == "0" and state["max"] == "3"
              and state["now"] == "3" and state["valueText"] == "极高" and state["tickCount"] == 4
              and state["activeTicks"] == ["3"] and state["reachedTicks"] == ["0", "1", "2", "3"],
              state)
        check("flowing starlight animations active on fill, comet ::after, and thumb pulse",
              "agStarlightFlow" in (state["fillAnim"] or "")
              and state["fillBgSize"] == "220% 100%"
              and "agStarlightComet" in (state["fillAfterAnim"] or "")
              and "agStarlightPulse" in (state["thumbAnim"] or ""),
              state)
        check("geometry: --track-travel > 0 and value label not clipped inside pill",
              float((state["trackTravel"] or "0").replace("px", "") or 0) > 0
              and state["valInsidePill"] is True
              and (state["valScrollW"] or 0) <= (state["valClientW"] or 0) + 1,
              state)

        # 2. Pointer drag from XHigh (right) -> Low (left)
        box = page.locator("#ag-effort-pill .ag-effort-track").bounding_box()
        assert box is not None
        page.mouse.move(box["x"] + box["width"] - 8, box["y"] + box["height"] / 2)
        page.mouse.down()
        page.mouse.move(box["x"] + 6, box["y"] + box["height"] / 2, steps=6)
        page.mouse.up()
        page.wait_for_timeout(120)

        after_drag = page.evaluate("""() => ({
          selectedId: window.__MOCK_CTX__.selectedModel.modelId,
          now: document.querySelector('#ag-effort-pill .ag-effort-track')?.getAttribute('aria-valuenow'),
          val: document.querySelector('#ag-effort-pill .ag-effort-value')?.textContent?.trim(),
        })""")
        check("pointer drag to left edge switches Hydrogen to low (index 0 / 低)",
              after_drag["selectedId"] == "hydro-low" and after_drag["now"] == "0" and after_drag["val"] == "低",
              after_drag)

        # 3. Keyboard ArrowRight / End / Alt+3 interaction
        page.locator("#ag-effort-pill .ag-effort-track").focus()
        page.keyboard.press("ArrowRight")
        page.wait_for_timeout(100)
        after_arrow = page.evaluate("() => window.__MOCK_CTX__.selectedModel.modelId")
        page.keyboard.press("End")
        page.wait_for_timeout(100)
        after_end = page.evaluate("() => window.__MOCK_CTX__.selectedModel.modelId")
        page.keyboard.press("Alt+3")
        page.wait_for_timeout(100)
        after_alt3 = page.evaluate("""() => ({
          selectedId: window.__MOCK_CTX__.selectedModel.modelId,
          val: document.querySelector('#ag-effort-pill .ag-effort-value')?.textContent?.trim(),
        })""")
        check("keyboard ArrowRight -> medium, End -> xhigh, Alt+3 -> high (高)",
              after_arrow == "hydro-med" and after_end == "hydro-xhigh"
              and after_alt3["selectedId"] == "hydro-high" and after_alt3["val"] == "高",
              {"arrow": after_arrow, "end": after_end, "alt3": after_alt3})

        # 4. Auto-adapt when switching to 3-tier Argon model
        page.evaluate("() => window.__MOCK_CTX__.setSelectedModel(window.__MOCK_MODELS__.argonMap.get('medium'))")
        page.wait_for_timeout(100)
        argon_state = page.evaluate("""() => ({
          max: document.querySelector('#ag-effort-pill .ag-effort-track')?.getAttribute('aria-valuemax'),
          now: document.querySelector('#ag-effort-pill .ag-effort-track')?.getAttribute('aria-valuenow'),
          ticks: document.querySelectorAll('#ag-effort-pill .ag-effort-ticks i').length,
          val: document.querySelector('#ag-effort-pill .ag-effort-value')?.textContent?.trim(),
        })""")
        check("3-tier Argon auto-adapts to 3 ticks, max=2, now=1 (中)",
              argon_state["max"] == "2" and argon_state["now"] == "1" and argon_state["ticks"] == 3 and argon_state["val"] == "中",
              argon_state)

        # 5. Auto-adapt when switching to 2-tier model (minimal / max)
        page.evaluate("() => window.__MOCK_CTX__.setSelectedModel(window.__MOCK_MODELS__.duoMap.get('max'))")
        page.wait_for_timeout(100)
        duo_state = page.evaluate("""() => {
          const pill = document.getElementById('ag-effort-pill');
          const val = pill?.querySelector('.ag-effort-value');
          const pillRect = pill?.getBoundingClientRect();
          const valRect = val?.getBoundingClientRect();
          return {
            max: pill?.querySelector('.ag-effort-track')?.getAttribute('aria-valuemax'),
            now: pill?.querySelector('.ag-effort-track')?.getAttribute('aria-valuenow'),
            ticks: pill?.querySelectorAll('.ag-effort-ticks i').length,
            label: val?.textContent?.trim(),
            clipped: !pillRect || !valRect || valRect.right > pillRect.right + 0.5,
          };
        }""")
        check("2-tier Nova Dual auto-adapts to 2 ticks, max=1, now=1 (极限) without clipping",
              duo_state["max"] == "1" and duo_state["now"] == "1" and duo_state["ticks"] == 2
              and duo_state["label"] == "极限" and duo_state["clipped"] is False,
              duo_state)

        # 6. Auto-adapt when switching to 1-tier fixed GPT-OSS 120B (Medium)
        page.evaluate("() => window.__MOCK_CTX__.setSelectedModel(window.__MOCK_MODELS__.gptOssMap.get('medium'))")
        page.wait_for_timeout(100)
        before_fixed_log_len = page.evaluate("() => window.__MOCK_CTX__.selectionLog.length")
        page.keyboard.press("Alt+1")
        page.wait_for_timeout(80)
        fixed_state = page.evaluate("""() => ({
          fixed: document.getElementById('ag-effort-pill')?.getAttribute('data-fixed'),
          role: document.querySelector('#ag-effort-pill .ag-effort-track')?.getAttribute('role'),
          ticks: document.querySelectorAll('#ag-effort-pill .ag-effort-ticks i').length,
          val: document.querySelector('#ag-effort-pill .ag-effort-value')?.textContent?.trim(),
          logLen: window.__MOCK_CTX__.selectionLog.length,
        })""")
        check("1-tier fixed GPT-OSS 120B shows data-fixed=true, role=status, 1 tick, Alt+1 ignored",
              fixed_state["fixed"] == "true" and fixed_state["role"] == "status"
              and fixed_state["ticks"] == 1 and fixed_state["val"] == "中"
              and fixed_state["logLen"] == before_fixed_log_len,
              fixed_state)

        # 7. Dropdown .ag-model-effort adaptive panel card (4-tier vs fixed)
        page.evaluate("""() => {
          window.__MOCK_CTX__.setSelectedModel(window.__MOCK_MODELS__.hydroMap.get('xhigh'));
          document.getElementById('mock-menu').classList.add('is-open');
          window.__agExtendedUiRefresh?.();
        }""")
        page.wait_for_timeout(120)
        menu_state = page.evaluate("""() => {
          const card = document.querySelector('.ag-model-effort');
          return {
            exists: !!card,
            badge: card?.querySelector('.ag-effort-tier-badge')?.textContent?.trim(),
            val: card?.querySelector('.ag-effort-value')?.textContent?.trim(),
            ticks: card?.querySelectorAll('.ag-effort-ticks i').length,
            scale: Array.from(card?.querySelectorAll('.ag-effort-scale span') || []).map((s) => s.textContent.trim()),
            rangeMax: card?.querySelector('input[type="range"]')?.max,
          };
        }""")
        check("dropdown .ag-model-effort renders dynamic 4-tier adaptive card",
              menu_state["exists"] and menu_state["badge"] == "4 档自适应"
              and menu_state["val"] == "极高" and menu_state["ticks"] == 4
              and menu_state["scale"] == ["低", "中", "高", "极高"] and menu_state["rangeMax"] == "3",
              menu_state)

        # 7b. Interactive range change inside dropdown .ag-model-effort
        page.evaluate("""() => {
          const range = document.querySelector('.ag-model-effort input[type="range"]');
          range.value = '1';
          range.dispatchEvent(new Event('input', { bubbles: true }));
          range.dispatchEvent(new Event('change', { bubbles: true }));
        }""")
        page.wait_for_timeout(120)
        after_menu_drag = page.evaluate("""() => ({
          selectedId: window.__MOCK_CTX__.selectedModel.modelId,
          cardVal: document.querySelector('.ag-model-effort .ag-effort-value')?.textContent?.trim(),
        })""")
        check("dropdown .ag-model-effort range change switches Hydrogen to medium (中)",
              after_menu_drag["selectedId"] == "hydro-med" and after_menu_drag["cardVal"] == "中",
              after_menu_drag)

        # 8. Pure DOM fallback (without React Fiber context)
        page.evaluate("""() => {
          document.getElementById('mock-menu').classList.remove('is-open');
          const trigger = document.querySelector('[data-testid="model-selector-trigger"]');
          delete trigger.__reactFiber$mock;
          trigger.setAttribute('aria-label', 'Select model, current: Gemini 4 Hydrogen Extra');
          trigger.dataset.agEffortTiers = 'low,medium,high,xhigh';
          window.__agExtendedUiRefresh?.();
        }""")
        page.wait_for_timeout(450)
        dom_fallback = page.evaluate("""() => ({
          max: document.querySelector('#ag-effort-pill .ag-effort-track')?.getAttribute('aria-valuemax'),
          now: document.querySelector('#ag-effort-pill .ag-effort-track')?.getAttribute('aria-valuenow'),
          val: document.querySelector('#ag-effort-pill .ag-effort-value')?.textContent?.trim(),
        })""")
        check("DOM fallback without Fiber reads Hydrogen Extra as 4 tiers at index 3 (极高)",
              dom_fallback["max"] == "3" and dom_fallback["now"] == "3" and dom_fallback["val"] == "极高",
              dom_fallback)

        # 9. Hot-upgrade clean disposal
        page.evaluate("() => window.__agUiDispose?.()")
        disposed = page.evaluate("""() => ({
          pillExists: !!document.getElementById('ag-effort-pill'),
          version: window.__agExtendedUiVersion,
        })""")
        check("__agUiDispose cleanly removes #ag-effort-pill and clears version",
              not disposed["pillExists"] and disposed["version"] is None,
              disposed)

        browser.close()

    failed = [r for r in results if not r["ok"]]
    print(json.dumps({
        "suite": "effort-slider",
        "total": len(results),
        "passed": len(results) - len(failed),
        "failed": len(failed),
        "failures": failed,
    }, ensure_ascii=False))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
