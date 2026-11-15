#!/usr/bin/env python3
"""Live Windows acceptance test for silent headless browser control.

Spawns mcp-server/server.js on an isolated test port and runs open -> click ->
type -> screenshot -> tabs(new) WITHOUT passing `mode`, verifying:
  1. Every action stays on mode="isolated", headless=true with instanceReused & sessionId.
  2. Zero visible Chromium/Edge OS top-level windows appear (Win32 EnumWindows).
  3. Foreground window HWND (Win32 GetForegroundWindow) never shifts.
"""

import ctypes
from ctypes import wintypes
import http.server
import json
import os
import pathlib
import socket
import socketserver
import subprocess
import sys
import threading

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = pathlib.Path(__file__).resolve().parent.parent

user32 = ctypes.windll.user32
EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def get_foreground_hwnd():
    return int(user32.GetForegroundWindow())


def get_window_text(hwnd):
    length = user32.GetWindowTextLengthW(hwnd)
    if length <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    return buf.value


def list_visible_windows():
    wins = []

    def cb(hwnd, _lparam):
        if user32.IsWindowVisible(hwnd):
            title = get_window_text(hwnd)
            if title:
                cls_buf = ctypes.create_unicode_buffer(256)
                user32.GetClassNameW(hwnd, cls_buf, 256)
                wins.append((int(hwnd), cls_buf.value, title))
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return wins


def free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class _ReusableServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def start_http():
    handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=str(ROOT / "scripts"), **k)
    httpd = _ReusableServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


class Mcp:
    def __init__(self, port):
        self.proc = subprocess.Popen(
            ["node", "mcp-server/server.js"],
            cwd=str(ROOT),
            env=dict(os.environ, AG_BRIDGE_PORT=str(port)),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            encoding="utf-8",
            errors="replace",
        )
        self.seq = 0
        self.stderr = []
        threading.Thread(target=self._drain_stderr, daemon=True).start()

    def _drain_stderr(self):
        for line in self.proc.stderr:
            self.stderr.append(line.rstrip())

    def call(self, method, params=None, timeout=60):
        self.seq += 1
        mid = self.seq
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}}) + "\n")
        self.proc.stdin.flush()
        result_box = {}

        def reader():
            while True:
                line = self.proc.stdout.readline()
                if not line:
                    result_box["err"] = RuntimeError("EOF")
                    return
                line = line.strip()
                if not line:
                    continue
                msg = json.loads(line)
                if msg.get("id") == mid:
                    result_box["msg"] = msg
                    return

        t = threading.Thread(target=reader, daemon=True)
        t.start()
        t.join(timeout)
        if "err" in result_box:
            raise result_box["err"]
        if "msg" not in result_box:
            raise TimeoutError(method)
        return result_box["msg"]

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


def data_of(res):
    content = ((res or {}).get("result") or {}).get("content", [])
    txt = "\n".join(c.get("text", "") for c in content if c.get("type") == "text")
    return json.loads(txt) if txt else {}


passed = 0
failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"  ✓ {name}")
    else:
        failed += 1
        print(f"  ✗ {name} — {detail}")


def main():
    port = free_port()
    httpd = start_http()
    url = f"http://127.0.0.1:{httpd.server_address[1]}/fixture.html"
    mcp = Mcp(port)
    try:
        init = mcp.call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "headless-acceptance", "version": "1"}})
        check("MCP handshake ok", init["result"]["serverInfo"]["name"] == "antigravity-browser-bridge")
        mcp.notify("notifications/initialized", {})

        fg_before = get_foreground_hwnd()
        vis_before = {h: (cls, title) for h, cls, title in list_visible_windows() if "Chrome_WidgetWin" in cls or "Edge" in title or "Chromium" in title}

        def assert_no_ui_disturbance(step_name):
            fg_now = get_foreground_hwnd()
            vis_now = {h: (cls, title) for h, cls, title in list_visible_windows() if "Chrome_WidgetWin" in cls or "Edge" in title or "Chromium" in title}
            new_wins = [v for k, v in vis_now.items() if k not in vis_before]
            check(f"{step_name}: foreground HWND unchanged ({fg_before})", fg_now == fg_before, f"before={fg_before} now={fg_now}")
            check(f"{step_name}: zero new visible browser/Chromium windows", len(new_wins) == 0, f"new={new_wins}")

        launch = data_of(mcp.call("tools/call", {"name": "browser_launch", "arguments": {}}))
        check("default browser_launch -> isolated + headless=true + instanceReused=false",
              launch.get("ok") is True and launch.get("mode") == "isolated" and launch.get("headless") is True and launch.get("instanceReused") is False and bool(launch.get("sessionId")),
              json.dumps(launch, ensure_ascii=False))
        assert_no_ui_disturbance("browser_launch")

        opened = data_of(mcp.call("tools/call", {"name": "browser_open", "arguments": {"url": url}}))
        check("browser_open -> isolated + headless=true",
              opened.get("ok") is True and opened.get("mode") == "isolated" and opened.get("headless") is True and "fixture.html" in str(opened.get("url")),
              json.dumps(opened, ensure_ascii=False))
        assert_no_ui_disturbance("browser_open")

        typed = data_of(mcp.call("tools/call", {"name": "browser_type", "arguments": {"selector": "#username", "text": "后台静默测试"}}))
        check("browser_type -> isolated + headless=true",
              typed.get("ok") is True and typed.get("mode") == "isolated" and typed.get("headless") is True,
              json.dumps(typed, ensure_ascii=False))
        assert_no_ui_disturbance("browser_type")

        clicked = data_of(mcp.call("tools/call", {"name": "browser_click", "arguments": {"selector": "#submit"}}))
        check("browser_click -> isolated + headless=true",
              clicked.get("ok") is True and clicked.get("mode") == "isolated" and clicked.get("headless") is True,
              json.dumps(clicked, ensure_ascii=False))
        assert_no_ui_disturbance("browser_click")

        eval_out = data_of(mcp.call("tools/call", {"name": "browser_evaluate", "arguments": {"expression": "document.getElementById('out').textContent"}}))
        check("form interaction committed in headless isolated page", eval_out.get("value") == "submitted:后台静默测试", json.dumps(eval_out, ensure_ascii=False))

        shot_raw = mcp.call("tools/call", {"name": "browser_screenshot", "arguments": {}})
        shot_content = (shot_raw.get("result") or {}).get("content", [])
        shot_img = next((c for c in shot_content if c.get("type") == "image"), None)
        shot_data = data_of(shot_raw)
        check("browser_screenshot -> image block + isolated + headless=true",
              shot_img is not None and len(shot_img.get("data", "")) > 200 and shot_data.get("mode") == "isolated" and shot_data.get("headless") is True,
              json.dumps(shot_data, ensure_ascii=False))
        assert_no_ui_disturbance("browser_screenshot")

        new_tab = data_of(mcp.call("tools/call", {"name": "browser_tabs", "arguments": {"action": "new", "url": url + "?second=1"}}))
        check("browser_tabs(new) -> isolated + headless=true",
              new_tab.get("ok") is True and new_tab.get("mode") == "isolated" and new_tab.get("headless") is True,
              json.dumps(new_tab, ensure_ascii=False))
        assert_no_ui_disturbance("browser_tabs_new")

        print(f"\nheadless-acceptance 结果：{passed} 通过 / {failed} 失败")
        return 1 if failed else 0
    finally:
        mcp.close()
        httpd.shutdown()


if __name__ == "__main__":
    sys.exit(main())
