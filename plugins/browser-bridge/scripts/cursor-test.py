#!/usr/bin/env python3
"""在真实 Chromium 里验证「谷谷嘎嘎正在控制你的浏览器」提示 + 页面受控鼠标。

不加载扩展、不碰用户登录页；把 cursor-page.js / banner-page.js / page-actions.js
注入临时浏览器页面，验证鼠标箭头、动作标签、点击波纹、常驻模式、提示条和
page-actions 的联动。证据输出到工作区。
"""

import pathlib
import sys
import time

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = pathlib.Path(__file__).resolve().parent.parent
CURSOR = (ROOT / "extension" / "cursor-page.js").read_text(encoding="utf-8")
BANNER = (ROOT / "extension" / "banner-page.js").read_text(encoding="utf-8")
PA = (ROOT / "extension" / "page-actions.js").read_text(encoding="utf-8")
FIXTURE = (ROOT / "scripts" / "fixture.html").resolve()
EVIDENCE = pathlib.Path(r"C:\Users\25350\Documents\Qoder\2026-10-30\bfec2f44\browser-cursor-test.png")

passed = 0
failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print("  ✓", name)
    else:
        failed += 1
        print("  ✗", name, ("—— " + str(detail)) if detail else "")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 1000, "height": 640})
        page = ctx.new_page()
        page.goto(FIXTURE.as_uri())
        page.add_script_tag(content=CURSOR)
        page.add_script_tag(content=BANNER)
        page.add_script_tag(content=PA)

        initial = page.evaluate("document.documentElement.scrollHeight")
        page.evaluate("__AGBB_BANNER.show(); __AGBB_CURSOR.show(640, 330, 'click')")
        time.sleep(0.3)

        state = page.evaluate(
            """(() => {
              const host = document.getElementById('agbb-control-cursor-host');
              const banner = document.getElementById('agbb-control-banner-host');
              const sh = host && host.shadowRoot;
              const pointer = sh && sh.querySelector('.pointer');
              const ring = sh && sh.querySelector('.ring');
              const label = sh && sh.querySelector('.label');
              const ripple = sh && sh.querySelector('.ripple');
              const pr = pointer && pointer.getBoundingClientRect();
              const rr = ring && ring.getBoundingClientRect();
              return {
                cursorHost: !!host,
                bannerHost: !!banner,
                pointerEvents: host ? getComputedStyle(host).pointerEvents : null,
                pointer: pr && [Math.round(pr.x), Math.round(pr.y), Math.round(pr.width), Math.round(pr.height)],
                ring: rr && [Math.round(rr.x + rr.width / 2), Math.round(rr.y + rr.height / 2)],
                label: label && label.textContent,
                labelOn: label && label.classList.contains('on'),
                ripple: !!ripple,
                cursorText: sh && sh.querySelector('.label')?.textContent,
                bannerText: banner?.shadowRoot?.querySelector('.label')?.textContent,
                scrollHeight: document.documentElement.scrollHeight,
              };
            })()"""
        )
        check("鼠标宿主存在", state["cursorHost"])
        check("顶部提示宿主存在", state["bannerHost"])
        check("提示文案精确", state["bannerText"] == "谷谷嘎嘎正在控制你的浏览器", state["bannerText"])
        check("鼠标可穿透", state["pointerEvents"] == "none", state["pointerEvents"])
        check("鼠标位于动作点附近", state["pointer"] and abs(state["pointer"][0] - 638) < 6 and abs(state["pointer"][1] - 328) < 6, state["pointer"])
        check("圆环位于动作点", state["ring"] and abs(state["ring"][0] - 640) < 2 and abs(state["ring"][1] - 330) < 2, state["ring"])
        check("点击动作标签", state["labelOn"] and state["label"] == "点击", state["label"])
        check("点击波纹出现", state["ripple"])
        check("不改变页面滚动高度", state["scrollHeight"] == initial, (initial, state["scrollHeight"]))

        # page-actions 的 locate 应驱动同一个鼠标移到元素中心
        located = page.evaluate("__AG_PA.locate({selector:'input'})")
        time.sleep(0.25)
        linked = page.evaluate(
            """(() => {
              const host = document.getElementById('agbb-control-cursor-host');
              const sh = host && host.shadowRoot;
              const ring = sh && sh.querySelector('.ring');
              if (!ring) return null;
              const r = ring.getBoundingClientRect();
              return { x: r.x + r.width / 2, y: r.y + r.height / 2, pe: getComputedStyle(host).pointerEvents };
            })()"""
        )
        check("page-actions 能找到输入框", bool(located and located.get("ok")), located)
        check(
            "page-actions 联动鼠标位置",
            linked and abs(linked["x"] - located["x"]) < 2 and abs(linked["y"] - located["y"]) < 2,
            (linked, located),
        )
        check("联动后仍可穿透", linked and linked["pe"] == "none", linked and linked["pe"])

        page.screenshot(path=str(EVIDENCE), full_page=False)
        print("证据截图：", EVIDENCE)

        pinned = page.evaluate("__AGBB_CURSOR.show(320, 240, 'type', {persistent: true})")
        page.evaluate("__AGBB_CURSOR.show(360, 260, 'move')")
        time.sleep(4.5)
        kept = page.evaluate("document.getElementById('agbb-control-cursor-host') !== null")
        pinned_state = page.evaluate("__AGBB_CURSOR.state()")
        check("常驻模式生效", pinned.get("persistent") is True, pinned)
        check("后续动作保持常驻", pinned_state.get("persistent") is True, pinned_state)
        check("4 秒后仍保持可见（控制会话）", kept)
        check("常驻鼠标仍可穿透", pinned_state.get("pointerEvents") == "none", pinned_state)
        page.evaluate("__AGBB_CURSOR.hide()")
        time.sleep(0.25)
        gone = page.evaluate("document.getElementById('agbb-control-cursor-host') === null")
        check("hide() 立即移除鼠标", gone)

        browser.close()

    print(f"\n{passed} passed, {failed} failed")
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
