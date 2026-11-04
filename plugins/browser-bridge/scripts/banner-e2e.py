#!/usr/bin/env python3
"""真实扩展端到端验证：控制时附加 CDP 触发浏览器原生提示条，且不注入额外页面顶栏。

安全隔离：
- 扩展复制到临时目录，并把默认端口改成一个随机空闲端口；
- MCP 服务也跑在这个端口；
- Playwright 使用全新的临时用户目录，不接触用户正在登录的 Edge/Chrome。
因此不会连到用户真实的 8767 桥接，也不会打开用户已登录的页面。

链路：本脚本 --(MCP stdio)--> server.js --(WebSocket)--> 临时扩展 --(scripting)--> 测试页
用法：py -3 scripts/banner-e2e.py
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
HOST_ID = "agbb-control-banner-host"
TEXT = "谷谷嘎嘎正在控制你的浏览器"
EVIDENCE = pathlib.Path(r"C:\Users\25350\Documents\Qoder\2026-10-30\bfec2f44\browser-banner-e2e.png")

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


def free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Mcp:
    def __init__(self, port):
        self.proc = subprocess.Popen(
            ["node", "mcp-server/server.js"],
            cwd=str(ROOT),
            env=dict(os.environ, AG_BRIDGE_PORT=str(port)),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
        )
        self.id = 0
        self.stderr = []
        self.bad = []
        threading.Thread(target=self._drain_err, daemon=True).start()

    def _drain_err(self):
        for line in self.proc.stderr:
            self.stderr.append(line.rstrip())

    def call(self, method, params=None, timeout=30):
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
            self.proc.wait(timeout=4)
        except Exception:
            self.proc.kill()


def text_of(res):
    r = (res or {}).get("result") or {}
    return "\n".join(c.get("text", "") for c in r.get("content", []) if c.get("type") == "text")


def call_tool(mcp, name, args=None, timeout=40):
    res = mcp.call("tools/call", {"name": name, "arguments": args or {}}, timeout=timeout)
    body = None
    try:
        body = json.loads(text_of(res))
    except Exception:
        body = {}
    return res, body


def banner_state(page):
    return page.evaluate(
        f"""(() => {{
          const h = document.getElementById('{HOST_ID}');
          if (!h || !h.shadowRoot) return null;
          const s = getComputedStyle(h);
          const r = h.getBoundingClientRect();
          return {{text: h.shadowRoot.querySelector('.label')?.textContent ?? null,
                   position: s.position, zIndex: s.zIndex, pointerEvents: s.pointerEvents,
                   opacity: s.opacity, top: s.top, viewportWidth: innerWidth,
                   rect: {{x: r.x, y: r.y, width: r.width, height: r.height}}}};
        }})()"""
    )


def wait_banner(page, want=True, timeout=4.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = banner_state(page)
        if (state is not None) == want:
            return state
        time.sleep(0.1)
    return banner_state(page)


class _ReusableServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def list_targets(ctx, page):
    try:
        cdp = ctx.new_cdp_session(page)
        return cdp.send("Target.getTargets").get("targetInfos", [])
    except Exception:
        return []


def find_extension_url(ctx, page):
    for w in ctx.service_workers:
        if (w.url or "").startswith("chrome-extension://"):
            return w.url
    for t in list_targets(ctx, page):
        url = t.get("url") or ""
        if t.get("type") in ("service_worker", "background_page") and url.startswith("chrome-extension://"):
            return url
    return None


def start_http():
    handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=str(ROOT / "scripts"), **k)
    httpd = _ReusableServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def build_temp_extension(port):
    dst = pathlib.Path(tempfile.mkdtemp(prefix="ag-ext-banner-")) / "extension"
    shutil.copytree(ROOT / "extension", dst)
    bg = dst / "background.js"
    src = bg.read_text(encoding="utf-8")
    needle = "port: 8767,"
    if src.count(needle) != 1:
        raise RuntimeError("background.js 里没找到唯一的默认端口，无法为测试改端口")
    bg.write_text(src.replace(needle, f"port: {port},", 1), encoding="utf-8")
    return dst


def main():
    port = free_port()
    mcp = Mcp(port)
    httpd = start_http()
    base = f"http://127.0.0.1:{httpd.server_address[1]}/fixture.html"
    user_data = tempfile.mkdtemp(prefix="ag-e2e-banner-")
    ext_dir = build_temp_extension(port)
    ctx = None
    try:
        init = mcp.call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "banner-e2e", "version": "1"}})
        check("MCP 握手成功", init["result"]["serverInfo"]["name"] == "antigravity-browser-bridge")
        mcp.notify("notifications/initialized", {})

        section(f"加载临时扩展（端口 {port}，独立浏览器配置）")
        with sync_playwright() as p:
            args = [
                f"--disable-extensions-except={ext_dir}",
                f"--load-extension={ext_dir}",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--no-first-run",
                "--no-default-browser-check",
            ]
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
                raise SystemExit(1)

            page = ctx.pages[0] if ctx.pages else ctx.new_page()

            connected = False
            for _ in range(80):
                res, body = call_tool(mcp, "browser_status")
                if not res["result"].get("isError") and body.get("bridge", {}).get("state") == "connected":
                    connected = True
                    break
                time.sleep(0.25)
            check("临时扩展自动连上隔离的 MCP 服务", connected,
                  "\n".join(mcp.stderr[-6:]))
            if not connected:
                raise SystemExit(1)

            section("浏览器可见名称与弹窗")
            ext_url = find_extension_url(ctx, page)
            ext_id = ext_url.split("/")[2] if ext_url else None
            check("定位到临时扩展", ext_url is not None,
                  "workers=" + str([w.url for w in ctx.service_workers]))
            if ext_url:
                popup = ctx.new_page()
                try:
                    popup.goto(f"chrome-extension://{ext_id}/popup.html")
                    popup.wait_for_selector("header strong")
                    popup_text = popup.evaluate(
                        """(() => { const m = chrome.runtime.getManifest();
                          return {title: document.title,
                                  name: document.querySelector('header strong').textContent,
                                  brand: document.querySelector('header .brand')?.textContent ?? null,
                                  manifestName: m.name, shortName: m.short_name,
                                  actionTitle: m.action && m.action.default_title,
                                  desc: m.description}; })()"""
                    )
                    check("浏览器里的扩展名就是原生提示条文案",
                          popup_text.get("manifestName") == "谷谷嘎嘎正在控制你的浏览器",
                          json.dumps(popup_text, ensure_ascii=False))
                    check("工具栏标题与品牌已更新",
                          popup_text.get("actionTitle") == "谷谷嘎嘎正在控制你的浏览器 · antigravity浏览器控制" and
                          popup_text.get("shortName") == "谷谷嘎嘎",
                          json.dumps(popup_text, ensure_ascii=False))
                    check("扩展描述提到专属分组与常驻鼠标",
                          "标签组" in (popup_text.get("desc") or "") and
                          "常驻" in (popup_text.get("desc") or "") and
                          "谷谷嘎嘎" in (popup_text.get("desc") or ""),
                          json.dumps(popup_text, ensure_ascii=False))
                    check("弹窗标题使用新名称",
                          popup_text.get("title") == "antigravity浏览器控制 · 谷谷嘎嘎",
                          json.dumps(popup_text, ensure_ascii=False))
                    check("弹窗头部显示新名称与谷谷嘎嘎品牌",
                          popup_text.get("name") == "antigravity浏览器控制" and
                          popup_text.get("brand") == "谷谷嘎嘎",
                          json.dumps(popup_text, ensure_ascii=False))
                except Exception as e:  # noqa: BLE001
                    check("弹窗可以打开", False, str(e))
                finally:
                    popup.close()

            def status_now():
                res, status = call_tool(mcp, "browser_status")
                return status

            def attached_tabs():
                return set(status_now().get("cdpAttachedTabs") or [])

            def tabs_list():
                res, body = call_tool(mcp, "browser_tabs", {"action": "list"})
                return body.get("tabs") or []

            def eval_value(tab_id, expression):
                res, body = call_tool(mcp, "browser_evaluate", {"tabId": tab_id, "expression": expression})
                if res.get("result", {}).get("isError"):
                    return None
                return body.get("value")

            def save_screenshot(tab_id, path):
                res = mcp.call(
                    "tools/call",
                    {"name": "browser_screenshot", "arguments": {"tabId": tab_id}},
                    timeout=60,
                )
                contents = res.get("result", {}).get("content", [])
                image = next((c for c in contents if c.get("type") == "image"), None)
                if not image:
                    return False
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(base64.b64decode(image["data"]))
                return True

            def tab_has_cursor_without_controlling(tab_id):
                if not ext_id:
                    return None
                probe = ctx.new_page()
                try:
                    probe.goto(f"chrome-extension://{ext_id}/popup.html")
                    return probe.evaluate(
                        """async (tabId) => {
                          const [result] = await chrome.scripting.executeScript({
                            target: { tabId },
                            world: 'ISOLATED',
                            func: () => !!document.getElementById('agbb-control-cursor-host'),
                          });
                          return !!(result && result.result);
                        }""",
                        tab_id,
                    )
                finally:
                    probe.close()

            user_page = page
            user_url = user_page.url
            user_tab = status_now().get("activeTab") or {}

            section("控制命令落在代理专属分组标签页")
            res, opened = call_tool(mcp, "browser_open", {"url": base})
            check("browser_open 打开测试页", opened.get("ok") is True, json.dumps(opened, ensure_ascii=False)[:200])
            check("代理页已加载", "fixture.html" in str(opened.get("url") or ""), opened.get("url"))
            lease_id = opened.get("tabId")
            time.sleep(0.8)
            after = status_now()
            check("代理页不是用户原标签页", lease_id != user_tab.get("id"),
                  f"lease={lease_id} user={user_tab.get('id')}")
            check("代理页已在用户窗口内可见",
                  after.get("activeTab", {}).get("id") == lease_id and
                  after.get("leaseWindow", {}).get("id") == user_tab.get("windowId"),
                  json.dumps({"active": after.get("activeTab"), "window": after.get("leaseWindow")}, ensure_ascii=False))
            check("用户原标签页仍打开且未被改写",
                  any(t.get("id") == user_tab.get("id") and t.get("url") == user_url for t in tabs_list()),
                  json.dumps([(t.get("id"), t.get("url")) for t in tabs_list()], ensure_ascii=False))
            group = after.get("leaseGroup") or {}
            check("代理页已打组标记",
                  group.get("title") == "谷谷嘎嘎控制中" and group.get("color") == "purple" and
                  after.get("leaseTab", {}).get("groupId") == group.get("id") and group.get("id") != -1,
                  json.dumps(group, ensure_ascii=False))
            check("状态报告 leaseTabId", after.get("leaseTabId") == lease_id)
            check("控制开始时已附加 CDP（原生提示条出现的前提）",
                  lease_id in attached_tabs(), json.dumps(sorted(attached_tabs())))
            cursor = after.get("leaseCursor") or {}
            check("代理页出现常驻可见鼠标",
                  cursor.get("visible") is True and cursor.get("persistent") is True,
                  json.dumps(cursor, ensure_ascii=False))
            check("可见鼠标不拦截点击", cursor.get("pointerEvents") == "none",
                  json.dumps(cursor, ensure_ascii=False))
            check("代理页没有额外顶栏",
                  eval_value(lease_id, f"document.getElementById('{HOST_ID}') === null") is True)
            check("用户页没有被注入控制层",
                  user_page.evaluate("!!document.getElementById('agbb-control-cursor-host')") is False)
            check("代理页正文看不到提示文案",
                  TEXT not in str(eval_value(lease_id, "document.body.innerText") or ""))
            check("代理页脚本没有 __AGBB_BANNER 全局（隔离世界）",
                  eval_value(lease_id, "typeof __AGBB_BANNER") == "undefined")

            section("控制会话期间鼠标常驻且用户页不受影响")
            time.sleep(5.5)
            still = status_now()
            still_cursor = still.get("leaseCursor") or {}
            check("5 秒后仍处于 CDP 控制状态", lease_id in attached_tabs(),
                  json.dumps(sorted(attached_tabs())))
            check("5 秒后鼠标仍常驻可见",
                  still_cursor.get("visible") is True and still_cursor.get("persistent") is True,
                  json.dumps(still_cursor, ensure_ascii=False))
            check("5 秒后用户原标签页仍在且未被改写",
                  any(t.get("id") == user_tab.get("id") and t.get("url") == user_url for t in tabs_list()))
            check("5 秒后代理页仍保持分组",
                  (still.get("leaseGroup") or {}).get("title") == "谷谷嘎嘎控制中",
                  json.dumps(still.get("leaseGroup"), ensure_ascii=False))
            res, snap = call_tool(mcp, "browser_snapshot", {})
            check("browser_snapshot 正常执行", snap.get("ok") is True, json.dumps(snap, ensure_ascii=False)[:160])
            check("snapshot 默认命中代理页", snap.get("tabId") == lease_id,
                  f"snap={snap.get('tabId')} lease={lease_id}")
            check("snapshot 不会额外注入顶栏",
                  eval_value(lease_id, f"document.getElementById('{HOST_ID}') === null") is True)

            section("新建代理标签页继续打组")
            res, created = call_tool(mcp, "browser_tabs", {"action": "new", "url": base + "?tab=2"})
            check("新建代理专属标签页", created.get("ok") is True and created.get("leased") is True,
                  json.dumps(created, ensure_ascii=False)[:200])
            check("第二个代理页已加载", "tab=2" in str(created.get("url") or ""), created.get("url"))
            new_tab = created.get("created")
            time.sleep(0.8)
            switched = status_now()
            new_group = switched.get("leaseGroup") or {}
            check("新页成为新的 leaseTab", switched.get("leaseTabId") == new_tab)
            check("新页与旧页在同一标签组",
                  new_group.get("id") == group.get("id") and new_group.get("title") == "谷谷嘎嘎控制中",
                  json.dumps(new_group, ensure_ascii=False))
            check("新页已激活可见",
                  switched.get("activeTab", {}).get("id") == new_tab,
                  json.dumps(switched.get("activeTab"), ensure_ascii=False))
            check("用户原标签页仍在且未被改写",
                  any(t.get("id") == user_tab.get("id") and t.get("url") == user_url for t in tabs_list()))
            tabs_now = set(switched.get("cdpAttachedTabs") or [])
            check("新页已附加 CDP", new_tab in tabs_now, json.dumps(sorted(tabs_now)))
            check("旧页已撤销原生提示条/鼠标", lease_id not in tabs_now, json.dumps(sorted(tabs_now)))
            check("旧页仍保留在分组中",
                  any(t.get("id") == lease_id and t.get("groupId") == group.get("id") for t in tabs_list()))
            time.sleep(0.4)
            check("旧代理页的鼠标已清理",
                  tab_has_cursor_without_controlling(lease_id) is False)
            res, closed = call_tool(mcp, "browser_tabs", {"action": "close", "tabId": new_tab})
            check("关闭新页并清空 lease", closed.get("ok") is True and closed.get("leaseCleared") is True,
                  json.dumps(closed, ensure_ascii=False)[:200])
            time.sleep(0.5)
            check("lease 已清空", status_now().get("leaseTabId") is None)

            section("受保护页面不影响工具调用")
            res, proto = call_tool(mcp, "browser_open", {"url": "chrome://version"})
            check("能打开 chrome:// 页面", proto.get("ok") is True, json.dumps(proto, ensure_ascii=False)[:200])
            res, bad = call_tool(mcp, "browser_snapshot", {})
            check("受保护页面上的页面动作返回正常错误",
                  res["result"].get("isError") is True and
                  ("受保护页面" in text_of(res) or "无法在页面注入脚本" in text_of(res)),
                  text_of(res)[:220])
            res, st = call_tool(mcp, "browser_status")
            check("受保护页面之后扩展仍然在线", st.get("bridge", {}).get("state") == "connected")
            check("受保护页面之后用户原标签页仍在",
                  any(t.get("id") == user_tab.get("id") and t.get("url") == user_url for t in tabs_list()))

            section("断开桥接时撤销浏览器原生控制条与鼠标")
            res, opened = call_tool(mcp, "browser_open", {"url": base + "?after-protected=1"})
            controlled_id = opened.get("tabId")
            check("回到普通页面后 CDP 已附加",
                  controlled_id in attached_tabs(), json.dumps(sorted(attached_tabs())))
            check("回到普通页面后仍没有额外顶栏",
                  eval_value(controlled_id, f"document.getElementById('{HOST_ID}') === null") is True)
            check("回到普通页面后鼠标常驻",
                  (status_now().get("leaseCursor") or {}).get("persistent") is True)
            check("页面截图包含常驻鼠标", save_screenshot(controlled_id, EVIDENCE))
            if EVIDENCE.is_file():
                print("  证据截图：%s (%d bytes)" % (EVIDENCE, EVIDENCE.stat().st_size))

            mcp.close()
            time.sleep(1.5)
            if ext_id:
                probe_page = ctx.new_page()
                try:
                    probe_page.goto(f"chrome-extension://{ext_id}/popup.html")
                    status = probe_page.evaluate(
                        "async () => await chrome.runtime.sendMessage({type: 'ag:status'})"
                    )
                    check("MCP 连接断开后调试器已全部撤销",
                          status.get("cdpTabId") is None,
                          json.dumps(status, ensure_ascii=False))
                finally:
                    probe_page.close()
                check("断开后受控页鼠标已清理",
                      tab_has_cursor_without_controlling(controlled_id) is False)
            else:
                check("MCP 连接断开后调试器已全部撤销", False, "no extension id")

    finally:
        if ctx is not None:
            try:
                ctx.close()
            except Exception:
                pass
        try:
            mcp.close()
        except Exception:
            pass
        try:
            httpd.shutdown()
        except Exception:
            pass
        shutil.rmtree(user_data, ignore_errors=True)
        shutil.rmtree(ext_dir.parent, ignore_errors=True)

    print(f"\n结果：{passed} 通过 / {failed} 失败")
    sys.exit(1 if failed else 0)


main()
