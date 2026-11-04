#!/usr/bin/env python3
"""Visual acceptance test for the control overlay.

Shows the real overlay at a harmless point on the primary monitor, captures
the desktop with the plugin's own screenshot backend, verifies click-through /
no-focus / exact banner text from inside the overlay process, then checks that
it stays visible while the control client is connected and disappears when the
client exits.

It never clicks, types or focuses anything: the only desktop interaction is
drawing two click-through windows and reading pixels.

    python scripts/overlay_demo.py --output C:\\path\\computer-overlay-test.png

The image is written with the banner and the cursor ring in one frame; a
second, full-screen frame is written next to it when ``--full`` is passed.
"""

import argparse
import ctypes
import json
import os
import sys
import tempfile
import time
from ctypes import wintypes

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from cu.overlay import (  # noqa: E402
    BANNER_TEXT,
    OverlayBridge,
    _pid_alive,
    endpoint_path,
    log_path,
)

PASSED = []
FAILED = []


def check(name, condition, detail=""):
    if condition:
        PASSED.append(name)
        print("  PASS  %s" % name)
    else:
        FAILED.append((name, detail))
        print("  FAIL  %s %s" % (name, detail))
    return bool(condition)


def wait_for(predicate, timeout=4.0, interval=0.04):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def read_state(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def probe(bridge, work, name):
    path = os.path.join(work, name)
    try:
        os.remove(path)
    except OSError:
        pass
    bridge.probe(path)
    if not wait_for(lambda: os.path.isfile(path), 3.0):
        return None
    return read_state(path)


def monitor_rect(x, y):
    user32 = ctypes.windll.user32

    class MONITORINFO(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("rcMonitor", wintypes.RECT),
            ("rcWork", wintypes.RECT),
            ("dwFlags", wintypes.DWORD),
        ]

    user32.MonitorFromPoint.restype = wintypes.HMONITOR
    user32.MonitorFromPoint.argtypes = [wintypes.POINT, wintypes.DWORD]
    user32.GetMonitorInfoW.argtypes = [wintypes.HMONITOR, ctypes.POINTER(MONITORINFO)]
    monitor = user32.MonitorFromPoint(wintypes.POINT(int(x), int(y)), 2)
    info = MONITORINFO()
    info.cbSize = ctypes.sizeof(MONITORINFO)
    if monitor and user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
        rect = info.rcMonitor
        return (rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top)
    return (0, 0, user32.GetSystemMetrics(0), user32.GetSystemMetrics(1))


def enable_dpi_awareness():
    user32 = ctypes.windll.user32
    try:
        if user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
            return
    except (AttributeError, OSError):
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except (AttributeError, OSError):
        pass


def is_window(hwnd):
    try:
        return bool(ctypes.windll.user32.IsWindow(int(hwnd)))
    except (TypeError, ValueError):
        return False


def window_pid(hwnd):
    try:
        pid = wintypes.DWORD()
        ctypes.windll.user32.GetWindowThreadProcessId(
            wintypes.HWND(int(hwnd)), ctypes.byref(pid)
        )
        return int(pid.value)
    except (TypeError, ValueError):
        return 0


def capture(region, output):
    from cu.backends import get_backend

    backend = get_backend("windows")
    shot = backend.screenshot(region=region, max_width=None)
    with open(output, "wb") as handle:
        handle.write(shot["png"])
    return shot


def run(args):
    if not sys.platform.startswith("win"):
        print("overlay demo skipped: the overlay host is Windows-only")
        return 0
    enable_dpi_awareness()
    user32 = ctypes.windll.user32
    foreground_before = int(user32.GetForegroundWindow())

    work = args.data_dir or tempfile.mkdtemp(prefix="cu-overlay-demo-")
    os.makedirs(work, exist_ok=True)
    mx, my, mw, mh = monitor_rect(0, 0)
    # Centred horizontally and well below the banner: both fit into one
    # readable vertical strip, and the point is not under any banner candidate.
    point = (mx + mw // 2, my + 260)
    print("data dir: %s" % work)
    print("monitor:  %s" % ((mx, my, mw, mh),))
    print("point:    %s" % (point,))

    bridge = OverlayBridge(
        data_dir=work, enabled=True, spawn=True, idle_close=0.0
    )
    try:
        bridge.show(point[0], point[1], "click")
        endpoint = endpoint_path(work)
        if not wait_for(lambda: os.path.isfile(endpoint), 6.0):
            log = log_path(work)
            print("overlay host did not start; log:")
            if os.path.isfile(log):
                print(open(log, encoding="utf-8").read())
            return 1
        time.sleep(0.8)
        state = probe(bridge, work, "state-visible.json")
        if state is None:
            print("no probe answer from the overlay host")
            return 1

        banner = state.get("banner") or {}
        cursor = state.get("cursor") or {}
        banner_rect = state.get("banner_rect") or []
        under = state.get("window_at_banner_center") or {}

        check("the banner text is exactly %r" % BANNER_TEXT,
              state.get("banner_text") == BANNER_TEXT, state.get("banner_text"))
        check("the overlay says it is visible", state.get("visible") is True, state)
        check("the banner has real opacity", (state.get("banner_alpha") or 0) > 100,
              state.get("banner_alpha"))
        check("the cursor has full opacity", (state.get("alpha") or 0) >= 240,
              state.get("alpha"))
        check("the screen frame is visibly highlighted", (state.get("screen_alpha") or 0) >= 120,
              state.get("screen_alpha"))
        check("the cursor window is centred on the action point",
              state.get("cursor", {}).get("rect", [None, None])[0] == point[0] - 88
              and state.get("cursor", {}).get("rect", [None, None])[1] == point[1] - 88,
              cursor.get("rect"))
        for role, info in (("banner", banner), ("cursor", cursor)):
            check("%s is layered" % role, info.get("layered") is True, info)
            check("%s cannot receive clicks" % role, info.get("transparent") is True, info)
            check("%s never activates" % role, info.get("noactivate") is True, info)
            check("%s stays out of alt-tab" % role, info.get("toolwindow") is True, info)
        check("the overlay did not become the foreground window",
              state.get("foreground") == foreground_before,
              (state.get("foreground"), foreground_before))
        check("the foreground belongs to another process",
              window_pid(state.get("foreground") or 0) != (state.get("pid") or 0),
              (state.get("foreground"), state.get("pid")))
        check("the banner is not on top of the action point",
              bool(banner_rect)
              and not (banner_rect[0] - 20 <= point[0] <= banner_rect[0] + banner_rect[2] + 20
                       and banner_rect[1] - 20 <= point[1] <= banner_rect[1] + banner_rect[3] + 20),
              banner_rect)
        check("the banner is inside the monitor",
              bool(banner_rect)
              and mx <= banner_rect[0]
              and banner_rect[0] + banner_rect[2] <= mx + mw
              and my <= banner_rect[1]
              and banner_rect[1] + banner_rect[3] <= my + mh,
              (banner_rect, (mx, my, mw, mh)))
        check("the click went through the banner to another window",
              under and not under.get("is_overlay"),
              under)
        check("the click goes through the cursor ring too",
              (state.get("window_at_cursor_center") or {}).get("is_overlay") is False,
              state.get("window_at_cursor_center"))

        # One readable frame with both the banner and the cursor ring.
        if not banner_rect:
            banner_rect = [point[0] - 150, 0, 300, 42]
        left = max(mx, min(banner_rect[0], point[0] - 110) - 40)
        right = min(mx + mw, max(banner_rect[0] + banner_rect[2], point[0] + 110) + 40)
        top = max(my, min(banner_rect[1], point[1] - 110) - 20)
        bottom = min(my + mh, max(banner_rect[1] + banner_rect[3], point[1] + 110) + 40)
        region = (left, top, max(1, right - left), max(1, bottom - top))
        shot = capture(region, args.output)
        print("  evidence: %s (%dx%d, region %s)"
              % (args.output, shot["width"], shot["height"], region))
        if args.full:
            full_path = os.path.splitext(args.output)[0] + "-full" + os.path.splitext(args.output)[1]
            full = capture((mx, my, mw, mh), full_path)
            print("  full screen: %s (%dx%d)" % (full_path, full["width"], full["height"]))

        # Sticky control session: the cursor, screen frame and banner remain
        # visible while this client is connected, even without further actions.
        print("  waiting to confirm the overlay stays visible ...")
        time.sleep(max(5.6, args.idle_wait))
        still = probe(bridge, work, "state-still-visible.json")
        check("the overlay stays visible after the idle wait",
              still is not None and still.get("visible") is True,
              still)
        check("the cursor and screen frame keep their opacity while idle",
              still is not None
              and (still.get("alpha") or 0) >= 240
              and (still.get("screen_alpha") or 0) >= 120
              and (still.get("banner_alpha") or 0) > 100,
              still)
        bridge.show(point[0] + 40, point[1] + 20, "element")
        time.sleep(0.6)
        again = probe(bridge, work, "state-again.json")
        check("a new action moves the persistent cursor",
              again is not None and again.get("visible") is True
              and again.get("point") == [point[0] + 40, point[1] + 20],
              again)

        pid = state.get("pid")
        banner_hwnd = banner.get("hwnd")
        cursor_hwnd = cursor.get("hwnd")
        bridge.close()
        check("the endpoint disappears when the client closes",
              wait_for(lambda: not os.path.isfile(endpoint_path(work)), 3.0),
              os.listdir(work))
        check("the overlay process exits with its client",
              wait_for(lambda: not _pid_alive(pid), 4.0), pid)
        check("the banner window is gone",
              wait_for(lambda: not is_window(banner_hwnd), 3.0), banner_hwnd)
        check("the cursor window is gone",
              wait_for(lambda: not is_window(cursor_hwnd), 3.0), cursor_hwnd)
        # A shared desktop may legitimately change focus while this runs (the
        # user or another app). What must hold is that it is never the overlay.
        end_foreground = int(user32.GetForegroundWindow())
        check("the overlay never holds the foreground",
              window_pid(end_foreground) != pid, (end_foreground, pid))
        if end_foreground != foreground_before:
            print("  note: the foreground changed to another window during the run "
                  "(%s -> %s); the overlay never took it"
                  % (foreground_before, end_foreground))
    finally:
        try:
            bridge.close()
        except Exception:
            pass

    print("\n%d passed, %d failed" % (len(PASSED), len(FAILED)))
    if FAILED:
        for name, detail in FAILED:
            print("  - %s: %s" % (name, detail))
        return 1
    print("overlay evidence: %s" % os.path.abspath(args.output))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Show and verify the computer-use overlay")
    parser.add_argument(
        "--output",
        default=os.path.join(os.getcwd(), "computer-overlay-test.png"),
        help="Path for the evidence screenshot.",
    )
    parser.add_argument("--data-dir", default="", help="Overlay state directory (default: temp).")
    parser.add_argument("--full", action="store_true", help="Also save a full-screen frame.")
    parser.add_argument(
        "--idle-wait",
        type=float,
        default=5.6,
        help="Seconds to wait for the sticky-overlay check.",
    )
    args = parser.parse_args(argv)
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
