#!/usr/bin/env python3
"""专属后台窗口（不抢焦点）端到端验收 —— browser-bridge。

对应设计：docs/superpowers/specs/2026-11-10-browser-bridge-background-window-design.md

隔离：把扩展复制到临时目录，把 DEFAULT_SETTINGS.port 改成随机空闲端口，
MCP 服务也只监听该端口，因此绝不会连到用户真实的 8767 桥接；
Playwright 用全新临时 profile、headed Chromium（窗口焦点语义才真实）。

断言（设计文档「验证 e2e 断言」一节）：
  - lease 窗口 focused == False、lease 标签在该窗口内 active == True（截图 surface）
  - lease 标签与用户 activeTab 在不同窗口；控制动作后用户 activeTab / focused window 不变
  - browser_type / browser_click 只作用于 lease，用户原页面 DOM 不变
  - browser_screenshot 对后台窗口返回合法 PNG（CDP）
  - browser_tabs new / browser_open newTab 落在同一后台窗口且不抢焦点
  - 显式 browser_tabs activate 仍可前台化

SW 里会临时包装 chrome.* API，打印 FOCUSLOG 作为「没有抢焦点」的逐步证据。

用法：py -3 scripts/bg-window-e2e.py
"""
import base64
import http.server
import json
import os
import pathlib
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = pathlib.Path(__file__).resolve().parent.parent


def free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


TEST_PORT = free_port()

passed = 0
failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  OK  {name}")
    else:
        failed += 1
        print(f"  FAIL {name}" + (f"  -- {detail}" if detail else ""))


def section(t):
    print("\n" + t)


class Mcp:
    def __init__(self, port):
        self.proc = subprocess.Popen(
            ["node", "mcp-server/server.js"],
            cwd=str(ROOT),
            env=dict(os.environ, AG_BRIDGE_PORT=str(port)),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1, encoding="utf-8", errors="replace",
        )
        self.id = 0
        self.stderr = []
        threading.Thread(target=self._drain_err, daemon=True).start()

    def _drain_err(self):
        for line in self.proc.stderr:
            self.stderr.append(line.rstrip())

    def call(self, method, params=None, timeout=90):
        self.id += 1
        mid = self.id
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}}) + "\n")
        self.proc.stdin.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("MCP server exited early")
            try:
                msg = json.loads(line)
            except Exception:
                continue
            if msg.get("id") == mid:
                return msg
        raise TimeoutError(method)

    def notify(self, method, params=None):
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": method, "params": params or {}}) + "\n")
        self.proc.stdin.flush()

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def text_of(res):
    r = (res or {}).get("result") or {}
    return "\n".join(c.get("text", "") for c in r.get("content", []) if c.get("type") == "text")


def data_of(res):
    try:
        return json.loads(text_of(res))
    except Exception:
        return {}


def call_tool(mcp, name, args=None, timeout=90):
    return mcp.call("tools/call", {"name": name, "arguments": args or {}}, timeout=timeout)


class _ReusableServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def start_http():
    handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=str(ROOT / "scripts"), **k)
    httpd = _ReusableServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="ag-bgwin-"))
    ext_copy = tmp / "extension"
    shutil.copytree(ROOT / "extension", ext_copy)
    bg = ext_copy / "background.js"
    src = bg.read_text(encoding="utf-8")
    assert "port: 8767," in src, "expected DEFAULT_SETTINGS.port: 8767 in background.js"
    bg.write_text(src.replace("port: 8767,", f"port: {TEST_PORT},", 1), encoding="utf-8")
    print(f"  · patched copy extension default port -> {TEST_PORT} (real relay 8767 untouched)")

    mcp = Mcp(TEST_PORT)
    httpd = start_http()
    url = f"http://127.0.0.1:{httpd.server_address[1]}/fixture.html"
    user_data = tmp / "profile"

    init = mcp.call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "bgwin-verify", "version": "1"}})
    check("MCP handshake", init["result"]["serverInfo"]["name"] == "antigravity-browser-bridge")
    mcp.notify("notifications/initialized", {})

    ctx = None
    with sync_playwright() as p:
        args = [
            f"--disable-extensions-except={ext_copy}",
            f"--load-extension={ext_copy}",
            "--no-sandbox", "--disable-dev-shm-usage",
            "--no-first-run", "--no-default-browser-check",
        ]
        last_err = None
        for kwargs in ({"headless": False}, {"channel": "chromium", "headless": False}):
            try:
                ctx = p.chromium.launch_persistent_context(str(user_data), args=args, **kwargs)
                print("  · launch: " + json.dumps(kwargs))
                break
            except Exception as e:
                last_err = e
        if ctx is None:
            check("browser launches", False, str(last_err))
            print("\n".join(mcp.stderr[-10:]))
            mcp.close(); httpd.shutdown(); shutil.rmtree(tmp, ignore_errors=True)
            print(f"\nRESULT: {passed} passed / {failed} failed")
            sys.exit(1)

        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(url)
        page.bring_to_front()
        check("user fixture page loaded", "登录示例" in page.content())

        section("extension connects to isolated server")
        connected = False
        st = {}
        for _ in range(60):
            st = data_of(call_tool(mcp, "browser_status", {"mode": "extension"}, timeout=20))
            if st.get("bridge", {}).get("state") == "connected" and st.get("bridge", {}).get("port") == TEST_PORT:
                connected = True
                break
            time.sleep(0.5)
        if not connected:
            print("  ! extension did not connect; stderr tail:")
            print("\n".join(mcp.stderr[-12:]))
            print("  ! service workers: " + json.dumps([w.url for w in ctx.service_workers]))
        check(f"extension connected on isolated port {TEST_PORT}", connected, json.dumps(st.get("bridge", {}), ensure_ascii=False))
        if not connected:
            ctx.close(); mcp.close(); httpd.shutdown(); shutil.rmtree(tmp, ignore_errors=True)
            print(f"\nRESULT: {passed} passed / {failed} failed")
            sys.exit(1)
        launched = data_of(call_tool(mcp, "browser_launch", {"mode": "extension", "browser": "chrome", "waitConnectMs": 3000}))
        check("browser_launch switches session to extension", launched.get("ok") is True and launched.get("mode") == "extension", json.dumps(launched, ensure_ascii=False))

        expected_version = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))["version"]
        check(f"extensionVersion == {expected_version}", st.get("extensionVersion") == expected_version, str(st.get("extensionVersion")))
        initial_active = st.get("activeTab") or {}
        initial_win = initial_active.get("windowId")
        initial_tab = initial_active.get("id")
        check("no lease before control", st.get("leaseTabId") is None, json.dumps(st.get("leaseTabId")))
        print(f"  · user activeTab id={initial_tab} windowId={initial_win} url={initial_active.get('url')}")

        section("browser_open creates dedicated background window")
        opened = data_of(call_tool(mcp, "browser_open", {"url": url}))
        check("browser_open ok", opened.get("ok") is True and "fixture.html" in str(opened.get("url")), json.dumps(opened, ensure_ascii=False)[:240])
        st1 = data_of(call_tool(mcp, "browser_status", {}))
        lw = st1.get("leaseWindow") or {}
        lt = st1.get("leaseTab") or {}
        lg = st1.get("leaseGroup") or {}
        at1 = st1.get("activeTab") or {}
        print("  · leaseWindow=" + json.dumps(lw, ensure_ascii=False))
        print("  · leaseTab=" + json.dumps(lt, ensure_ascii=False))
        print("  · activeTab=" + json.dumps(at1, ensure_ascii=False))
        check("lease window focused == False", lw.get("focused") is False, json.dumps(lw))
        check("lease tab active == True (screenshot surface)", lt.get("active") is True, json.dumps(lt))
        check("lease tab in different window than user", lt.get("windowId") is not None and lt.get("windowId") != initial_win, f"leaseWin={lt.get('windowId')} userWin={initial_win}")
        check("user activeTab unchanged (no focus steal)", at1.get("id") == initial_tab, f"before={initial_tab} after={at1.get('id')}")
        check("lease group purple 谷谷嘎嘎控制中", lg.get("title") == "谷谷嘎嘎控制中" and lg.get("color") == "purple", json.dumps(lg, ensure_ascii=False))
        lease_win_id = lw.get("id")

        section("control acts on lease, user page untouched")
        typed = data_of(call_tool(mcp, "browser_type", {"selector": "#username", "text": "库库AI"}))
        check("browser_type ok", typed.get("ok") is True, json.dumps(typed, ensure_ascii=False)[:200])
        ev = data_of(call_tool(mcp, "browser_evaluate", {"expression": "document.getElementById('username').value"}))
        check("lease username == 库库AI", ev.get("value") == "库库AI", json.dumps(ev, ensure_ascii=False)[:200])
        clicked = data_of(call_tool(mcp, "browser_click", {"selector": "#submit"}))
        check("browser_click via CDP", clicked.get("ok") is True and clicked.get("engine") == "cdp", json.dumps(clicked, ensure_ascii=False)[:200])
        time.sleep(0.3)
        ev2 = data_of(call_tool(mcp, "browser_evaluate", {"expression": "document.getElementById('out').textContent"}))
        check("lease form submitted", ev2.get("value") == "submitted:库库AI", json.dumps(ev2, ensure_ascii=False)[:200])
        check("user original page username untouched", page.evaluate("document.getElementById('username').value") == "", repr(page.evaluate("document.getElementById('username').value")))
        st_ctrl = data_of(call_tool(mcp, "browser_status", {}))
        check("user activeTab still unchanged after type/click/evaluate", (st_ctrl.get("activeTab") or {}).get("id") == initial_tab, json.dumps(st_ctrl.get("activeTab"), ensure_ascii=False))

        section("screenshot on non-focused lease window")
        shot = call_tool(mcp, "browser_screenshot", {})
        content = (shot.get("result") or {}).get("content", [])
        img = next((c for c in content if c.get("type") == "image"), None)
        check("screenshot returns image block", img is not None and img.get("mimeType") == "image/png", json.dumps(content)[:160])
        if img:
            raw = base64.b64decode(img["data"])
            check("screenshot is valid PNG", raw[:8] == b"\x89PNG\r\n\x1a\n", raw[:8].hex())
            check("screenshot has real size", len(raw) > 2000, f"{len(raw)} bytes")
            out_png = tmp / "lease-screenshot.png"
            out_png.write_bytes(raw)
            print(f"  · saved {out_png} ({len(raw)} bytes)")
        shot_data = data_of(shot)
        check("screenshot engine == cdp", shot_data.get("engine") == "cdp", json.dumps(shot_data, ensure_ascii=False)[:200])
        st_shot = data_of(call_tool(mcp, "browser_status", {}))
        print("  · TRACE after screenshot: leaseWindow.focused=" + str((st_shot.get("leaseWindow") or {}).get("focused")) + " activeTab=" + json.dumps(st_shot.get("activeTab"), ensure_ascii=False))

        section("browser_tabs new lands in lease window")
        sw = ctx.service_workers[0]
        sw.evaluate("""(() => {
          globalThis.__focusLog = [];
          const snap = async () => (await chrome.windows.getAll({})).map(w=>({id:w.id,focused:w.focused}));
          const wrap = (obj, name, label) => {
            const orig = obj[name];
            if (typeof orig !== 'function') return;
            try {
              obj[name] = async function(...args) {
                const before = await snap();
                let r, err;
                try { r = await orig.apply(this, args); } catch(e){ err = String(e); }
                const after = await snap();
                globalThis.__focusLog.push({label, before, after, err});
                if (err) throw new Error(err);
                return r;
              };
            } catch(e){ globalThis.__focusLog.push({label, wrapErr:String(e)}); }
          };
          wrap(chrome.tabs,'create','tabs.create');
          wrap(chrome.tabs,'update','tabs.update');
          wrap(chrome.tabs,'group','tabs.group');
          wrap(chrome.windows,'update','windows.update');
          wrap(chrome.windows,'create','windows.create');
          wrap(chrome.debugger,'attach','debugger.attach');
          wrap(chrome.debugger,'detach','debugger.detach');
          wrap(chrome.scripting,'executeScript','scripting.executeScript');
          return true;
        })()""")
        created = data_of(call_tool(mcp, "browser_tabs", {"action": "new", "url": url}))
        check("browser_tabs new ok", created.get("ok") is True and created.get("created"), json.dumps(created, ensure_ascii=False)[:200])
        st2 = data_of(call_tool(mcp, "browser_status", {}))
        lt2 = st2.get("leaseTab") or {}
        lw2 = st2.get("leaseWindow") or {}
        check("new tab is the lease", lt2.get("id") == created.get("created"), f"lease={lt2.get('id')} created={created.get('created')}")
        check("new tab in same background window", lw2.get("id") == lease_win_id, f"win={lw2.get('id')} leaseWin={lease_win_id}")
        check("background window still not focused after new", lw2.get("focused") is False, json.dumps(lw2))
        check("user activeTab unchanged after tabs new", (st2.get("activeTab") or {}).get("id") == initial_tab, json.dumps(st2.get("activeTab"), ensure_ascii=False))
        print("  · FOCUSLOG during tabs new:")
        for entry in sw.evaluate("globalThis.__focusLog"):
            print("    " + json.dumps(entry, ensure_ascii=False))

        section("browser_open newTab lands in lease window")
        opened2 = data_of(call_tool(mcp, "browser_open", {"url": url, "newTab": True}))
        check("browser_open newTab ok", opened2.get("ok") is True and opened2.get("leased") is True, json.dumps(opened2, ensure_ascii=False)[:200])
        st3 = data_of(call_tool(mcp, "browser_status", {}))
        lw3 = st3.get("leaseWindow") or {}
        lt3 = st3.get("leaseTab") or {}
        check("newTab in same background window", lw3.get("id") == lease_win_id, f"win={lw3.get('id')} leaseWin={lease_win_id}")
        check("newTab is the lease", lt3.get("id") == opened2.get("tabId"), f"lease={lt3.get('id')} opened={opened2.get('tabId')}")
        check("user activeTab unchanged after open newTab", (st3.get("activeTab") or {}).get("id") == initial_tab, json.dumps(st3.get("activeTab"), ensure_ascii=False))

        section("explicit activate still foregrounds (opt-in)")
        act = data_of(call_tool(mcp, "browser_tabs", {"action": "activate", "tabId": lt3.get("id")}))
        check("activate ok", act.get("ok") is True, json.dumps(act, ensure_ascii=False)[:200])
        time.sleep(0.3)
        st4 = data_of(call_tool(mcp, "browser_status", {}))
        lw4 = st4.get("leaseWindow") or {}
        check("lease window focused == True after explicit activate", lw4.get("focused") is True, json.dumps(lw4))

        ctx.close()

    mcp.close()
    httpd.shutdown()
    if failed:
        print(f"\n  · temp dir kept for inspection: {tmp}")
    else:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\nRESULT: {passed} passed / {failed} failed")
    sys.exit(1 if failed else 0)


main()