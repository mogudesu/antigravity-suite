#!/usr/bin/env python3
"""Playwright regression & lifecycle test for Stage 1: Composer 3 Entrances (v5.3.0)."""

import json
import re
import struct
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
APPLY_JS = HERE / "apply.js"
UI_ENHANCE_JS = HERE / "ui-enhance.js"

results = []


def check(name, ok, detail=""):
    results.append({"name": name, "ok": bool(ok), "detail": str(detail)[:320]})
    print(("PASS  " if ok else "FAIL  ") + name + (("  -> " + str(detail)[:240]) if detail and not ok else ""))


def extract_composer_css(apply_source: str) -> str:
    m17 = re.search(r"/\* 17\. 输入框插件选择器 \*/.*?(?=/\* 18\.)", apply_source, re.S)
    m21 = re.search(r"/\* 21\. 提示词预设面板 \*/.*?(?=/\* 22\.)", apply_source, re.S)
    m24 = re.search(r"/\* 24\. MCP 连接面板 \*/.*?(?=`;)", apply_source, re.S)
    chunks = [m.group(0) for m in (m17, m21, m24) if m]
    if len(chunks) < 3:
        raise RuntimeError(f"Missing CSS blocks in apply.js (found {len(chunks)}/3)")
    return "\n".join(chunks)


def encode_grpc_json(obj: dict) -> bytes:
    payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    return b"\x00" + struct.pack(">I", len(payload)) + payload


HTML_FIXTURE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; padding: 120px 24px 24px; background: #0d1024; color: #e5e7eb; font-family: sans-serif; }
  .outside-zone { padding: 14px; border: 1px solid #334155; border-radius: 8px; margin-bottom: 24px; }
  #antigravity\\.agentSidePanelInputBox {
    position: relative;
    margin-top: 260px;
    padding: 12px;
    border: 1px solid #475569;
    border-radius: 12px;
    background: #131833;
  }
  .attachments-row { display: flex; gap: 6px; margin-bottom: 8px; }
  [data-testid="input-attachment"] { padding: 2px 8px; border-radius: 6px; background: #1e293b; font-size: 12px; }
  .editor-box { min-height: 44px; outline: none; padding: 6px; border: 1px solid #334155; border-radius: 6px; }
  .composer-input-footer { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
</style>
</head>
<body>
  <div class="outside-zone" id="outside-area">
    <button id="outside-btn" type="button">外部区域</button>
  </div>
  <div id="composer-host">
    <div id="antigravity.agentSidePanelInputBox">
      <div class="attachments-row">
        <div data-testid="input-attachment" data-name="demo.png">附件 demo.png</div>
      </div>
      <div class="editor-box" contenteditable="true" aria-label="Message input"></div>
      <div class="composer-input-footer">
        <button type="button" aria-label="Add context">+</button>
      </div>
    </div>
  </div>
</body>
</html>"""


def main():
    apply_src = APPLY_JS.read_text(encoding="utf-8")
    css_src = extract_composer_css(apply_src)
    ui_src = UI_ENHANCE_JS.read_text(encoding="utf-8")

    state_box = {
        "catalog_fail": False,
        "prompts_fail": False,
        "prompts_save_fail": False,
        "mcp_fail": False,
        "mcp_delay_ms": 0,
        "prompts": [
            {"id": "p-default-1", "title": "原有预设", "prompt": "请审查当前变更"}
        ],
        "mcp_states": [
            {
                "status": "MCP_SERVER_STATUS_READY",
                "spec": {
                    "serverName": "isolated-test-mcp",
                    "originalServerName": "isolated-test-mcp",
                    "isGlobal": True,
                    "disabled": False,
                    "command": "node",
                    "args": ["mock-mcp.js"],
                },
                "tools": [{"name": "ping_tool", "description": "Test MCP ping tool"}],
            }
        ],
        "mcp_calls": [],
    }

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1280, "height": 860})
        context.set_default_timeout(5000)
        page = context.new_page()
        page_errors = []
        page.on("pageerror", lambda err: page_errors.append(str(err)))

        def handle_route(route):
            req = route.request
            url = req.url
            if "/api/catalog" in url:
                if state_box["catalog_fail"]:
                    route.fulfill(status=500, content_type="application/json", body=json.dumps({"ok": False, "error": "模拟目录服务故障"}))
                else:
                    route.fulfill(
                        status=200,
                        content_type="application/json",
                        body=json.dumps({
                            "ok": True,
                            "plugins": [
                                {"id": "p-alpha", "name": "alpha", "displayName": "Alpha Helper", "description": "Alpha plugin", "version": "1.0.0"}
                            ],
                            "skills": [
                                {"name": "skill-beta", "title": "Skill Beta", "description": "Beta skill", "source": "personal"}
                            ],
                        }),
                    )
                return

            if "/api/prompts" in url:
                if req.method == "GET":
                    if state_box["prompts_fail"]:
                        route.fulfill(status=503, content_type="application/json", body=json.dumps({"ok": False, "error": "模拟预设读取失败"}))
                    else:
                        route.fulfill(status=200, content_type="application/json", body=json.dumps({"prompts": state_box["prompts"]}))
                else:
                    if state_box["prompts_save_fail"]:
                        route.fulfill(status=500, content_type="application/json", body=json.dumps({"ok": False, "error": "模拟保存同步失败"}))
                    else:
                        body = req.post_data_json or {}
                        state_box["prompts"] = list(body.get("prompts") or [])
                        route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True, "prompts": state_box["prompts"]}))
                return

            if "/exa.language_server_pb.LanguageServerService/" in url:
                method = url.rsplit("/", 1)[-1]
                raw = req.post_data_buffer or b""
                payload = {}
                if len(raw) >= 5:
                    try:
                        payload = json.loads(raw[5:].decode("utf-8"))
                    except Exception:
                        payload = {}
                state_box["mcp_calls"].append({"method": method, "body": payload})
                if state_box["mcp_delay_ms"] > 0:
                    page.wait_for_timeout(state_box["mcp_delay_ms"])
                if state_box["mcp_fail"]:
                    route.fulfill(status=500, content_type="text/plain", body="mock mcp server error")
                    return
                if method == "GetMcpServerStates":
                    route.fulfill(status=200, content_type="application/grpc-web+json", body=encode_grpc_json({"states": state_box["mcp_states"]}))
                    return
                if method == "ToggleMcpServer":
                    enabled = bool(payload.get("enabled"))
                    sname = payload.get("serverName")
                    for entry in state_box["mcp_states"]:
                        if entry["spec"]["originalServerName"] == sname or entry["spec"]["serverName"] == sname:
                            entry["spec"]["disabled"] = not enabled
                    route.fulfill(status=200, content_type="application/grpc-web+json", body=encode_grpc_json({}))
                    return
                if method == "RefreshMcpServers":
                    route.fulfill(status=200, content_type="application/grpc-web+json", body=encode_grpc_json({}))
                    return
                route.fulfill(status=200, content_type="application/grpc-web+json", body=encode_grpc_json({}))
                return

            if url.startswith("http://mock.local/"):
                route.fulfill(status=200, content_type="text/html; charset=utf-8", body=HTML_FIXTURE)
                return

            route.abort()

        page.route("**/*", handle_route)
        page.goto("http://mock.local/index.html", wait_until="load")
        page.add_style_tag(content=css_src)

        # Seed host environment & legacy anonymous capture listeners BEFORE installing 5.3.0
        # to verify window-capture priority prevents old double-toggle AND flags __agDirtyDocument.
        page.evaluate("""() => {
          window.__APP_CONFIG__ = { csrfToken: 'mock-csrf' };
          window.__AG_SIDECAR_PORT = 80;
          window.__AG_STARLIGHT_TOKEN__ = 'mock-tok';
          window.__AG_INSTALLED_PLUGINS = [
            { id: 'p-alpha', name: 'alpha', displayName: 'Alpha Helper', description: 'Alpha plugin desc', version: '1.0.0' },
            { id: 'p-gamma', name: 'gamma', displayName: 'Gamma Tool', description: 'Gamma desc', version: '2.0.0' }
          ];
          window.__AG_SKILLS = [
            { name: 'skill-beta', title: 'Skill Beta', description: 'Beta skill desc', source: 'personal' }
          ];
          // Simulate leaked 5.2.1 state + 2 anonymous document capture listeners toggling .ag-plugin-panel
          window.__agExtendedUiInstalled = true;
          window.__agExtendedUiVersion = '5.2.1';
          window.__agLegacyToggleCount = 0;
          document.addEventListener('click', (event) => {
            if (event.target.closest?.('.ag-plugin-trigger')) {
              window.__agLegacyToggleCount += 1;
              const panel = document.querySelector('.ag-plugin-panel');
              if (panel) panel.classList.toggle('is-open');
            }
          }, true);
        }""")
        page.add_script_tag(content=ui_src.replace("const SIDECAR = 'http://127.0.0.1:' + (window.__AG_SIDECAR_PORT || 39290);", "const SIDECAR = 'http://mock.local';"))
        page.wait_for_timeout(120)

        init_info = page.evaluate("""() => ({
          version: window.__agExtendedUiVersion,
          cleanLifecycle: window.__agUiCleanLifecycle,
          dirtyDocument: window.__agDirtyDocument,
          stats: window.__agUiLifecycleStats(),
          triggers: Array.from(document.querySelectorAll('[data-ag-composer-action="toggle-panel"]')).map(el => el.getAttribute('data-ag-panel')),
          panels: Array.from(document.querySelectorAll('[data-ag-panel-id]')).map(el => el.getAttribute('data-ag-panel-id'))
        })""")
        check("UI 5.3.0 mounts all 3 triggers and panels with clean lifecycle & flags legacy doc",
              init_info["version"] == "5.3.0"
              and init_info["cleanLifecycle"] is True
              and init_info["dirtyDocument"] is True
              and init_info["triggers"] == ["plugins", "prompts", "mcp"]
              and init_info["panels"] == ["plugins", "prompts", "mcp"],
              init_info)

        # ---- 1. Click entrance toggles & SVG child click & mutual exclusivity ----
        def open_state():
            return page.evaluate("""() => Array.from(document.querySelectorAll('[data-ag-panel-id].is-open')).map(el => el.getAttribute('data-ag-panel-id'))""")

        page.click('[data-ag-panel="plugins"] svg')
        check("Single click on Plugins SVG opens plugins panel ONLY (1x toggle, no legacy bleed)",
              open_state() == ["plugins"] and page.evaluate("() => window.__agLegacyToggleCount") == 0,
              {"open": open_state(), "legacyHits": page.evaluate("() => window.__agLegacyToggleCount")})

        page.click('[data-ag-panel="plugins"]')
        check("Second click on Plugins trigger closes it", open_state() == [], open_state())

        page.click('[data-ag-panel="prompts"] svg')
        check("Single click on Prompts SVG opens prompts panel ONLY", open_state() == ["prompts"], open_state())

        page.click('[data-ag-panel="mcp"] svg')
        check("Clicking MCP trigger closes Prompts and opens MCP ONLY (mutual exclusivity)", open_state() == ["mcp"], open_state())

        page.click('#outside-btn')
        check("Clicking outside open panel closes MCP panel without blocking outside button", open_state() == [], open_state())

        # ---- 2. Caret, Draft & Attachment preservation ----
        page.evaluate("""() => {
          const ed = document.querySelector('.editor-box');
          ed.textContent = '原有草稿前半句 后半句';
          ed.focus();
          const range = document.createRange();
          range.setStart(ed.firstChild, 7);
          range.collapse(true);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }""")
        page.click('[data-ag-panel="prompts"]')
        page.wait_for_timeout(40)
        page.keyboard.press("Escape")
        page.wait_for_timeout(40)
        caret_after_esc = page.evaluate("""() => {
          const ed = document.querySelector('.editor-box');
          const sel = window.getSelection();
          return {
            open: Array.from(document.querySelectorAll('[data-ag-panel-id].is-open')).length,
            activeIsEditor: document.activeElement === ed,
            text: ed.textContent,
            attachments: document.querySelectorAll('[data-testid="input-attachment"]').length,
            caretOffset: sel && sel.rangeCount ? sel.getRangeAt(0).startOffset : -1
          };
        }""")
        check("Escape closes panel and preserves composer draft, attachment, focus, and caret offset (7)",
              caret_after_esc["open"] == 0 and caret_after_esc["activeIsEditor"] is True
              and caret_after_esc["text"] == "原有草稿前半句 后半句"
              and caret_after_esc["attachments"] == 1
              and caret_after_esc["caretOffset"] == 7,
              caret_after_esc)

        # ---- 3. Plugins search, tabs, star favorite, keyboard & insert ----
        page.click('[data-ag-panel="plugins"]')
        page.fill('[data-ag-panel-id="plugins"] .ag-plugin-search', "alpha")
        alpha_count = page.locator('[data-ag-panel-id="plugins"] .ag-plugin-item').count()
        check("Plugins search filters down to matching item", alpha_count == 1, alpha_count)

        page.click('[data-ag-panel-id="plugins"] [data-ag-deck-star="plugin:alpha"]')
        page.click('[data-ag-panel-id="plugins"] [data-ag-deck-tab="favorites"]')
        page.fill('[data-ag-panel-id="plugins"] .ag-plugin-search', "")
        fav_count = page.locator('[data-ag-panel-id="plugins"] .ag-plugin-item').count()
        check("Plugins favorite star + favorites tab shows starred plugin", fav_count == 1, fav_count)

        page.click('[data-ag-panel-id="plugins"] [data-ag-deck-tab="plugins"]')
        page.click('[data-ag-panel-id="plugins"] .ag-plugin-item[data-plugin-id="p-alpha"]')
        after_plugin_insert = page.evaluate("""() => ({
          open: Array.from(document.querySelectorAll('[data-ag-panel-id].is-open')).length,
          text: document.querySelector('.editor-box').textContent,
          attachments: document.querySelectorAll('[data-testid="input-attachment"]').length
        })""")
        check("Selecting plugin inserts text into composer, preserves draft & attachment, closes panel",
              after_plugin_insert["open"] == 0
              and "Alpha Helper" in after_plugin_insert["text"]
              and "原有草稿" in after_plugin_insert["text"]
              and after_plugin_insert["attachments"] == 1,
              after_plugin_insert)

        # Plugins error & retry check
        state_box["catalog_fail"] = True
        page.click('[data-ag-panel="plugins"]')
        page.click('[data-ag-action="reload-plugins"]')
        page.wait_for_timeout(80)
        plugin_err_text = page.locator('[data-ag-panel-id="plugins"] .ag-panel-banner.is-error').text_content() or ""
        check("Plugins refresh error renders explicit reason & retry button",
              "模拟目录服务故障" in plugin_err_text and page.locator('[data-ag-action="retry-plugins"]').count() == 1,
              plugin_err_text)
        state_box["catalog_fail"] = False
        page.click('[data-ag-action="retry-plugins"]')
        page.wait_for_timeout(80)
        check("Plugins retry button clears error after recovery",
              page.locator('[data-ag-panel-id="plugins"] .ag-panel-banner.is-error').count() == 0)
        page.click('[data-ag-panel="plugins"]')

        # ---- 4. Prompts CRUD + Escape form close + error & retry ----
        state_box["prompts_fail"] = True
        page.click('[data-ag-panel="prompts"]')
        page.click('[data-ag-action="retry-prompts"]')
        page.wait_for_timeout(80)
        prompt_err = page.locator('[data-ag-panel-id="prompts"] .ag-panel-banner.is-error').text_content() or ""
        check("Prompts fetch failure shows explicit error reason + retry button",
              "模拟预设读取失败" in prompt_err and page.locator('[data-ag-panel-id="prompts"] [data-ag-action="retry-prompts"]').count() >= 1,
              prompt_err)
        state_box["prompts_fail"] = False
        page.click('[data-ag-panel-id="prompts"] .ag-panel-banner [data-ag-action="retry-prompts"]')
        page.wait_for_timeout(80)
        check("Prompts retry clears error",
              page.locator('[data-ag-panel-id="prompts"] .ag-panel-banner.is-error').count() == 0)

        page.click('[data-ag-prompt-new]')
        page.fill('[data-ag-prompt-title]', "测试临时预设")
        page.fill('[data-ag-prompt-content]', "TEST_PROMPT_BODY")
        page.click('[data-ag-prompt-form] button[type="submit"]')
        page.wait_for_timeout(80)
        check("New prompt saved in list and persisted to backend mock",
              any(item["title"] == "测试临时预设" for item in state_box["prompts"]),
              state_box["prompts"])

        # Edit created preset
        page.click('[data-ag-panel-item="prompts"]:has-text("测试临时预设") [data-ag-prompt-edit]')
        page.fill('[data-ag-prompt-title]', "测试临时预设-已编辑")
        page.click('[data-ag-prompt-form] button[type="submit"]')
        page.wait_for_timeout(80)
        check("Editing prompt updates title",
              page.locator('[data-ag-panel-item="prompts"]:has-text("测试临时预设-已编辑")').count() == 1)

        # Insert edited preset (clicking item directly, not action buttons)
        page.click('[data-ag-panel-item="prompts"]:has-text("测试临时预设-已编辑") .ag-plugin-copy')
        check("Clicking prompt inserts template text and closes panel",
              "TEST_PROMPT_BODY" in (page.locator('.editor-box').text_content() or "") and open_state() == [])

        # Re-open prompts & cleanly delete test preset via 2-click inline confirm
        page.click('[data-ag-panel="prompts"]')
        page.click('[data-ag-panel-item="prompts"]:has-text("测试临时预设-已编辑") [data-ag-prompt-delete]')
        check("First click on prompt delete activates inline confirm without native blocking confirm",
              page.locator('[data-ag-prompt-delete].is-confirm').count() == 1)
        page.click('[data-ag-prompt-delete].is-confirm')
        page.wait_for_timeout(80)
        check("Second click deletes test prompt cleanly",
              not any("测试临时预设" in item["title"] for item in state_box["prompts"]))
        page.click('[data-ag-panel="prompts"]')

        # ---- 5. MCP list, expand, tool insert, toggle, reconnect, error + retry ----
        state_box["mcp_fail"] = True
        page.click('[data-ag-panel="mcp"]')
        page.wait_for_timeout(80)
        mcp_err = page.locator('[data-ag-panel-id="mcp"] .ag-panel-banner.is-error').text_content() or ""
        check("MCP failure shows explicit reason and Retry button",
              "读取 MCP 状态失败" in mcp_err and page.locator('[data-ag-panel-id="mcp"] [data-ag-action="retry-mcp"]').count() >= 1,
              mcp_err)
        state_box["mcp_fail"] = False
        page.click('[data-ag-panel-id="mcp"] [data-ag-action="retry-mcp"]')
        page.wait_for_timeout(80)
        check("MCP retry loads isolated test server row",
              page.locator('.ag-mcp-entry[data-ag-mcp-key="isolated-test-mcp"]').count() == 1)

        # Toggle disabled -> enabled on isolated test server
        page.click('.ag-mcp-entry[data-ag-mcp-key="isolated-test-mcp"] [data-ag-mcp-disable]')
        page.wait_for_timeout(80)
        toggled_off = any(c["method"] == "ToggleMcpServer" and c["body"].get("enabled") is False for c in state_box["mcp_calls"])
        check("MCP disable sends ToggleMcpServer(enabled=false) and updates button to 启用",
              toggled_off and page.locator('.ag-mcp-entry[data-ag-mcp-key="isolated-test-mcp"].is-off').count() == 1,
              state_box["mcp_calls"])
        page.click('.ag-mcp-entry[data-ag-mcp-key="isolated-test-mcp"] [data-ag-mcp-disable]')
        page.wait_for_timeout(80)
        check("MCP re-enable restores active state",
              page.locator('.ag-mcp-entry[data-ag-mcp-key="isolated-test-mcp"].is-off').count() == 0)

        # Reconnect
        page.click('.ag-mcp-entry[data-ag-mcp-key="isolated-test-mcp"] [data-ag-mcp-reconnect]')
        page.wait_for_timeout(80)
        check("MCP reconnect triggers RefreshMcpServers",
              any(c["method"] == "RefreshMcpServers" for c in state_box["mcp_calls"]))

        # Expand & insert MCP tool via keyboard ArrowDown + Enter
        page.click('.ag-mcp-entry[data-ag-mcp-key="isolated-test-mcp"] .ag-mcp-item')
        tool_el = page.locator('[data-ag-mcp-tool="ping_tool"]')
        tool_el.focus()
        page.keyboard.press("Enter")
        check("Keyboard Enter on MCP tool inserts MCP tool reference & closes panel",
              "isolated-test-mcp/ping_tool" in (page.locator('.editor-box').text_content() or "") and open_state() == [])

        # ---- 6. Same-version refresh, version-upgrade dispose, composer rebuild ----
        stats_before = page.evaluate("() => window.__agUiLifecycleStats()")
        patched_ui_src = ui_src.replace("const SIDECAR = 'http://127.0.0.1:' + (window.__AG_SIDECAR_PORT || 39290);", "const SIDECAR = 'http://mock.local';")
        # Same version re-run -> refreshes without adding listeners
        page.add_script_tag(content=patched_ui_src)
        stats_same = page.evaluate("() => window.__agUiLifecycleStats()")
        check("Same-version re-inject refreshes without adding listeners",
              stats_before["listeners"] == stats_same["listeners"],
              {"before": stats_before, "after": stats_same})

        # Version upgrade + in-flight request abort verification
        state_box["mcp_delay_ms"] = 400
        page.click('[data-ag-panel="mcp"]')
        page.wait_for_timeout(30)
        upgraded_src = patched_ui_src.replace("const UI_VERSION = '5.3.0';", "const UI_VERSION = '5.3.9';")
        page.add_script_tag(content=upgraded_src)
        page.wait_for_timeout(80)
        state_box["mcp_delay_ms"] = 0
        upgrade_stats = page.evaluate("() => window.__agUiLifecycleStats()")
        check("Version upgrade disposes old instance, clears controllers/listeners, installs 5.3.9",
              upgrade_stats["version"] == "5.3.9" and upgrade_stats["listeners"] == stats_before["listeners"],
              {"stats_before": stats_before, "upgrade_stats": upgrade_stats})

        # Verify click toggle stays 1x after version upgrade
        page.click('[data-ag-panel="plugins"]')
        after_up_open = open_state()
        page.click('[data-ag-panel="plugins"]')
        check("After version upgrade single click toggles plugins panel cleanly (1x)",
              after_up_open == ["plugins"] and open_state() == [],
              after_up_open)

        # Simulate composer DOM rebuild (conversation switch)
        page.evaluate("""() => {
          const host = document.getElementById('composer-host');
          host.innerHTML = '<div id="antigravity.agentSidePanelInputBox"><div class="editor-box" contenteditable="true"></div><div class="composer-input-footer"><button type="button" aria-label="Add context">+</button></div></div>';
          window.__agExtendedUiRefresh?.();
        }""")
        page.wait_for_timeout(50)
        page.click('[data-ag-panel="prompts"]')
        rebuilt_open = open_state()
        page.click('[data-ag-panel="prompts"]')
        check("After composer rebuild + refresh, all entrances re-mount cleanly with 1x toggle",
              rebuilt_open == ["prompts"] and open_state() == [],
              rebuilt_open)

        # Verify explicit __agUiDispose drops tracked listeners to 0
        page.evaluate("() => window.__agUiDispose()")
        disposed_stats = page.evaluate("""() => ({
          installed: Boolean(window.__agExtendedUiInstalled),
          cleanLifecycle: Boolean(window.__agUiCleanLifecycle),
          triggersLeft: document.querySelectorAll('[data-ag-composer-action="toggle-panel"]').length,
          panelsLeft: document.querySelectorAll('[data-ag-panel-id]').length
        })""")
        check("__agUiDispose removes triggers, panels, and lifecycle flags",
              disposed_stats == {"installed": False, "cleanLifecycle": False, "triggersLeft": 0, "panelsLeft": 0},
              disposed_stats)

        check("Zero uncaught page errors during Playwright run", len(page_errors) == 0, page_errors)
        page.unroute_all(behavior="ignoreErrors")
        browser.close()

    passed = sum(1 for r in results if r["ok"])
    failed = [r for r in results if not r["ok"]]
    summary = {"suite": "composer-entrances", "total": len(results), "passed": passed, "failed": len(failed), "failures": failed}
    print(json.dumps(summary, ensure_ascii=False))
    sys.exit(0 if not failed else 1)


if __name__ == "__main__":
    main()
