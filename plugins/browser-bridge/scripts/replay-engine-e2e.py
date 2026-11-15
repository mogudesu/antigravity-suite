#!/usr/bin/env python3
"""回放引擎能力 e2e：真实扩展 + 隔离端口 + workflowPath/vars 全链路。

覆盖 loop(vars 数组) / evaluate+saveAs / assert / if / retry / throttle /
newTab+selectTab / 过滤器 / 嵌套 trace / 硬断言断点 / soft 断言。

用法：py -3 scripts/replay-engine-e2e.py
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
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="ag-replay-"))
    ext_copy = tmp / "extension"
    shutil.copytree(ROOT / "extension", ext_copy)
    bg = ext_copy / "background.js"
    src = bg.read_text(encoding="utf-8")
    assert "port: 8767," in src, "expected DEFAULT_SETTINGS.port: 8767 in background.js"
    bg.write_text(src.replace("port: 8767,", f"port: {TEST_PORT},", 1), encoding="utf-8")

    mcp = Mcp(TEST_PORT)
    httpd = start_http()
    url = f"http://127.0.0.1:{httpd.server_address[1]}/fixture.html"

    init = mcp.call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "replay-engine-e2e", "version": "1"}})
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
        ctx = p.chromium.launch_persistent_context(str(tmp / "profile"), args=args, headless=False)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(url)
        page.bring_to_front()

        connected = False
        for _ in range(60):
            st = data_of(call_tool(mcp, "browser_status", {}, timeout=20))
            if st.get("bridge", {}).get("state") == "connected" and st.get("bridge", {}).get("port") == TEST_PORT:
                connected = True
                break
            time.sleep(0.5)
        check("extension connected on isolated port", connected, json.dumps(st.get("bridge", {}), ensure_ascii=False))
        if not connected:
            ctx.close(); mcp.close(); httpd.shutdown()
            print(f"\nRESULT: {passed} passed / {failed} failed")
            sys.exit(1)

        def write_workflow(name, obj):
            f = tmp / name
            f.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
            return str(f)

        section("loop / evaluate / assert / if / retry / throttle / 多标签")
        wf = {
            "schemaVersion": "1.0",
            "title": "回放引擎能力验收",
            "parameters": {"terms": {"type": "array", "default": ["one", "two", "three"]}},
            "steps": [
                {"type": "navigate", "url": url},
                {"type": "evaluate", "expression": "(() => document.title)()", "saveAs": "pageTitle", "synthesized": True},
                {"type": "assert", "name": "fixture 已加载", "expression": "(() => !!document.getElementById('username'))()", "synthesized": True},
                {
                    "type": "loop", "var": "term", "indexVar": "idx", "items": "{{terms}}",
                    "maxIterations": 10, "delayMs": 50, "synthesized": True,
                    "steps": [
                        {"type": "type", "locator": {"selector": "#username"}, "value": "{{term}}", "clear": True},
                        {"type": "assert", "name": "输入框等于 {{term}}",
                         "expression": "(() => document.getElementById('username').value === {{term|json}})()"},
                        {"type": "evaluate", "expression": "(() => document.getElementById('username').value)()", "saveAs": "lastTyped"},
                    ],
                },
                {"type": "assert", "name": "最后一轮输入是 three", "var": "lastTyped", "expected": "three", "synthesized": True},
                {"type": "type", "selector": "#username", "value": "顶层selector", "clear": True, "synthesized": True},
                {"type": "assert", "name": "顶层 selector 写法兼容", "expression": "(() => document.getElementById('username').value === '顶层selector')()", "synthesized": True},
                {"type": "if", "expression": "(() => !!document.getElementById('submit'))()", "synthesized": True,
                 "then": [{"type": "setVar", "name": "hasSubmit", "value": True}]},
                {"type": "assert", "name": "if 分支写入变量", "var": "hasSubmit", "expected": True, "synthesized": True},
                {"type": "throttle", "ms": 120, "synthesized": True},
                {"type": "retry", "times": 3, "delayMs": 60, "synthesized": True,
                 "steps": [
                     {"type": "evaluate", "expression": "(() => { window.__retryN = (window.__retryN || 0) + 1; return window.__retryN; })()", "saveAs": "retryN"},
                     {"type": "assert", "name": "重试到第 2 次才通过", "expression": "(() => window.__retryN >= 2)()"},
                 ]},
                {"type": "newTab", "url": "about:blank", "synthesized": True},
                {"type": "selectTab", "url": "fixture.html", "synthesized": True},
            ],
        }
        wf_path = write_workflow("workflow.replay-e2e.json", wf)
        res = call_tool(mcp, "browser_record_replay",
                        {"workflowPath": wf_path, "vars": {"terms": ["one", "two", "three"]}, "stepDelayMs": 50, "maxSteps": 200},
                        timeout=120)
        r = data_of(res)
        check("回放 ok", r.get("ok") is True, json.dumps({k: r.get(k) for k in ("ok", "error", "failedPath")}, ensure_ascii=False))
        check("validated == True", r.get("validated") is True, str(r.get("validated")))
        check("loop 迭代 3 次", r.get("iterations") == 3, str(r.get("iterations")))
        checks = r.get("checks") or []
        check("全部断言通过", len(checks) >= 6 and all(c.get("ok") for c in checks), json.dumps(checks, ensure_ascii=False)[:400])
        v = r.get("vars") or {}
        check("数组 vars 未被拍成字符串（3 个词都输入过）", v.get("lastTyped") == "three", json.dumps(v, ensure_ascii=False)[:300])
        check("evaluate + saveAs 生效", v.get("pageTitle") == "Bridge 测试页", str(v.get("pageTitle")))
        check("if 分支 setVar 生效", v.get("hasSubmit") is True, str(v.get("hasSubmit")))
        trace = r.get("trace") or []
        check("trace 含嵌套路径", any(len(t.get("path") or []) > 1 for t in trace), json.dumps(trace[-3:], ensure_ascii=False)[:300])
        check("retry 至少尝试 2 次", any((t.get("detail") or {}).get("attempts", 0) >= 2 for t in trace),
              json.dumps([t.get("detail") for t in trace if t.get("type") == "retry"], ensure_ascii=False))
        check("newTab / selectTab 切回 fixture 页", "fixture.html" in str(r.get("finalUrl")), str(r.get("finalUrl")))

        section("硬断言失败与断点回报")
        bad_path = write_workflow("workflow.replay-bad.json", {
            "steps": [
                {"type": "navigate", "url": url},
                {"type": "assert", "name": "故意失败", "expression": "(() => false)()", "synthesized": True},
                {"type": "note", "note": "不应执行"},
            ],
        })
        r2 = data_of(call_tool(mcp, "browser_record_replay", {"workflowPath": bad_path, "stepDelayMs": 50}, timeout=120))
        check("硬断言中断回放", r2.get("ok") is False, json.dumps({k: r2.get(k) for k in ("ok", "error")}, ensure_ascii=False))
        check("返回 failedStepIndex", r2.get("failedStepIndex") == 1, str(r2.get("failedStepIndex")))
        check("返回 failedPath", isinstance(r2.get("failedPath"), list) and len(r2.get("failedPath")) >= 1, str(r2.get("failedPath")))
        check("checks 记录失败项", any(not c.get("ok") for c in (r2.get("checks") or [])), json.dumps(r2.get("checks"), ensure_ascii=False)[:300])

        section("soft 断言不阻断")
        soft_path = write_workflow("workflow.replay-soft.json", {
            "steps": [
                {"type": "navigate", "url": url},
                {"type": "assert", "name": "软失败", "expression": "(() => false)()", "soft": True, "synthesized": True},
                {"type": "evaluate", "expression": "(() => 1 + 1)()", "saveAs": "two", "synthesized": True},
            ],
        })
        r3 = data_of(call_tool(mcp, "browser_record_replay", {"workflowPath": soft_path, "stepDelayMs": 50}, timeout=120))
        check("soft 断言不中断", r3.get("ok") is True, json.dumps({k: r3.get(k) for k in ("ok", "error")}, ensure_ascii=False))
        check("soft 失败被记录", any(c.get("soft") and not c.get("ok") for c in (r3.get("checks") or [])), json.dumps(r3.get("checks"), ensure_ascii=False)[:300])

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
