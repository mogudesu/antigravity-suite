#!/usr/bin/env python3
"""在真实 Chromium 里验证 extension/page-actions.js 的 DOM 动作层。

不依赖扩展加载：把 page-actions.js 注入测试页（与扩展注入隔离世界等价），
逐个调用它的方法并断言可观察结果。
用法：python3 scripts/dom-test.py
"""
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = (ROOT / "extension" / "page-actions.js").read_text(encoding="utf-8")
FIXTURE = (ROOT / "scripts" / "fixture.html").resolve()

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


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 900, "height": 700})
        page.goto(FIXTURE.as_uri())
        page.add_script_tag(content=SRC)

        section("模块初始化")
        check("挂载到 globalThis.__AG_PA", page.evaluate("!!globalThis.__AG_PA"))
        check("重复注入不重置状态", page.evaluate(
            "(function(){var a=globalThis.__AG_PA; var b=eval(" + json.dumps(SRC) + "); return globalThis.__AG_PA===a;})()"))

        section("snapshot")
        snap = page.evaluate("__AG_PA.snapshot({})")
        text = snap["snapshot"]
        check("返回标题与 URL", snap["title"] == "Bridge 测试页" and snap["url"].startswith("file:"), json.dumps(snap)[:160])
        check("识别出标题层级", "- heading[h1] 登录示例" in text, text[:200])
        check("识别出输入框并带 ref", 'textbox "用户名"' in text and "[ref=e" in text)
        check("识别出按钮", 'button "登录"' in text)
        check("识别出下拉框并列出选项", "combobox" in text and "bj" in text)
        check("识别出复选框", "checkbox" in text)
        check("refs 计数与实际元素一致", snap["refs"] >= 6, str(snap["refs"]))
        check("未截断", snap["truncated"] is False)
        small = page.evaluate("__AG_PA.snapshot({maxChars: 120})")
        check("maxChars 生效并置 truncated", small["truncated"] is True and len(small["snapshot"]) <= 200)

        section("密码框安全")
        page.evaluate("document.getElementById('password').value = 'S3cret-Do-Not-Leak'")
        pw_snap = page.evaluate("__AG_PA.snapshot({})")
        check("快照不出现密码明文", "S3cret-Do-Not-Leak" not in pw_snap["snapshot"], pw_snap["snapshot"])
        check("密码框值被 REDACTED 且标记 sensitive", 'type=password value="[REDACTED]"' in pw_snap["snapshot"] and "sensitive=password" in pw_snap["snapshot"], pw_snap["snapshot"])
        pw_ref = ""
        for line in pw_snap["snapshot"].splitlines():
            if "sensitive=password" in line and "[ref=" in line:
                pw_ref = line.split("[ref=")[1].rstrip("]").split("]")[0]
        blocked = page.evaluate("__AG_PA.type({ref: " + json.dumps(pw_ref) + ", text: 'hacked'})")
        check("browser_type 拒绝写密码框", blocked.get("ok") is False and blocked.get("blocked") == "password-field", json.dumps(blocked, ensure_ascii=False))
        check("拒绝后密码值未改变", page.evaluate("document.getElementById('password').value") == "S3cret-Do-Not-Leak")
        focus = page.evaluate("__AG_PA.focus({ref: " + json.dumps(pw_ref) + "})")
        check("focus 报告 sensitive=password", focus.get("sensitive") == "password", json.dumps(focus, ensure_ascii=False))
        pressed = page.evaluate("__AG_PA.pressJs({key: 'a'})")
        check("pressJs 拒绝向密码框发字符", pressed.get("blocked") == "password-field", json.dumps(pressed, ensure_ascii=False))
        page.evaluate("document.activeElement.blur()")
        page.evaluate("document.getElementById('password').value = ''")

        section("compact 快照与状态签名")
        compact = page.evaluate("__AG_PA.snapshot({compact: true})")
        check("compact 返回紧凑标记", compact.get("compact") is True, json.dumps(compact.get("compact")))
        check("compact 省略静态正文", "- text: 未提交" not in compact["snapshot"], compact["snapshot"][:300])
        check("compact 保留可交互 ref", "[ref=" in compact["snapshot"])
        sig_a = page.evaluate("__AG_PA.signature()")
        page.evaluate("document.getElementById('out').textContent = 'changed'")
        page.wait_for_timeout(30)
        sig_b = page.evaluate("__AG_PA.signature()")
        check("动作前后状态签名会变化", sig_a.get("signature") != sig_b.get("signature"), json.dumps([sig_a, sig_b], ensure_ascii=False))
        page.evaluate("document.getElementById('out').textContent = '未提交'")
        page.wait_for_timeout(30)

        # ref 按 DOM 顺序确定性编号：同一 DOM 下重新 snapshot 编号不变；
        # 元素被移除后旧 ref 必须报错而不是静默点到别处。
        text = page.evaluate("__AG_PA.snapshot({})")["snapshot"]
        snap2 = page.evaluate("__AG_PA.snapshot({})")
        check("同一 DOM 下重新 snapshot 编号稳定", snap2["snapshot"] == text)
        tmp_snap = page.evaluate(
            "(function(){var d=document.createElement('button'); d.id='tmp-btn'; d.textContent='临时按钮';"
            " document.body.appendChild(d); return __AG_PA.snapshot({}).snapshot;})()"
        )
        tmp_line = [l for l in tmp_snap.splitlines() if "临时按钮" in l]
        tmp_ref = tmp_line[0].split("[ref=")[1].split("]")[0] if tmp_line else "e0"
        gone = page.evaluate(
            "(function(){document.getElementById('tmp-btn').remove();"
            " return __AG_PA.locate({ref: " + json.dumps(tmp_ref) + "});})()"
        )
        check("元素被移除后旧 ref 报错而非误点", gone.get("ok") is False and "未找到目标元素" in gone.get("error", ""), json.dumps(gone))
        snap = page.evaluate("__AG_PA.snapshot({})")
        text = snap["snapshot"]

        refs = {}
        for line in text.splitlines():
            if "[ref=" in line:
                ref = line.split("[ref=")[1].rstrip("]").split("]")[0]
                if '"用户名"' in line:
                    refs["username"] = ref
                if '"登录"' in line:
                    refs["submit"] = ref
        check("能解析出用户名 ref", "username" in refs, text)

        section("locate / 坐标")
        check("解析出按钮 ref", "submit" in refs, text)
        loc = page.evaluate("__AG_PA.locate({ref: " + json.dumps(refs.get("submit", "e0")) + "})")
        check("按 ref 定位到按钮", loc.get("ok") and loc.get("tag") == "button", json.dumps(loc))
        check("坐标在视口内", loc.get("ok") and 0 <= loc["x"] <= 900 and 0 <= loc["y"] <= 700, json.dumps(loc))
        bad = page.evaluate("__AG_PA.locate({ref: 'e999'})")
        check("无效 ref 返回错误而不是抛异常", bad.get("ok") is False and "未找到目标元素" in bad.get("error", ""), json.dumps(bad))

        section("type（受控输入兼容）")
        typed = page.evaluate("__AG_PA.type({ref: " + json.dumps(refs.get("username", "e0")) + ", text: '库库AI'})")
        check("写入成功且值正确", typed.get("ok") and typed.get("value") == "库库AI", json.dumps(typed))
        check("changed 标记为 True", typed.get("changed") is True, json.dumps(typed))
        check("绕过了实例上的吞值 setter", page.evaluate("window.__swallowed") == 0, str(page.evaluate("window.__swallowed")))
        check("派发了 input 事件", page.evaluate("window.__events.input") > 0)
        check("派发了 change 事件", page.evaluate("window.__events.change") > 0)
        appended = page.evaluate("__AG_PA.type({selector: '#username', text: '-X', clear: false})")
        check("clear:false 为追加", appended.get("value") == "库库AI-X", json.dumps(appended))
        cleared = page.evaluate("__AG_PA.type({selector: '#username', text: 'abc'})")
        check("clear 默认清空", cleared.get("value") == "abc", json.dumps(cleared))
        page.evaluate("__AG_PA.type({selector: '#username', text: '库库AI'})")

        section("select / getText")
        sel = page.evaluate("__AG_PA.select({selector: '#city', label: '上海'})")
        check("按 label 选中选项", sel.get("ok") and sel.get("value") == "sh", json.dumps(sel))
        sel2 = page.evaluate("__AG_PA.select({selector: '#city', value: 'gz'})")
        check("按 value 选中选项", sel2.get("value") == "gz", json.dumps(sel2))
        wrong = page.evaluate("__AG_PA.select({selector: '#username', value: 'x'})")
        check("非 select 元素给出明确错误", wrong.get("ok") is False and "不是 <select>" in wrong.get("error", ""), json.dumps(wrong))
        gt = page.evaluate("__AG_PA.getText({selector: '#out'})")
        check("getText 取到元素文本", gt.get("text") == "未提交", json.dumps(gt))
        whole = page.evaluate("__AG_PA.getText({maxChars: 20})")
        check("整页文本受 maxChars 限制", whole.get("truncated") is True and len(whole["text"]) <= 21,
              json.dumps({"len": len(whole.get("text", "")), "truncated": whole.get("truncated")}))

        section("click（兜底路径）")
        page.evaluate("__AG_PA.type({selector: '#username', text: '库库AI'})")
        clicked = page.evaluate("__AG_PA.clickJs({ref: " + json.dumps(refs.get("submit", "e0")) + "})")
        check("clickJs 触发提交", clicked.get("ok") is True, json.dumps(clicked))
        check("表单 onsubmit 生效", page.evaluate("document.getElementById('out').textContent") == "submitted:库库AI",
              page.evaluate("document.getElementById('out').textContent"))
        by_text = page.evaluate("__AG_PA.clickJs({text: '登录'})")
        check("按文本定位并点击", by_text.get("ok") is True and by_text.get("tag") == "button", json.dumps(by_text))

        section("waitFor")
        waited = page.evaluate("__AG_PA.waitFor({text: '延迟出现的内容', timeoutMs: 4000})")
        check("等到延迟出现的内容", waited.get("ok") is True, json.dumps(waited))
        timed_out = page.evaluate("__AG_PA.waitFor({selector: '#never', timeoutMs: 800})")
        check("超时返回 ok:false", timed_out.get("ok") is False and "等待超时" in timed_out.get("error", ""), json.dumps(timed_out))

        section("scroll 与 info")
        before = page.evaluate("scrollY")
        scrolled = page.evaluate("__AG_PA.scrollJs({deltaY: 900})")
        check("页面确实滚动", page.evaluate("scrollY") > before, json.dumps(scrolled))
        info = page.evaluate("__AG_PA.info()")
        check("info 返回页面状态", info["title"] == "Bridge 测试页" and info["readyState"] == "complete", json.dumps(info))

        section("pressJs 兜底")
        page.evaluate("document.getElementById('username').focus()")
        pressed = page.evaluate("__AG_PA.pressJs({key: 'Tab'})")
        check("Tab 兜底能移动焦点", pressed.get("ok") is True, json.dumps(pressed))
        enter = page.evaluate("__AG_PA.pressJs({key: 'Enter'})")
        check("Enter 兜底能找到表单", enter.get("ok") is True, json.dumps(enter))

        section("RPA 录制模块与 HUD 隔离")
        rec_src = (ROOT / "extension" / "recorder-page.js").read_text(encoding="utf-8")
        page.add_script_tag(content=rec_src)
        rec_started = page.evaluate("__AGBB_RECORDER.start({sessionId: 'rec-dom-1', stepCount: 2})")
        check("recorder-page 启动成功并创建 Shadow HUD", rec_started.get("ok") is True and page.evaluate("!!document.getElementById('agbb-recorder-hud-host')"))
        snap_with_hud = page.evaluate("__AG_PA.snapshot({})")
        check("录制胶囊 HUD 不会污染 snapshot 输出", "RPA录制中" not in snap_with_hud["snapshot"] and "备注规则" not in snap_with_hud["snapshot"], snap_with_hud["snapshot"])
        loc_bundle = page.evaluate("__AGBB_RECORDER.buildLocator(document.getElementById('username'))")
        check("buildLocator 提取四维定位锚点", loc_bundle.get("selector") == "#username" and loc_bundle.get("semantic", {}).get("role") == "textbox", json.dumps(loc_bundle, ensure_ascii=False))
        fb_locate = page.evaluate("__AG_PA.locate({selector: '#non-existent-id', fallbacks: ['#username']})")
        check("resolve 支持 fallbacks 备选选择器定位", fb_locate.get("ok") is True and fb_locate.get("tag") == "input", json.dumps(fb_locate, ensure_ascii=False))
        ext_res = page.evaluate("__AG_PA.extractData({selector: '#out'})")
        check("extractData 提取元素文本成功", ext_res.get("ok") is True and "submitted" in ext_res.get("text", ""), json.dumps(ext_res, ensure_ascii=False))
        rec_stopped = page.evaluate("__AGBB_RECORDER.stop()")
        check("recorder-page 停止后移除 HUD", rec_stopped.get("ok") is True and not page.evaluate("!!document.getElementById('agbb-recorder-hud-host')"))

        browser.close()

    print(f"\n结果：{passed} 通过 / {failed} 失败")
    sys.exit(1 if failed else 0)


main()
