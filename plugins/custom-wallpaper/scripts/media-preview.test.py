#!/usr/bin/env python3
"""Integration & Playwright E2E tests for Stage 3: Sidecar Range streaming + media-preview.js."""

import http.client
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import threading
import urllib.parse
from http.server import ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
PLUGIN_ROOT = HERE.parent
SERVER_PY = PLUGIN_ROOT / "sidecars" / "wallpaper_panel" / "server.py"
MEDIA_JS = HERE / "media-preview.js"

SAMPLE_DIR = Path(r"C:\Users\25350\.gemini\antigravity\brain\96a5548e-d443-402f-a131-48b9542fb2a1\scratch\video_test_out")
REAL_MP4 = SAMPLE_DIR / "butterfly_lavender_1080x1920_60fps.mp4"
REAL_WEBM = SAMPLE_DIR / "heart_gems_alpha_540x960.webm"

results = []


def check(name, ok, detail=""):
    results.append({"name": name, "ok": bool(ok), "detail": str(detail)[:320]})
    print(("PASS  " if ok else "FAIL  ") + name + (("  -> " + str(detail)[:240]) if detail and not ok else ""))


def load_server_module():
    spec = importlib.util.spec_from_file_location("starlight_sidecar_server", str(SERVER_PY))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def http_req(port, method, path, headers=None, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        hdrs = dict(headers or {})
        raw_body = None
        if body is not None:
            raw_body = json.dumps(body).encode("utf-8") if isinstance(body, (dict, list)) else body
            if "Content-Type" not in hdrs and isinstance(body, (dict, list)):
                hdrs["Content-Type"] = "application/json"
            hdrs["Content-Length"] = str(len(raw_body))
        conn.request(method, path, body=raw_body, headers=hdrs)
        resp = conn.getresponse()
        data = resp.read()
        return resp.status, {k.lower(): v for k, v in resp.getheaders()}, data
    finally:
        conn.close()


HTML_FIXTURE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: 1360px; height: 840px; background: #100c20; color: #eceaff; font-family: -apple-system, sans-serif; }
  .shell { display: flex; width: 100%; height: 100%; }
  .chat-pane { flex: 1; padding: 18px; display: flex; flex-direction: column; gap: 12px; }
  .inline-pill { padding: 4px 10px; border-radius: 999px; background: #1e1938; color: #e2dcfb; border: 1px solid #3f3670; cursor: pointer; }
  [data-side-panel-open="true"] { width: 720px; height: 100%; display: flex; flex-direction: column; background: #140f29; }
  [data-side-panel-focus-scope="true"] { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  [data-side-panel-strip="true"] { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid rgba(196,181,253,.2); }
  .agy-aux-tab button { padding: 4px 10px; background: transparent; color: #d8d1f6; border: 0; cursor: pointer; }
  [data-side-panel-body="true"] { flex: 1; display: flex; min-height: 0; }
  [aria-label="File Viewer"] { flex: 1; display: flex; flex-direction: column; min-width: 0; padding: 14px; position: relative; }
  [data-testid="tab-file-tree-sidebar"] { width: 200px; border-left: 1px solid rgba(196,181,253,.16); padding: 8px; }
  [role="treeitem"] { padding: 4px 6px; cursor: pointer; font-size: 12px; }
  .error-actions { margin-top: 12px; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
</style>
</head>
<body>
  <div class="shell">
    <div class="chat-pane" data-testid="conversation-view">
      <div>
        <button type="button" class="inline-pill" id="chat-webm-pill">测试 视频.webm</button>
        <button type="button" class="inline-pill" id="chat-nonvideo-pill" data-uri="file:///c:/tmp/readme.md">readme.md</button>
      </div>
      <div id="pill-leak-log">0</div>
    </div>

    <div data-side-panel-open="true">
      <div data-side-panel-focus-scope="true">
        <div data-side-panel-strip="true" data-active-tab-id="" id="strip">
          <div class="agy-aux-tab"><button type="button" data-tab-id="" id="tab-video-btn">butterfly_lavender.mp4</button></div>
          <div class="agy-aux-tab"><button type="button" data-tab-id="notes.ts" id="tab-code-btn">notes.ts</button></div>
        </div>
        <div data-side-panel-body="true">
          <div aria-label="File Viewer" id="file-viewer">
            <div aria-label="File Viewer header">
              <nav aria-label="File path breadcrumbs"><button type="button" id="crumb-name">video</button></nav>
            </div>
            <div id="viewer-content">
              <p id="viewer-status-text">Failed to read file content — File exceeds the 20MB display limit (32MB).</p>
              <div class="error-actions">
                <button type="button" id="host-reveal-btn">在资源管理器中显示</button>
              </div>
            </div>
          </div>
          <div data-testid="tab-file-tree-sidebar">
            <div role="tree">
              <div role="treeitem" id="tree-webm-item">测试 视频.webm</div>
              <div role="treeitem" id="tree-mkv-item">bad_codec.mkv</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>
"""


def main():
    srv_mod = load_server_module()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv_mod.WallpaperHandler)
    httpd.daemon_threads = True
    port = httpd.server_address[1]
    srv_mod.RUNTIME_PORT[0] = port
    token = srv_mod.SIDECAR_TOKEN
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()

    try:
        with tempfile.TemporaryDirectory(prefix="ag_media_test_") as tmp_dir:
            tmp_path = Path(tmp_dir)
            zh_dir = tmp_path / "中文 视频 目录"
            zh_dir.mkdir(parents=True, exist_ok=True)
            zh_webm = zh_dir / "测试 视频.webm"
            if REAL_WEBM.is_file():
                shutil.copy2(REAL_WEBM, zh_webm)
            else:
                raise RuntimeError(f"Missing fixture WebM at {REAL_WEBM}")
            webm_bytes = zh_webm.read_bytes()

            bad_mkv = zh_dir / "bad_codec.mkv"
            bad_mkv.write_bytes(b"NOT_A_REAL_MKV_STREAM_HEADER_BYTES_" * 8)

            txt_file = tmp_path / "notes.txt"
            txt_file.write_text("plain text", encoding="utf-8")

            # Sparse / chunk-test file >100MB (105 MiB) for memory-safe Range testing
            big_mp4 = zh_dir / "huge_105mb.mp4"
            big_size = 105 * 1024 * 1024
            with open(big_mp4, "wb") as bf:
                bf.seek(0)
                bf.write(b"HEAD_FTYP_MARKER")
                bf.seek(100 * 1024 * 1024)
                bf.write(b"TAIL_RANGE_SLICE")
                bf.truncate(big_size)

            # 1. Backend HTTP & Range tests
            s_mp_get, hdrs_mp, mp_body = http_req(port, "GET", "/media-player.html")
            s_mp_head, _, mp_head_body = http_req(port, "HEAD", "/media-player.html")
            check(
                "GET/HEAD /media-player.html serves strict same-origin CSP player bridge",
                s_mp_get == 200
                and s_mp_head == 200
                and len(mp_head_body) == 0
                and b"<video" in mp_body
                and "media-src 'self'" in hdrs_mp.get("content-security-policy", ""),
                f"get={s_mp_get} head={s_mp_head} csp={hdrs_mp.get('content-security-policy')}",
            )

            s, _, d = http_req(port, "POST", "/api/media/register", body={"path": str(zh_webm)})
            check("register without token rejected (403)", s == 403, f"status={s}")

            auth = {"X-Starlight-Token": token}
            s, _, d = http_req(port, "POST", "/api/media/register", headers=auth, body={"path": str(tmp_path / "does_not_exist.mp4")})
            check("register missing file returns 404 JSON", s == 404 and json.loads(d).get("ok") is False, f"status={s}")

            s, _, _ = http_req(port, "POST", "/api/media/register", headers=auth, body={"path": str(zh_dir)})
            check("register directory returns 400", s == 400, f"status={s}")

            s, _, _ = http_req(port, "POST", "/api/media/register", headers=auth, body={"path": str(txt_file)})
            check("register unsupported extension (.txt) returns 400", s == 400, f"status={s}")

            s, _, d = http_req(port, "POST", "/api/media/register", headers=auth, body={"path": str(zh_webm)})
            reg_webm = json.loads(d)
            check(
                "register Chinese+space WebM path succeeds with random id & video/webm",
                s == 200 and reg_webm.get("ok") and reg_webm.get("mime") == "video/webm" and reg_webm.get("size") == len(webm_bytes) and len(reg_webm.get("id", "")) >= 16,
                str(reg_webm),
            )
            wid = reg_webm["id"]

            # Test missing/invalid token & invalid handle on /media/{id}
            s, _, _ = http_req(port, "GET", f"/media/{wid}")
            check("GET /media/{id} without token rejected (403)", s == 403, f"status={s}")
            s, _, _ = http_req(port, "GET", f"/media/{wid}?token=invalid_tok")
            check("GET /media/{id} with bad token rejected (403)", s == 403, f"status={s}")
            s, _, _ = http_req(port, "GET", f"/media/{wid}?token=proxy_tok&st=" + urllib.parse.quote(token))
            check("GET /media/{id} with proxy token + valid st param allowed (200)", s == 200, f"status={s}")
            s, _, _ = http_req(port, "GET", f"/media/{wid}?token=" + urllib.parse.quote(token) + "&st=bad_st")
            check("GET /media/{id} with bad st override rejected (403)", s == 403, f"status={s}")
            s, _, _ = http_req(port, "GET", "/media/nonexistent_handle_abcdef?token=" + urllib.parse.quote(token))
            check("GET /media/invalid_handle returns 404", s == 404, f"status={s}")

            # HEAD & 200 full stream
            s, hdrs, body = http_req(port, "HEAD", f"/media/{wid}?token={urllib.parse.quote(token)}")
            check(
                "HEAD /media/{id} returns 200, Accept-Ranges: bytes, Content-Length, empty body",
                s == 200 and hdrs.get("accept-ranges") == "bytes" and int(hdrs.get("content-length", -1)) == len(webm_bytes) and len(body) == 0,
                f"s={s} hdrs={hdrs} len={len(body)}",
            )

            s, hdrs, body = http_req(port, "GET", f"/media/{wid}", headers={"X-Starlight-Token": token, "Range": "bytes=0-1023"})
            check(
                "Range bytes=0-1023 returns 206 + Content-Range + exact slice",
                s == 206 and hdrs.get("content-range") == f"bytes 0-1023/{len(webm_bytes)}" and body == webm_bytes[:1024],
                f"s={s} cr={hdrs.get('content-range')} len={len(body)}",
            )

            s, hdrs, body = http_req(port, "GET", f"/media/{wid}?token={urllib.parse.quote(token)}", headers={"Range": "bytes=-512"})
            check(
                "Suffix Range bytes=-512 returns 206 + tail bytes",
                s == 206 and hdrs.get("content-range") == f"bytes {len(webm_bytes)-512}-{len(webm_bytes)-1}/{len(webm_bytes)}" and body == webm_bytes[-512:],
                f"s={s} cr={hdrs.get('content-range')} len={len(body)}",
            )

            s, hdrs, body = http_req(port, "GET", f"/media/{wid}?token={urllib.parse.quote(token)}", headers={"Range": "bytes=4096-"})
            check(
                "Open-ended Range bytes=4096- returns 206 + exact tail",
                s == 206 and len(body) == len(webm_bytes) - 4096 and body == webm_bytes[4096:],
                f"s={s} cr={hdrs.get('content-range')} len={len(body)}",
            )

            s, hdrs, _ = http_req(port, "GET", f"/media/{wid}?token={urllib.parse.quote(token)}", headers={"Range": f"bytes={len(webm_bytes) + 100}-"})
            check(
                "Out-of-bounds Range returns 416 with Content-Range bytes */size",
                s == 416 and hdrs.get("content-range") == f"bytes */{len(webm_bytes)}",
                f"s={s} cr={hdrs.get('content-range')}",
            )

            s, _, _ = http_req(port, "GET", f"/media/{wid}?token={urllib.parse.quote(token)}", headers={"Range": "bytes=0-10,20-30"})
            check("Multi-range request rejected cleanly with 416", s == 416, f"s={s}")

            # >100MB seek Range read check (verifies chunked offset seek without reading whole file)
            s, _, big_d = http_req(port, "POST", "/api/media/register", headers=auth, body={"path": str(big_mp4)})
            big_id = json.loads(big_d)["id"]
            offset = 100 * 1024 * 1024
            s, hdrs, big_slice = http_req(port, "GET", f"/media/{big_id}", headers={"X-Starlight-Token": token, "Range": f"bytes={offset}-{offset+15}"})
            check(
                "105MB file Range seek at 100MB offset returns 206 + exact marker bytes",
                s == 206 and hdrs.get("content-range") == f"bytes {offset}-{offset+15}/{big_size}" and big_slice == b"TAIL_RANGE_SLICE",
                f"s={s} cr={hdrs.get('content-range')} data={big_slice}",
            )
            http_req(port, "POST", f"/api/media/{big_id}/close", headers=auth, body={})

            # Real 33.2MB butterfly_lavender MP4 register & Range check
            if REAL_MP4.is_file():
                s, _, mp4_d = http_req(port, "POST", "/api/media/register", headers=auth, body={"uri": REAL_MP4.as_uri()})
                mp4_reg = json.loads(mp4_d)
                mp4_id = mp4_reg.get("id", "")
                s2, _, mp4_head = http_req(port, "GET", f"/media/{mp4_id}", headers={"X-Starlight-Token": token, "Range": "bytes=0-15"})
                check(
                    "Real 33.2MB butterfly_lavender MP4 registers via file:// URI and serves 206 MP4 header",
                    s == 200 and mp4_reg.get("mime") == "video/mp4" and mp4_reg.get("size") == 33196034 and s2 == 206 and len(mp4_head) == 16 and b"ftyp" in mp4_head,
                    f"s={s} size={mp4_reg.get('size')} head={mp4_head}",
                )
                http_req(port, "POST", f"/api/media/{mp4_id}/close", headers=auth, body={})

            # Handle close invalidation check
            s, _, close_d = http_req(port, "POST", f"/api/media/{wid}/close", headers=auth, body={})
            s_after_get, _, _ = http_req(port, "GET", f"/media/{wid}?token={urllib.parse.quote(token)}")
            s_after_open, _, _ = http_req(port, "POST", f"/api/media/{wid}/open", headers=auth, body={})
            s_after_rev, _, _ = http_req(port, "POST", f"/api/media/{wid}/reveal", headers=auth, body={})
            check(
                "POST /api/media/{id}/close invalidates handle for GET/open/reveal (404)",
                s == 200 and json.loads(close_d).get("closed") is True and s_after_get == 404 and s_after_open == 404 and s_after_rev == 404,
                f"close={close_d} get={s_after_get} open={s_after_open} reveal={s_after_rev}",
            )

            # 2. Playwright UI E2E wired directly to the live ephemeral Python sidecar
            media_source = MEDIA_JS.read_text(encoding="utf-8")
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                context = browser.new_context(viewport={"width": 1360, "height": 840})
                context.grant_permissions(["local-network-access"], origin="http://127.0.0.1:51426")
                context.set_default_timeout(6000)
                page = context.new_page()
                page_errors = []
                page.on("pageerror", lambda err: page_errors.append(str(err)))

                # Serve fixture at loopback origin so real CORS + Origin validation runs end-to-end
                page.route("http://127.0.0.1:51426/**", lambda route: route.fulfill(status=200, content_type="text/html; charset=utf-8", body=HTML_FIXTURE))
                page.goto("http://127.0.0.1:51426/index.html")

                zh_webm_uri = zh_webm.as_uri()
                bad_mkv_uri = bad_mkv.as_uri()
                page.evaluate(
                    """([portNum, tok, webmUri, webmStr, mkvUri]) => {
                      window.__AG_SIDECAR_PORT = portNum;
                      window.__AG_STARLIGHT_TOKEN__ = tok;
                      window.__AG_CONFIG = { videoPreviewEnabled: true, sidecarPort: portNum, sidecarToken: tok };
                      const pill = document.getElementById('chat-webm-pill');
                      pill.setAttribute('data-uri', webmUri);
                      pill.addEventListener('click', () => {
                        const log = document.getElementById('pill-leak-log');
                        log.textContent = String(Number(log.textContent || 0) + 1);
                      });
                      document.getElementById('tree-webm-item').setAttribute('data-uri', webmUri);
                      document.getElementById('tree-mkv-item').setAttribute('data-uri', mkvUri);
                      document.getElementById('strip').setAttribute('data-active-tab-id', webmUri);
                      document.getElementById('tab-video-btn').setAttribute('data-tab-id', webmUri);
                      window.__copiedTexts = [];
                      Object.defineProperty(navigator, 'clipboard', {
                        configurable: true,
                        value: {
                          writeText: async (txt) => { window.__copiedTexts.push(txt); }
                        }
                      });
                      window.__pickMode = 'valid';
                      window.__pickValidPath = webmStr;
                      window.electronNative = {
                        getPathForFile(file) {
                          return window.__pickMode === 'valid' ? window.__pickValidPath : '';
                        }
                      };
                    }""",
                    [port, token, zh_webm_uri, str(zh_webm), bad_mkv_uri],
                )
                page.evaluate(media_source)
                page.wait_for_timeout(120)

                # Oversize "预览视频" button & picker button injected
                has_oversize_btn = page.locator('[data-ag-media-oversize-bar] button:has-text("预览视频")').is_visible()
                has_picker_btn = page.locator('[data-ag-media-picker]').is_visible()
                check("20MB error view renders '预览视频' CTA & header renders '选择本地视频'", has_oversize_btn and has_picker_btn)

                # Test non-video 20MB error page does NOT show "预览视频"
                page.evaluate(
                    """() => {
                      const st = document.getElementById('strip');
                      st.setAttribute('data-active-tab-id', 'big_export.json');
                      document.getElementById('crumb-name').textContent = 'big_export.json';
                      document.querySelector('[data-ag-media-oversize-bar]')?.remove();
                      window.__agMediaPreview.refresh();
                    }"""
                )
                page.wait_for_timeout(80)
                nonvideo_no_cta = page.locator('[data-ag-media-oversize-bar]').count() == 0
                check("non-video (.json) oversize error does not show '预览视频'", nonvideo_no_cta)

                # Restore oversize tab to video and verify clicking chat pill intercepts without firing host pill listener
                page.evaluate("([u]) => { document.getElementById('strip').setAttribute('data-active-tab-id', u); document.getElementById('crumb-name').textContent = '测试 视频.webm'; }", [zh_webm_uri])
                page.locator("#chat-webm-pill").click()
                page.wait_for_selector("#ag-media-preview-root iframe[data-mp-frame]")
                page.wait_for_function(
                    """() => {
                      const st = window.__agMediaPreview?.getPlaybackState?.();
                      return Boolean(st && st.readyState >= 1 && st.videoWidth > 0 && st.duration > 0);
                    }"""
                )

                player_state = page.evaluate(
                    """() => {
                      const root = document.getElementById('ag-media-preview-root');
                      const st = window.__agMediaPreview.getPlaybackState();
                      const tree = document.querySelector('[data-testid="tab-file-tree-sidebar"]');
                      return {
                        insideViewer: Boolean(root.closest('[aria-label="File Viewer"]')),
                        floating: root.classList.contains('is-floating-dock'),
                        treeVisible: tree.getBoundingClientRect().width >= 180,
                        leakCount: document.getElementById('pill-leak-log').textContent,
                        paused: st.paused,
                        autoplay: st.autoplay,
                        videoWidth: st.videoWidth,
                        videoHeight: st.videoHeight,
                        duration: st.duration,
                        title: root.querySelector('[data-mp-title]').textContent,
                        sub: root.querySelector('[data-mp-sub]').textContent,
                        handle: window.__agMediaPreview.getActiveHandle(),
                      };
                    }"""
                )
                mp_frame = next(f for f in page.frames if f"127.0.0.1:{port}/media-player.html" in f.url)
                inner_v = mp_frame.evaluate("() => { const v = document.getElementById('v'); return { w: v.videoWidth, h: v.videoHeight, paused: v.paused, autoplay: v.autoplay }; }")
                check(
                    "clicking Chinese+space WebM chat pill intercepts click, docks inside right viewer without autoplay, loads real dimensions",
                    player_state["insideViewer"]
                    and not player_state["floating"]
                    and player_state["treeVisible"]
                    and player_state["leakCount"] == "0"
                    and player_state["paused"] is True
                    and player_state["autoplay"] is False
                    and player_state["videoWidth"] == 540
                    and player_state["videoHeight"] == 960
                    and inner_v == {"w": 540, "h": 960, "paused": True, "autoplay": False}
                    and player_state["duration"] > 0
                    and "测试 视频.webm" in player_state["title"],
                    f"{player_state} inner={inner_v}",
                )

                # Test play/pause, rate, mute, seek scrub, copy path
                page.locator('#ag-media-preview-root [data-mp-play]').click()
                page.wait_for_timeout(120)
                page.locator('#ag-media-preview-root [data-mp-rate]').select_option("1.5")
                page.locator('#ag-media-preview-root [data-mp-mute]').click()
                page.evaluate(
                    """() => {
                      const seek = document.querySelector('#ag-media-preview-root [data-mp-seek]');
                      seek.value = '500';
                      seek.dispatchEvent(new Event('input', { bubbles: true }));
                    }"""
                )
                page.wait_for_timeout(180)
                page.locator('#ag-media-preview-root [data-mp-action="copy"]').click()
                page.wait_for_timeout(50)
                ctrl_state = page.evaluate(
                    """() => {
                      const st = window.__agMediaPreview.getPlaybackState();
                      return {
                        rate: st.playbackRate,
                        muted: st.muted,
                        cur: st.currentTime,
                        dur: st.duration,
                        copied: window.__copiedTexts,
                      };
                    }"""
                )
                inner_ctrl = mp_frame.evaluate("() => { const v = document.getElementById('v'); return { rate: v.playbackRate, muted: v.muted, cur: v.currentTime }; }")
                check(
                    "playback controls update playbackRate=1.5, mute, seek currentTime, and copy path",
                    ctrl_state["rate"] == 1.5
                    and ctrl_state["muted"] is True
                    and ctrl_state["cur"] > 0.1
                    and inner_ctrl["rate"] == 1.5
                    and inner_ctrl["muted"] is True
                    and inner_ctrl["cur"] > 0.1
                    and str(zh_webm) in (ctrl_state["copied"] or []),
                    f"{ctrl_state} inner={inner_ctrl}",
                )

                opened_id = player_state["handle"]["id"]
                page.locator('#ag-media-preview-root [data-mp-action="close"]').click()
                page.wait_for_timeout(100)
                closed_in_dom = page.locator("#ag-media-preview-root").count() == 0
                s_closed_get, _, _ = http_req(port, "GET", f"/media/{opened_id}?token={urllib.parse.quote(token)}")
                check("close button removes player overlay and invalidates sidecar media handle (404)", closed_in_dom and s_closed_get == 404, f"dom={closed_in_dom} http={s_closed_get}")

                # Test >20MB "预览视频" CTA opens preview
                page.evaluate("() => window.__agMediaPreview.refresh()")
                page.wait_for_selector('[data-ag-media-oversize-bar] button:has-text("预览视频")')
                page.locator('[data-ag-media-oversize-bar] button:has-text("预览视频")').click()
                page.wait_for_selector("#ag-media-preview-root iframe[data-mp-frame]")
                check(">20MB '预览视频' button opens player overlay", page.locator("#ag-media-preview-root").is_visible())
                page.locator('#ag-media-preview-root [data-mp-action="close"]').click()
                page.wait_for_timeout(80)

                # Test "选择本地视频" with getPathForFile success and fallback failure prompt
                page.evaluate("() => { window.__pickMode = 'valid'; }")
                with page.expect_file_chooser() as fc_info:
                    page.locator("[data-ag-media-picker]").click()
                fc_info.value.set_files(str(zh_webm))
                page.wait_for_selector("#ag-media-preview-root iframe[data-mp-frame]")
                check("'选择本地视频' resolves local path via electronNative.getPathForFile", page.locator("#ag-media-preview-root").is_visible())

                page.evaluate("() => { window.__pickMode = 'empty'; }")
                with page.expect_file_chooser() as fc_info2:
                    page.locator('#ag-media-preview-root [data-mp-action="pick"]').click()
                fc_info2.value.set_files(str(zh_webm))
                page.wait_for_timeout(100)
                err_txt = page.locator("#ag-media-preview-root [data-mp-status-text]").inner_text()
                check("unresolvable local path shows explicit retry prompt without reading file bytes", "无法可靠解析" in err_txt and "重新选择" in err_txt, err_txt)
                page.locator('#ag-media-preview-root [data-mp-action="close"]').click()
                page.wait_for_timeout(80)

                # Test unsupported codec MKV in file tree shows readable error + system player fallback
                page.locator("#tree-mkv-item").click()
                page.wait_for_selector('#ag-media-preview-root [data-mp-status][data-mp-status-state="error"]:not([hidden])')
                mkv_err = page.locator("#ag-media-preview-root [data-mp-status]").inner_text()
                check(
                    "unsupported codec/corrupt file tree item displays error & OS fallback button",
                    ("无法播放" in mkv_err or "不支持" in mkv_err or "解码" in mkv_err) and "用系统播放器打开" in mkv_err,
                    mkv_err,
                )

                # Test switching directly from error overlay to valid chat WebM without closing first
                old_mkv_id = page.evaluate("() => window.__agMediaPreview.getActiveHandle()?.id || ''")
                page.locator("#chat-webm-pill").click()
                page.wait_for_function(
                    "() => { const st = window.__agMediaPreview?.getPlaybackState?.(); return st && st.readyState >= 1 && st.videoHeight === 960; }",
                    timeout=5000,
                )
                s_old_mkv, _, _ = http_req(port, "GET", f"/media/{old_mkv_id}?token={urllib.parse.quote(token)}")
                check(
                    "switching videos while overlay open invalidates previous handle and loads new video cleanly",
                    s_old_mkv == 404 and page.locator('#ag-media-preview-root [data-mp-status]').is_hidden(),
                    f"old_http={s_old_mkv}",
                )

                # Re-open MKV for hot-disable check below
                page.locator("#tree-mkv-item").click()
                page.wait_for_selector('#ag-media-preview-root [data-mp-status][data-mp-status-state="error"]:not([hidden])')

                # Test hot disable closes overlay and invalidates handle
                mkv_id = page.evaluate("() => window.__agMediaPreview.getActiveHandle()?.id || ''")
                page.evaluate(
                    """() => {
                      document.documentElement.classList.add('ag-video-preview-disabled');
                      window.__AG_CONFIG.videoPreviewEnabled = false;
                      document.dispatchEvent(new CustomEvent('ag-config-updated', { detail: { videoPreviewEnabled: false } }));
                    }"""
                )
                page.wait_for_timeout(120)
                s_hot_get, _, _ = http_req(port, "GET", f"/media/{mkv_id}?token={urllib.parse.quote(token)}") if mkv_id else (404, {}, b"")
                check(
                    "hot disabling videoPreviewEnabled closes overlay, hides triggers & invalidates handle",
                    page.locator("#ag-media-preview-root").count() == 0 and s_hot_get == 404,
                    f"http={s_hot_get}",
                )

                # Re-enable and run __agMediaPreviewDispose()
                page.evaluate(
                    """() => {
                      document.documentElement.classList.remove('ag-video-preview-disabled');
                      window.__AG_CONFIG.videoPreviewEnabled = true;
                      document.dispatchEvent(new CustomEvent('ag-config-updated', { detail: { videoPreviewEnabled: true } }));
                    }"""
                )
                page.wait_for_timeout(80)
                page.evaluate("() => window.__agMediaPreviewDispose()")
                check(
                    "__agMediaPreviewDispose removes UI, styles, and global flags cleanly",
                    page.locator("#ag-media-preview-root").count() == 0
                    and page.locator("[data-ag-media-picker]").count() == 0
                    and page.evaluate("() => !window.__agMediaPreviewInstalled && !window.__agMediaPreview"),
                )
                check("Zero uncaught page errors during Playwright run", len(page_errors) == 0, str(page_errors))
                browser.close()
    finally:
        httpd.shutdown()
        httpd.server_close()

    passed = sum(1 for r in results if r["ok"])
    failed = [r for r in results if not r["ok"]]
    print(json.dumps({"suite": "media-preview", "total": len(results), "passed": passed, "failed": len(failed), "failures": failed}, ensure_ascii=False))
    sys.exit(0 if not failed else 1)


if __name__ == "__main__":
    main()
