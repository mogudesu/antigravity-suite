#!/usr/bin/env python3
"""Playwright harness for scripts/i18n-engine.js (Module 2, v3.0).

Run:
    py -3.13 scripts/i18n-engine.test.py
    python scripts/i18n-engine.test.py            # if playwright is on PATH

The harness loads scripts/i18n-engine.fixture.html (a faithful slice of the
Antigravity DOM), injects the engine, and proves:

  1. zh-CN translation of sample UI labels + dynamic templates
  2. byte-for-byte English restoration (document.body.innerHTML identical)
  3. placeholder/title translated, aria-label / data-testid / role untouched
  4. protected nodes untouched (code, pre, markdown body, chat, monaco, svg,
     textarea, contenteditable, project name, conversation title, input value)
  5. incremental MutationObserver translation of later DOM additions
  6. zh <-> en switching stays well under 100 ms on the sample
"""

import json
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
ENGINE = HERE / "i18n-engine.js"
FIXTURE = HERE / "i18n-engine.fixture.html"
SCREENSHOT = Path(r"C:\Users\25350\Documents\Qoder\2026-10-30\bfec2f44\i18n-test.png")
WARMUP = Path(tempfile.gettempdir()) / "ag-i18n-warmup.png"

results = []


def check(name, ok, detail=""):
    results.append({"name": name, "ok": bool(ok), "detail": str(detail)[:300]})
    print(("PASS  " if ok else "FAIL  ") + name + (("  -> " + str(detail)[:200]) if detail and not ok else ""))


def main():
    engine_src = ENGINE.read_text(encoding="utf-8")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.goto(FIXTURE.as_uri(), wait_until="load")

        # Chromium normalises editable form controls (adds style="") the first
        # time the page is captured. Warm up the capture path so the snapshot
        # below only measures changes made by the engine itself.
        page.screenshot(path=str(WARMUP))

        original = page.evaluate("() => document.body.innerHTML")
        original_testids = page.evaluate(
            "() => Array.from(document.querySelectorAll('[data-testid]')).map(e => e.getAttribute('data-testid'))"
        )
        original_arias = page.evaluate(
            "() => Array.from(document.querySelectorAll('[aria-label]')).map(e => e.getAttribute('aria-label'))"
        )
        original_roles = page.evaluate(
            "() => Array.from(document.querySelectorAll('[role]')).map(e => e.getAttribute('role'))"
        )
        original_elements = page.evaluate("() => document.body.querySelectorAll('*').length")

        # ---- 1. inject (engine auto-applies the initial language) -------------
        page.add_script_tag(content=engine_src)
        stats = page.evaluate("() => window.__agI18n.stats()")
        check("engine boots and is running", stats["running"] is True, stats)
        check("initial language zh-CN", stats["language"] == "zh-CN", stats["language"])
        check("dictionary has >= 520 entries", stats["dictionarySize"] >= 520, stats["dictionarySize"])

        page.screenshot(path=str(SCREENSHOT))

        def text(selector):
            return page.eval_on_selector(selector, "el => el.textContent.trim()")

        check("title menu Workspace -> 工作区", text('[data-testid="title-menu-bar-item"]') == "工作区", text('[data-testid="title-menu-bar-item"]'))
        check("sidebar Customizations -> 自定义配置", text('.bg-sidebar a[href="/customizations"]') == "自定义配置")
        check("New Conversation -> 新建对话", text('[data-testid="new-conversation-button"]') == "新建对话")
        check("Automations -> 自动化", text('[data-testid="automations-button"]') == "自动化")
        check("dynamic See all (17) -> 查看全部 (17)", text('[data-testid="see-all"]') == "查看全部 (17)", text('[data-testid="see-all"]'))
        check("artifact Implementation Plan -> 实施计划", text('[data-testid="artifact-view"] h2') == "实施计划", text('[data-testid="artifact-view"] h2'))
        check("settings modal General -> 常规", text('[data-testid="settings-modal"] [role="tab"]') == "常规")
        check("settings modal Appearance -> 外观", text('[data-testid="settings-modal"] button:last-child') == "外观")
        check("Copy button text -> 复制", text("#copy-btn") == "复制", text("#copy-btn"))
        check("markdown NOTE alert -> 说明", text(".markdown-alert-note .markdown-alert-title") == "说明")
        check("markdown IMPORTANT alert -> 重要", text(".markdown-alert-important .markdown-alert-title") == "重要")

        # ---- 2. attributes ------------------------------------------------
        check(
            "placeholder translated",
            page.eval_on_selector("#chat-input", "el => el.getAttribute('placeholder')") == "输入任何内容，用 @ 提及，/ 执行操作",
            page.eval_on_selector("#chat-input", "el => el.getAttribute('placeholder')"),
        )
        check(
            "title translated + original parked",
            page.eval_on_selector("#copy-btn", "el => el.getAttribute('title')") == "更多操作"
            and page.eval_on_selector("#copy-btn", "el => el.getAttribute('data-ag-orig-title')") == "More actions",
        )
        check("aria-label untouched (Copy)", page.eval_on_selector("#copy-btn", "el => el.getAttribute('aria-label')") == "Copy")
        check("aria-label untouched (Message input)", page.eval_on_selector("#chat-input", "el => el.getAttribute('aria-label')") == "Message input")
        check("aria-label untouched (dialog Settings)", page.eval_on_selector('[data-testid="settings-modal"]', "el => el.getAttribute('aria-label')") == "Settings")
        check("input value untouched", page.eval_on_selector("#chat-input", "el => el.value") == "Settings")

        # ---- 3. protected nodes -------------------------------------------
        check("chat user bubble untouched", text('[data-testid="user-message-bubble"]') == "Please fix the Settings bug")
        check("conversation title untouched", page.eval_on_selector('[data-testid="conversation-row-sidebar"] span', "el => el.textContent") == "Settings")
        check("project name untouched", page.eval_on_selector('[data-testid="project-header"] span', "el => el.textContent") == "MOGUProductionHub")
        check("markdown heading untouched", page.eval_on_selector("[data-markdown-root] h1", "el => el.textContent") == "Implementation Plan")
        check("markdown body untouched", page.eval_on_selector("[data-markdown-root] > p", "el => el.textContent") == "Settings will be updated by the agent.")
        check("code block untouched", page.eval_on_selector("pre code", "el => el.textContent") == "const Settings = { enabled: true };")
        check("monaco editor untouched", page.eval_on_selector(".monaco-editor", "el => el.textContent") == "Settings")
        check("svg title untouched", page.eval_on_selector("svg title", "el => el.textContent") == "Settings")
        check("textarea untouched", page.eval_on_selector("textarea", "el => el.value") == "Settings")
        check("kbd untouched", page.eval_on_selector("kbd", "el => el.textContent") == "Settings")
        check("contenteditable untouched", page.eval_on_selector('[contenteditable="true"]', "el => el.textContent") == "Settings")

        # ---- 4. incremental MutationObserver ------------------------------
        page.evaluate(
            """() => {
                const host = document.querySelector('[data-testid="artifact-view"]');
                const btn = document.createElement('button');
                btn.id = 'late-btn';
                btn.textContent = 'Open Settings';
                host.appendChild(btn);
            }"""
        )
        page.wait_for_timeout(260)
        check("mutation observer translates late node", text("#late-btn") == "打开设置", text("#late-btn"))
        page.evaluate("() => document.getElementById('late-btn').remove()")
        page.wait_for_timeout(60)

        # ---- 5. restore to exact English ----------------------------------
        page.evaluate("() => window.__agI18n.setLanguage('en')")
        restored = page.evaluate("() => document.body.innerHTML")
        check("English restore is byte-for-byte identical", restored == original, "lengths %d vs %d" % (len(restored), len(original)))
        check("no data-ag-orig-* leftovers", page.evaluate("() => document.querySelectorAll('[data-ag-orig-placeholder],[data-ag-orig-title]').length") == 0)
        check("element count unchanged", page.evaluate("() => document.body.querySelectorAll('*').length") == original_elements)
        check(
            "testids unchanged",
            page.evaluate("() => Array.from(document.querySelectorAll('[data-testid]')).map(e => e.getAttribute('data-testid'))") == original_testids,
        )
        check(
            "aria-labels unchanged",
            page.evaluate("() => Array.from(document.querySelectorAll('[aria-label]')).map(e => e.getAttribute('aria-label'))") == original_arias,
        )
        check(
            "roles unchanged",
            page.evaluate("() => Array.from(document.querySelectorAll('[role]')).map(e => e.getAttribute('role'))") == original_roles,
        )
        check("en state reports language en", page.evaluate("() => window.__agI18n.getLanguage()") == "en")

        # ---- 6. timings ----------------------------------------------------
        timing = page.evaluate(
            """() => {
                const t0 = performance.now();
                window.__agI18n.setLanguage('zh-CN');
                const zh = performance.now() - t0;
                const t1 = performance.now();
                window.__agI18n.setLanguage('en');
                const en = performance.now() - t1;
                return { zh: zh, en: en };
            }"""
        )
        check("zh switch < 100 ms", timing["zh"] < 100, timing)
        check("en switch < 100 ms", timing["en"] < 100, timing)

        # ---- 7. helper + stop() restore ------------------------------------
        helper = page.evaluate(
            """() => ({
                zh: window.__agI18n.translate('Settings', 'zh-CN'),
                en: window.__agI18n.translate('设置', 'en'),
                dyn: window.__agI18n.translate('See all (42)', 'zh-CN'),
                unknown: window.__agI18n.translate('Please fix my login', 'zh-CN')
            })"""
        )
        check("translate() EN->ZH", helper["zh"] == "设置", helper)
        check("translate() ZH->EN", helper["en"] == "Settings", helper)
        check("translate() dynamic template", helper["dyn"] == "查看全部 (42)", helper)
        check("translate() leaves arbitrary prose alone", helper["unknown"] is None, helper)

        page.evaluate("() => window.__agI18n.stop()")
        stopped = page.evaluate("() => ({ running: window.__agI18n.stats().running, html: document.body.innerHTML })")
        check("stop() disconnects observer", stopped["running"] is False)
        check("stop() leaves page in original English", stopped["html"] == original)
        check("stop() clears snapshots", page.evaluate("() => window.__agI18n.stats().translatedTextNodes") == 0)

        browser.close()

    failed = [r for r in results if not r["ok"]]
    print(json.dumps({
        "suite": "i18n-engine",
        "total": len(results),
        "passed": len(results) - len(failed),
        "failed": len(failed),
        "failures": failed,
        "screenshot": str(SCREENSHOT),
        "dictionarySize": stats["dictionarySize"],
    }, ensure_ascii=False))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
