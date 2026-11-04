#!/usr/bin/env python3
"""端到端验收：真实加载 MV3 扩展 + 真实 MCP stdio 服务，验证完整链路。

链路：本脚本 --(MCP stdio)--> server.js --(WebSocket)--> 扩展 service worker --(CDP/页面脚本)--> 网页
用法：python3 scripts/e2e-test.py
"""
import http.server
import json
import os
import pathlib
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
PORT = 8765  # 扩展默认端口，E2E 不改扩展配置

passed = 0
failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ✓ {name}")
    else:
        failed += 1
        print(f"  ✗ {name}" + (f"  —— {detail}" if detail else ""))


def section(t):
    print("\n" + t)


class Mcp:
    def __init__(self, port):
        self.proc = subprocess.Popen(
            ["node", "mcp-server/server.js"],
            cwd=str(ROOT),
            env=dict(os.environ, AG_BRIDGE_PORT=str(port)),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1,
        )
        self.id = 0
        self.stderr = []
        self.bad = []
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
                raise RuntimeError("MCP 服务提前退出")
            try:
                msg = json.loads(line)
            except Exception:
                self.bad.append(line)
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
    parts = [c.get("text", "") for c in r.get("content", []) if c.get("type") == "text"]
    return "\n".join(parts)


def data_of(res):
    r = (res or {}).get("result") or {}
    txt = text_of(res)
    try:
        return json.loads(txt)
    except Exception:
        return {}


def call_tool(mcp, name, args=None, timeout=90):
    return mcp.call("tools/call", {"name": name, "arguments": args or {}}, timeout=timeout)


class _ReusableServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def start_http():
    handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=str(ROOT / "scripts"), **k)
    httpd = _ReusableServer(("127.0.0.1", 0), handler)  # 端口交给系统分配，避免占用冲突
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    mcp = Mcp(PORT)
    httpd = start_http()
    url = f"http://127.0.0.1:{httpd.server_address[1]}/fixture.html"
    user_data = tempfile.mkdtemp(prefix="ag-e2e-")

    init = mcp.call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "e2e", "version": "1"}})
    check("MCP 握手成功", init["result"]["serverInfo"]["name"] == "antigravity-browser-bridge")
    mcp.notify("notifications/initialized", {})

    section("加载真实扩展")
    with sync_playwright() as p:
        args = [
            f"--disable-extensions-except={ROOT / 'extension'}",
            f"--load-extension={ROOT / 'extension'}",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--no-first-run",
            "--no-default-browser-check",
        ]
        ctx = None
        last_err = None
        for kwargs in (
            {"channel": "chromium", "headless": True},
            {"headless": True},
            {"channel": "chromium", "headless": False},
        ):
            try:
                ctx = p.chromium.launch_persistent_context(user_data, args=args, **kwargs)
                print("  · 启动参数：" + json.dumps(kwargs, ensure_ascii=False))
                break
            except Exception as e:  # noqa: BLE001
                last_err = e
        if ctx is None:
            check("浏览器能启动", False, str(last_err))
            print(f"\n结果：{passed} 通过 / {failed} 失败")
            sys.exit(1)

        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(url)
        check("测试页可访问", "登录示例" in page.content())

        section("扩展连接本地 MCP 服务")
        connected = False
        for _ in range(40):
            st = call_tool(mcp, "browser_status", {}, timeout=20)
            if not data_of(st).get("isError") and "NO_EXTENSION" not in text_of(st):
                connected = True
                break
            time.sleep(0.5)
        if not connected:
            print("  ! 扩展未在 20s 内连上，stderr 摘要：")
            print("\n".join(mcp.stderr[-8:]))
            print("  ! 已加载的 service worker：" + json.dumps([w.url for w in ctx.service_workers]))
        check("扩展自动连上桥接服务", connected)

        if not connected:
            ctx.close()
            mcp.close()
            print(f"\n结果：{passed} 通过 / {failed} 失败")
            sys.exit(1)

        status = data_of(call_tool(mcp, "browser_status"))
        check("browser_status 报告浏览器类型", status.get("browser") in ("chromium", "chrome"), json.dumps(status)[:200])
        check("browser_status 报告标签页数", isinstance(status.get("tabs"), int) and status["tabs"] >= 1, json.dumps(status)[:200])

        section("导航")
        opened = data_of(call_tool(mcp, "browser_open", {"url": url}))
        check("browser_open 打开成功", opened.get("ok") is True and "fixture.html" in str(opened.get("url")), json.dumps(opened)[:240])

        section("snapshot 与 ref")
        snap = data_of(call_tool(mcp, "browser_snapshot", {}))
        text = snap.get("snapshot", "")
        check("snapshot 拿到页面结构", snap.get("ok") is True and 'textbox "用户名"' in text, text[:240])
        refs = {}
        for line in text.splitlines():
            if "[ref=" not in line:
                continue
            ref = line.split("[ref=")[1].split("]")[0]
            if '"用户名"' in line:
                refs["username"] = ref
            if '"登录"' in line:
                refs["submit"] = ref
            if '"城市"' in line or "combobox" in line:
                refs.setdefault("city", ref)
        check("解析出用户名与按钮 ref", "username" in refs and "submit" in refs, json.dumps(refs))

        section("真实点击 / 输入（CDP 通道）")
        typed = data_of(call_tool(mcp, "browser_type", {"ref": refs.get("username"), "text": "库库AI"}))
        check("browser_type 写入页面", typed.get("ok") is True and typed.get("value") == "库库AI", json.dumps(typed)[:240])
        check("页面里确实变了", page.evaluate("document.getElementById('username').value") == "库库AI")

        clicked = data_of(call_tool(mcp, "browser_click", {"ref": refs.get("submit")}))
        check("browser_click 走 CDP", clicked.get("ok") is True and clicked.get("engine") == "cdp", json.dumps(clicked)[:240])
        time.sleep(0.4)
        check("点击真的提交了表单", page.evaluate("document.getElementById('out').textContent") == "submitted:库库AI",
              page.evaluate("document.getElementById('out').textContent"))

        section("evaluate / 选择 / 取文本")
        ev = data_of(call_tool(mcp, "browser_evaluate", {"expression": "document.title + '|' + (2*3)"}))
        check("browser_evaluate 返回页面值", ev.get("value") == "Bridge 测试页|6", json.dumps(ev)[:240])
        sel = data_of(call_tool(mcp, "browser_select_option", {"ref": refs.get("city"), "label": "上海"}))
        check("browser_select_option 生效", sel.get("ok") is True and page.evaluate("document.getElementById('city').value") == "sh", json.dumps(sel)[:240])
        gt = data_of(call_tool(mcp, "browser_get_text", {"selector": "#out"}))
        check("browser_get_text 取到文本", gt.get("text") == "submitted:库库AI", json.dumps(gt)[:240])

        section("截图 / 控制台 / 滚动")
        shot = call_tool(mcp, "browser_screenshot", {})
        content = shot["result"]["content"]
        check("截图返回 image 内容块", content[0].get("type") == "image" and content[0].get("mimeType") == "image/png")
        import base64
        raw = base64.b64decode(content[0]["data"])
        check("截图是合法 PNG", raw[:8] == b"\x89PNG\r\n\x1a\n", raw[:8].hex())
        check("截图有实际尺寸", len(raw) > 2000, f"{len(raw)} bytes")

        page.evaluate("console.log('来自 E2E 的日志')")
        time.sleep(0.5)
        logs = data_of(call_tool(mcp, "browser_console", {}))
        check("browser_console 采到日志", any("来自 E2E 的日志" in str(e.get("text")) for e in logs.get("entries", [])), json.dumps(logs)[:240])

        scrolled = data_of(call_tool(mcp, "browser_scroll", {"direction": "down", "amount": 700}))
        check("browser_scroll 生效", page.evaluate("scrollY") > 0, json.dumps(scrolled)[:240])

        section("等待 / 标签页管理")
        waited = data_of(call_tool(mcp, "browser_wait_for", {"text": "延迟出现的内容", "timeoutMs": 4000}))
        check("browser_wait_for 等到内容", waited.get("ok") is True, json.dumps(waited)[:240])
        created = data_of(call_tool(mcp, "browser_tabs", {"action": "new", "url": url}))
        check("browser_tabs new 新建标签页", created.get("ok") is True and created.get("created"), json.dumps(created)[:240])
        listed = data_of(call_tool(mcp, "browser_tabs", {"action": "list"}))
        check("browser_tabs list 数量增加", listed.get("count", 0) >= 2, json.dumps(listed)[:200])
        closed = data_of(call_tool(mcp, "browser_tabs", {"action": "close", "tabId": created.get("created")}))
        check("browser_tabs close 关闭成功", closed.get("ok") is True, json.dumps(closed)[:200])

        section("错误路径")
        bad_ref = data_of(call_tool(mcp, "browser_click", {"ref": "e999"}))
        bad_raw = call_tool(mcp, "browser_click", {"ref": "e999"})
        check("无效 ref 返回可读错误并标记 isError",
              data_of(bad_raw).get("ok") is False and "未找到目标元素" in str(data_of(bad_raw).get("error")) and bad_raw["result"]["isError"] is True,
              json.dumps(data_of(bad_raw), ensure_ascii=False)[:240])
        waittimeout = call_tool(mcp, "browser_wait_for", {"selector": "#never-exists", "timeoutMs": 600})
        check("ok:false 的结果被标记为 isError",
              waittimeout["result"]["isError"] is True and data_of(waittimeout).get("ok") is False,
              json.dumps(waittimeout["result"], ensure_ascii=False)[:240])
        unsupported = data_of(call_tool(mcp, "browser_open", {"url": "edge://settings"}))
        check("浏览器不接受的地址会明确报错", unsupported.get("ok") is False and "没有接受这个地址" in str(unsupported.get("error")),
              json.dumps(unsupported, ensure_ascii=False)[:240])
        proto = call_tool(mcp, "browser_open", {"url": "chrome://version"})
        check("能打开 chrome:// 页面", data_of(proto).get("ok") is True and str(data_of(proto).get("url")).startswith("chrome://"),
              json.dumps(data_of(proto), ensure_ascii=False)[:200])
        protected = call_tool(mcp, "browser_snapshot", {})
        check("受保护页面上的页面动作给出明确错误",
              "受保护页面" in text_of(protected) or "无法在页面注入脚本" in text_of(protected), text_of(protected)[:240])


        ctx.close()

    mcp.close()
    httpd.shutdown()
    shutil.rmtree(user_data, ignore_errors=True)

    print(f"\n结果：{passed} 通过 / {failed} 失败")
    sys.exit(1 if failed else 0)


main()
