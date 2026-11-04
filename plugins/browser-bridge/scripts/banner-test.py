#!/usr/bin/env python3
"""在真实 Chromium 里验证「谷谷嘎嘎正在控制你的浏览器」提示条。

不加载扩展、不碰用户的登录页：把 extension/banner-page.js 注入 Playwright 的
临时浏览器页面（与扩展隔离世界相同的 DOM 行为），断言文案、定位、样式、
自动隐藏、续期、去重、多标签切换与页面动作层互不干扰，并合成验收截图。

用法：py -3 scripts/banner-test.py
证据：C:\\Users\\25350\\Documents\\Qoder\\2026-10-30\\bfec2f44\\browser-banner-test.png
"""

import json
import pathlib
import sys
import tempfile
import time

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = (ROOT / "extension" / "banner-page.js").read_text(encoding="utf-8")
ACTIONS = (ROOT / "extension" / "page-actions.js").read_text(encoding="utf-8")
FIXTURE = (ROOT / "scripts" / "fixture.html").resolve()
EVIDENCE = pathlib.Path(r"C:\Users\25350\Documents\Qoder\2026-10-30\bfec2f44\browser-banner-test.png")

TEXT = "谷谷嘎嘎正在控制你的浏览器"
HOST_ID = "agbb-control-banner-host"

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


def show(page, opts=None):
    if opts is None:
        return page.evaluate("__AGBB_BANNER.show()")
    return page.evaluate("(o) => __AGBB_BANNER.show(o)", opts)


def host_count(page):
    return page.evaluate(f"document.querySelectorAll('#{HOST_ID}').length")


def label_text(page):
    return page.evaluate(
        f"document.getElementById('{HOST_ID}')?.shadowRoot?.querySelector('.label')?.textContent ?? null"
    )


def wait_gone(page, timeout_ms=9000):
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        if host_count(page) == 0:
            return True
        time.sleep(0.05)
    return host_count(page) == 0


def open_fixture(ctx):
    page = ctx.new_page()
    page.set_viewport_size({"width": 900, "height": 560})
    page.goto(FIXTURE.as_uri())
    page.add_script_tag(content=SRC)
    return page


def save_evidence(visible_png, hidden_png):
    EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
    top = Image.open(visible_png).convert("RGB")
    bottom = Image.open(hidden_png).convert("RGB")
    bar = 40
    canvas = Image.new("RGB", (top.width, top.height + bottom.height + bar * 2), (32, 34, 40))
    font_path = pathlib.Path(r"C:\Windows\Fonts\msyh.ttc")
    font = ImageFont.truetype(str(font_path), 20) if font_path.exists() else ImageFont.load_default()
    draw = ImageDraw.Draw(canvas)
    draw.text((18, 9), "控制中（0.4s）：谷谷嘎嘎正在控制你的浏览器", fill=(200, 240, 210), font=font)
    canvas.paste(top, (0, bar))
    draw.text((18, bar + top.height + 9), "停止操作 60 秒后：控制顶栏自动淡出并移除", fill=(190, 196, 206), font=font)
    canvas.paste(bottom, (0, bar + top.height + bar))
    canvas.save(EVIDENCE)
    print(f"\n证据截图：{EVIDENCE}")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 900, "height": 560})
        page = open_fixture(ctx)

        section("模块与文案")
        meta = page.evaluate("({text: __AGBB_BANNER.text, hideMs: __AGBB_BANNER.hideMs, id: __AGBB_BANNER.hostId})")
        check("提示文案完全一致", meta.get("text") == TEXT, json.dumps(meta, ensure_ascii=False))
        check("默认 60 秒后隐藏", meta.get("hideMs") == 60000, str(meta.get("hideMs")))
        check("固定宿主 id", meta.get("id") == HOST_ID, str(meta.get("id")))
        check("初始页面没有提示条", host_count(page) == 0)

        section("显示与样式")
        before = page.evaluate(
            """(() => {
              const h = document.querySelector('h1').getBoundingClientRect();
              return {scrollHeight: document.documentElement.scrollHeight,
                      h1: {x: h.x, y: h.y, w: h.width, h: h.height}};
            })()"""
        )
        res = show(page)
        check("show() 返回 ok 且首次创建", res.get("ok") is True and res.get("created") is True, json.dumps(res, ensure_ascii=False))
        check("页面里只有一个提示条", host_count(page) == 1)
        check("宿主是独立自定义元素", page.evaluate(f"document.getElementById('{HOST_ID}').tagName") == "AGBB-CONTROL-BANNER")
        check("Shadow DOM 文案完全一致", label_text(page) == TEXT, repr(label_text(page)))
        check("宿主挂在 <html> 下", page.evaluate(f"document.getElementById('{HOST_ID}').parentElement === document.documentElement"))

        style = page.evaluate(
            f"""(() => {{
              const h = document.getElementById('{HOST_ID}');
              const s = getComputedStyle(h);
              const r = h.getBoundingClientRect();
              const pill = h.shadowRoot.querySelector('.pill');
              const ps = getComputedStyle(pill);
              return {{position: s.position, zIndex: s.zIndex, pointerEvents: s.pointerEvents,
                       top: s.top, opacity: s.opacity, display: s.display,
                       rect: {{x: r.x, y: r.y, width: r.width, height: r.height}},
                       pillPointerEvents: ps.pointerEvents, pillRadius: ps.borderRadius,
                       pillFontSize: ps.fontSize, viewportWidth: innerWidth}};
            }})()"""
        )
        check("固定定位", style.get("position") == "fixed", json.dumps(style, ensure_ascii=False))
        check("z-index 为最高 32 位整数", style.get("zIndex") == "2147483647", str(style.get("zIndex")))
        check("pointer-events:none", style.get("pointerEvents") == "none")
        check("紧贴视口顶部", style.get("top") == "0px", str(style.get("top")))
        check("可见（display/opacity）", style.get("display") == "block" and style.get("opacity") == "1", json.dumps(style, ensure_ascii=False))
        check("胶囊内也不接收点击", style.get("pillPointerEvents") == "none")
        check("全宽控制顶栏样式",
              style.get("pillRadius") == "0px" and style.get("pillFontSize") == "12.5px",
              json.dumps(style, ensure_ascii=False))
        rect = style.get("rect") or {}
        check("控制顶栏横跨视口", rect.get("width", 0) >= style.get("viewportWidth", 0) - 2,
              json.dumps(rect))
        center_x = rect.get("x", 0) + rect.get("width", 0) / 2
        check("水平居中", abs(center_x - style.get("viewportWidth", 0) / 2) <= 1.5, json.dumps(rect))
        check("提示条有实际尺寸", rect.get("width", 0) > 100 and rect.get("height", 0) > 20, json.dumps(rect))

        hit = page.evaluate(
            f"""(() => {{
              const r = document.getElementById('{HOST_ID}').getBoundingClientRect();
              const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
              return el ? el.tagName : null;
            }})()"""
        )
        check("提示条不拦截页面命中测试", hit != "AGBB-CONTROL-BANNER", str(hit))

        after = page.evaluate(
            """(() => {
              const h = document.querySelector('h1').getBoundingClientRect();
              return {scrollHeight: document.documentElement.scrollHeight,
                      h1: {x: h.x, y: h.y, w: h.width, h: h.height}};
            })()"""
        )
        check("不引起布局位移（scrollHeight 不变）", before["scrollHeight"] == after["scrollHeight"],
              f'{before["scrollHeight"]} -> {after["scrollHeight"]}')
        check("不引起布局位移（标题位置不变）",
              all(abs(before["h1"][k] - after["h1"][k]) < 0.01 for k in ("x", "y", "w", "h")),
              json.dumps({"before": before["h1"], "after": after["h1"]}))

        section("去重与页面隔离")
        again = show(page)
        check("重复 show() 不新建节点", again.get("created") is False and host_count(page) == 1, json.dumps(again, ensure_ascii=False))
        check("页面 body.innerText 不包含提示文案", TEXT not in page.evaluate("document.body.innerText"))
        page.add_script_tag(content=ACTIONS)
        snap = page.evaluate("__AG_PA.snapshot({})")
        check("页面动作 snapshot 不被提示条污染", TEXT not in snap.get("snapshot", ""), snap.get("snapshot", "")[:200])

        page.add_style_tag(content="div{display:none!important}")
        check("页面 div 级 CSS 不影响提示条", page.evaluate(
            f"getComputedStyle(document.getElementById('{HOST_ID}')).display") == "block")

        section("严格 CSP 页面")
        csp_page = ctx.new_page()
        csp_page.set_content(
            '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" '
            'content="default-src \'none\'; style-src \'none\'; script-src \'none\'">'
            "</head><body><h1>CSP</h1></body></html>"
        )
        csp_page.evaluate(SRC)
        csp = show(csp_page)
        csp_style = csp_page.evaluate(
            f"""(() => {{
              const h = document.getElementById('{HOST_ID}');
              const ps = getComputedStyle(h.shadowRoot.querySelector('.pill'));
              return {{bg: ps.backgroundColor, bgImage: ps.backgroundImage, radius: ps.borderRadius,
                       fontSize: ps.fontSize, text: h.shadowRoot.querySelector('.label').textContent}};
            }})()"""
        )
        check("style-src 'none' 下仍渲染控制顶栏", csp.get("ok") is True and
              "linear-gradient" in (csp_style.get("bgImage") or "") and
              csp_style.get("radius") == "0px" and csp_style.get("fontSize") == "12.5px",
              json.dumps(csp_style, ensure_ascii=False))
        check("CSP 下文案仍然完全一致", csp_style.get("text") == TEXT, repr(csp_style.get("text")))
        csp_page.close()

        section("自动隐藏与续期")
        show(page, {"hideMs": 700})
        time.sleep(1.1)
        check("短计时自动移除", host_count(page) == 0)

        show(page)
        time.sleep(2.2)
        check("默认计时内持续可见", host_count(page) == 1)
        page.evaluate("__AGBB_BANNER.hide()")
        time.sleep(0.3)

        show(page, {"hideMs": 1200})
        time.sleep(0.65)
        show(page, {"hideMs": 1200})
        time.sleep(0.8)
        check("新命令会续期（第一次计时已过）", host_count(page) == 1)
        time.sleep(0.75)
        check("续期后仍会自动移除", host_count(page) == 0)

        show(page)
        hidden = page.evaluate("__AGBB_BANNER.hide()")
        time.sleep(0.35)
        check("hide() 立即移除（断开/重连路径）", hidden.get("ok") is True and host_count(page) == 0, json.dumps(hidden, ensure_ascii=False))

        section("多标签切换")
        page2 = open_fixture(ctx)
        show(page)
        show(page2)
        check("两个标签各自显示", host_count(page) == 1 and host_count(page2) == 1)
        page.evaluate("__AGBB_BANNER.hide()")
        show(page2)
        time.sleep(0.35)
        check("切换后旧标签移除、新标签保留", host_count(page) == 0 and host_count(page2) == 1)
        check("新标签文案仍完全一致", label_text(page2) == TEXT)

        section("验收截图")
        with tempfile.TemporaryDirectory(prefix="ag-banner-") as td:
            visible_png = pathlib.Path(td) / "visible.png"
            hidden_png = pathlib.Path(td) / "hidden.png"
            shot = open_fixture(ctx)
            show(shot)
            time.sleep(0.4)
            shot.screenshot(path=str(visible_png))
            wait_gone(shot)
            time.sleep(0.3)
            shot.screenshot(path=str(hidden_png))
            save_evidence(visible_png, hidden_png)
            check("证据文件已生成", EVIDENCE.exists() and EVIDENCE.stat().st_size > 5000,
                  str(EVIDENCE))

        browser.close()

    print(f"\n结果：{passed} 通过 / {failed} 失败")
    sys.exit(1 if failed else 0)


main()
