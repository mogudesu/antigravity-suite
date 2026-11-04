#!/usr/bin/env python3
"""Visible control overlay host.

Started automatically by :class:`cu.overlay.OverlayBridge` on the first
controlling action. It owns two tiny always-on-top, click-through, never-
activating layered windows:

* a control cursor: dark halo + cyan ring + amber crosshair ticks, with a
  rotating arc, a short motion trail and a ripple on click / drag / scroll;
* a banner reading exactly ``谷谷嘎嘎正在控制你的电脑``, placed at the top of the
  monitor being controlled and moved aside when the action point is under it.

The process is deliberately separate from the MCP server: drawing can never
block a tool call, the windows are removed when the server exits, and the
overlay never sends input. Standard library only.
"""

import argparse
import ctypes
import json
import math
import os
import queue
import secrets
import socket
import sys
import threading
import time
from ctypes import wintypes

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from cu.overlay import (  # noqa: E402
    BANNER_FONT_PX,
    BANNER_TEXT,
    CURSOR_WINDOW,
    ENDPOINT_NAME,
    IDLE_HIDE_SECONDS,
    KEY_COLOR,
    KEY_COLORREF,
    LOCK_NAME,
    LOG_NAME,
    _pid_alive,
    banner_placement,
    endpoint_path,
)

# --------------------------------------------------------------------------
# Win32
# --------------------------------------------------------------------------
user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

GWL_EXSTYLE = -20
WS_EX_LAYERED = 0x00080000
WS_EX_TRANSPARENT = 0x00000020
WS_EX_NOACTIVATE = 0x08000000
WS_EX_TOOLWINDOW = 0x00000080
LWA_COLORKEY = 0x00000001
LWA_ALPHA = 0x00000002
GA_ROOT = 2
HWND_TOPMOST = wintypes.HWND(-1)
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOACTIVATE = 0x0010
SWP_SHOWWINDOW = 0x0040
SWP_NOOWNERZORDER = 0x0200
MONITOR_DEFAULTTOPRIMARY = 1
MONITOR_DEFAULTTONEAREST = 2
SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
SM_CXVIRTUALSCREEN = 78
SM_CYVIRTUALSCREEN = 79

user32.SetWindowPos.restype = wintypes.BOOL
user32.SetWindowPos.argtypes = [
    wintypes.HWND,
    wintypes.HWND,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_uint,
]
user32.GetAncestor.restype = wintypes.HWND
user32.GetAncestor.argtypes = [wintypes.HWND, ctypes.c_uint]
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.GetForegroundWindow.restype = wintypes.HWND
user32.WindowFromPoint.restype = wintypes.HWND
user32.WindowFromPoint.argtypes = [wintypes.POINT]
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.SetLayeredWindowAttributes.argtypes = [
    wintypes.HWND,
    wintypes.DWORD,
    wintypes.BYTE,
    wintypes.DWORD,
]
user32.SetWindowDisplayAffinity.restype = wintypes.BOOL
user32.SetWindowDisplayAffinity.argtypes = [wintypes.HWND, wintypes.DWORD]
WDA_NONE = 0x00000000
WDA_MONITOR = 0x00000001
WDA_EXCLUDEFROMCAPTURE = 0x00000011


def capture_guard_enabled():
    """Opt-in: hide the overlay from GDI/remote captures via WDA.

    The default is off because the user may be watching through a remote
    desktop or screen-sharing tool, which is itself a capture. Enabling the
    guard makes the cursor/banner invisible to those viewers.
    """
    raw = str(os.environ.get("CU_OVERLAY_CAPTURE_GUARD", "")).strip().lower()
    return raw in ("1", "true", "on", "yes", "enabled")
kernel32.OpenProcess.restype = wintypes.HANDLE

_GetWindowLongPtr = getattr(user32, "GetWindowLongPtrW", user32.GetWindowLongW)
_SetWindowLongPtr = getattr(user32, "SetWindowLongPtrW", user32.SetWindowLongW)
_GetWindowLongPtr.restype = ctypes.c_void_p
_GetWindowLongPtr.argtypes = [wintypes.HWND, ctypes.c_int]
_SetWindowLongPtr.restype = ctypes.c_void_p
_SetWindowLongPtr.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_void_p]

BACKDROP = "#0B0E14"
BORDER = "#19E3FF"
ACCENT = "#22E3FF"
AMBER = "#FFD400"
TEXT = "#F7FAFF"

RING_HALO = "#05070B"
RING_ACCENT = "#22E3FF"
TICK_ACCENT = "#FFD400"


class MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("rcMonitor", wintypes.RECT),
        ("rcWork", wintypes.RECT),
        ("dwFlags", wintypes.DWORD),
    ]


user32.MonitorFromPoint.restype = wintypes.HMONITOR
user32.MonitorFromPoint.argtypes = [wintypes.POINT, wintypes.DWORD]
user32.GetMonitorInfoW.restype = wintypes.BOOL
user32.GetMonitorInfoW.argtypes = [wintypes.HMONITOR, ctypes.POINTER(MONITORINFO)]


def enable_dpi_awareness():
    """Physical pixels everywhere: tool coordinates are physical pixels."""
    try:
        if user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
            return "per-monitor-v2"
    except (AttributeError, OSError):
        pass
    try:
        shcore = ctypes.WinDLL("shcore")
        if shcore.SetProcessDpiAwareness(2) == 0:
            return "per-monitor"
    except (AttributeError, OSError):
        pass
    try:
        if user32.SetProcessDPIAware():
            return "system"
    except (AttributeError, OSError):
        pass
    return "none"


def virtual_screen():
    return (
        user32.GetSystemMetrics(SM_XVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_YVIRTUALSCREEN),
        max(1, user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)),
        max(1, user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)),
    )


def monitor_rect(x, y):
    point = wintypes.POINT(int(x), int(y))
    monitor = user32.MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST)
    if monitor:
        info = MONITORINFO()
        info.cbSize = ctypes.sizeof(MONITORINFO)
        if user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
            rect = info.rcMonitor
            return (
                rect.left,
                rect.top,
                max(1, rect.right - rect.left),
                max(1, rect.bottom - rect.top),
            )
    return virtual_screen()


def primary_monitor():
    monitor = user32.MonitorFromPoint(wintypes.POINT(0, 0), MONITOR_DEFAULTTOPRIMARY)
    if monitor:
        info = MONITORINFO()
        info.cbSize = ctypes.sizeof(MONITORINFO)
        if user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
            rect = info.rcMonitor
            return (
                rect.left,
                rect.top,
                max(1, rect.right - rect.left),
                max(1, rect.bottom - rect.top),
            )
    return virtual_screen()


def window_rect(hwnd):
    rect = wintypes.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return None
    return (rect.left, rect.top, rect.right, rect.bottom)


def exstyle(hwnd):
    return int(_GetWindowLongPtr(hwnd, GWL_EXSTYLE) or 0) & 0xFFFFFFFF


def window_pid(hwnd):
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return int(pid.value)


def window_class(hwnd):
    buffer = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buffer, 256)
    return buffer.value


def window_title(hwnd):
    buffer = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(hwnd, buffer, 512)
    return buffer.value


def blend(color_a, color_b, ratio):
    ratio = max(0.0, min(1.0, ratio))

    def parts(color):
        color = color.lstrip("#")
        return int(color[0:2], 16), int(color[2:4], 16), int(color[4:6], 16)

    ar, ag, ab = parts(color_a)
    br, bg, bb = parts(color_b)
    return "#%02X%02X%02X" % (
        int(ar + (br - ar) * ratio),
        int(ag + (bg - ag) * ratio),
        int(ab + (bb - ab) * ratio),
    )


def log_message(data_dir, message):
    try:
        os.makedirs(data_dir, exist_ok=True)
        path = os.path.join(data_dir, LOG_NAME)
        try:
            if os.path.getsize(path) > 256 * 1024:
                os.replace(path, path + ".1")
        except OSError:
            pass
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(
                "%s overlay_host[%d]: %s\n"
                % (time.strftime("%Y-%m-%d %H:%M:%S"), os.getpid(), message)
            )
    except OSError:
        pass


def acquire_instance_lock(data_dir):
    """One overlay host per data directory; a second one exits quietly."""
    os.makedirs(data_dir, exist_ok=True)
    path = os.path.join(data_dir, LOCK_NAME)
    handle = open(path, "a+b")
    try:
        handle.seek(0)
        handle.write(b"L")
        handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, ImportError):
        handle.close()
        return None
    return handle


def write_json_atomic(path, payload):
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    temporary = path + ".tmp-%d" % os.getpid()
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(temporary, path)


def remove_endpoint(data_dir):
    path = endpoint_path(data_dir)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        if int(data.get("pid") or 0) != os.getpid():
            return
    except (OSError, ValueError, TypeError):
        pass
    try:
        os.remove(path)
    except OSError:
        pass


# --------------------------------------------------------------------------
# Layered window
# --------------------------------------------------------------------------
class Layer:
    """One always-on-top, click-through, never-activating Toplevel."""

    def __init__(self, root, title, width, height):
        import tkinter as tk

        self.root = root
        self.width = int(width)
        self.height = int(height)
        self.top = tk.Toplevel(root)
        self.top.title(title)
        self.top.overrideredirect(True)
        self.top.attributes("-topmost", True)
        # Start invisible before the window is first mapped, so the very first
        # frame cannot flash at position 0,0.
        self.top.attributes("-alpha", 0.0)
        self.canvas = tk.Canvas(
            self.top,
            width=self.width,
            height=self.height,
            bg=KEY_COLOR,
            highlightthickness=0,
            bd=0,
        )
        self.canvas.pack()
        self.top.update_idletasks()
        self.child = self.top.winfo_id()
        self.hwnd = int(user32.GetAncestor(self.child, GA_ROOT) or self.child)
        self._alpha = -1
        self._position = None
        self._capture_affinity = WDA_NONE
        self._style()

    def _style(self):
        for handle in {self.hwnd, self.child}:
            if not handle:
                continue
            old = int(_GetWindowLongPtr(handle, GWL_EXSTYLE) or 0)
            _SetWindowLongPtr(
                handle,
                GWL_EXSTYLE,
                ctypes.c_void_p(
                    old
                    | WS_EX_LAYERED
                    | WS_EX_TRANSPARENT
                    | WS_EX_NOACTIVATE
                    | WS_EX_TOOLWINDOW
                ),
            )
        # Remote desktops and screen-sharing tools are captures too. Excluding
        # the overlay from captures made it invisible to remote users, so the
        # guard is opt-in only.
        if capture_guard_enabled():
            self._exclude_from_capture()
        else:
            self._capture_affinity = WDA_NONE
        self.set_alpha(0, force=True)

    def _exclude_from_capture(self):
        """Keep the overlay visible to the user but out of screen captures.

        WDA_EXCLUDEFROMCAPTURE is the Windows 10 2004+ switch honoured by GDI
        BitBlt, PrintWindow and the snippet tools; WDA_MONITOR is the older
        black-out fallback. The model therefore receives a clean desktop while
        the person still sees the control cursor and banner.
        """
        for affinity in (WDA_EXCLUDEFROMCAPTURE, WDA_MONITOR):
            try:
                if user32.SetWindowDisplayAffinity(self.hwnd, affinity):
                    self._capture_affinity = affinity
                    return affinity
            except OSError:
                continue
        self._capture_affinity = WDA_NONE
        return WDA_NONE

    def set_alpha(self, alpha, force=False):
        alpha = max(0, min(255, int(alpha)))
        if alpha == self._alpha and not force:
            return
        self._alpha = alpha
        for handle in {self.hwnd, self.child}:
            if not handle:
                continue
            if not user32.SetLayeredWindowAttributes(
                handle, KEY_COLORREF, alpha, LWA_COLORKEY | LWA_ALPHA
            ):
                # A child window cannot be layered before Windows 8; the
                # parent still provides the transparency.
                _SetWindowLongPtr(
                    handle,
                    GWL_EXSTYLE,
                    ctypes.c_void_p(exstyle(handle) & ~WS_EX_LAYERED),
                )

    def place(self, x, y):
        x = int(x)
        y = int(y)
        if self._position == (x, y):
            return
        self._position = (x, y)
        user32.SetWindowPos(
            self.hwnd,
            HWND_TOPMOST,
            x,
            y,
            self.width,
            self.height,
            SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        )

    def raise_topmost(self):
        user32.SetWindowPos(
            self.hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        )

    def info(self):
        return {
            "title": window_title(self.hwnd),
            "hwnd": self.hwnd,
            "child_hwnd": self.child,
            "pid": window_pid(self.hwnd),
            "class": window_class(self.hwnd),
            "rect": list(window_rect(self.hwnd) or ()),
            "exstyle": "0x%08X" % exstyle(self.hwnd),
            "child_exstyle": "0x%08X" % exstyle(self.child),
            "alpha": self._alpha,
            "capture_affinity": "0x%02X" % self._capture_affinity,
            "excluded_from_capture": self._capture_affinity != WDA_NONE,
            "layered": bool(exstyle(self.hwnd) & WS_EX_LAYERED),
            "transparent": bool(exstyle(self.hwnd) & WS_EX_TRANSPARENT),
            "noactivate": bool(exstyle(self.hwnd) & WS_EX_NOACTIVATE),
            "toolwindow": bool(exstyle(self.hwnd) & WS_EX_TOOLWINDOW),
        }


# --------------------------------------------------------------------------
# The overlay itself
# --------------------------------------------------------------------------
class OverlayApp:
    def __init__(self, args):
        import tkinter as tk
        import tkinter.font as tkfont

        self.args = args
        self.data_dir = args.data_dir
        self.parent_pid = int(args.parent_pid or 0)
        self.idle_hide = max(0.5, args.idle_hide_ms / 1000.0)
        # A connected client keeps the host alive for the sticky session; a
        # host that never gets a client still cleans itself up promptly.
        self.idle_exit = max(1.0, args.idle_exit_ms / 1000.0)
        self.events = queue.Queue(maxsize=256)
        self.clients = 0
        self.client_lock = threading.Lock()
        self.had_client = False
        self.last_client_change = time.monotonic()
        self.parent_alive = True
        self.last_event = 0.0
        self.last_activity = time.monotonic()
        self.point = None
        self.kind = "move"
        self.from_point = None
        self.trail = []
        self.ripples = []
        self.phase = 0.0
        self.level = 0.0
        self.level_target = 0.0
        self.visible = False
        self.closing = False
        self.server = None
        self.foreground_before_tk = int(user32.GetForegroundWindow())
        self.monitor = primary_monitor()
        self.banner_placement_name = ""
        self.banner_rect = None
        self.last_topmost = 0.0
        self._last_tick = time.monotonic()
        self._frame = 0

        self.root = tk.Tk()
        self.root.withdraw()
        self.font = tkfont.Font(
            root=self.root,
            family=self._font_family(tkfont, self.root),
            size=-BANNER_FONT_PX,
        )
        self.text_width = self.font.measure(BANNER_TEXT)
        self.banner_width = max(190, self.text_width + 58)
        self.banner_height = 42

        vx, vy, vw, vh = virtual_screen()
        self.screen = Layer(self.root, "CuOverlayScreen", vw, vh)
        self.screen.place(vx, vy)
        self._draw_screen()
        self.cursor = Layer(self.root, "CuOverlayCursor", CURSOR_WINDOW, CURSOR_WINDOW)
        self.banner = Layer(
            self.root, "CuOverlayBanner", self.banner_width, self.banner_height
        )
        self._draw_cursor()
        self._draw_banner()
        self.foreground_after_tk = int(user32.GetForegroundWindow())
        self.foreground_at_start = self.foreground_after_tk
        # Creating the Tk layers can briefly activate one of them before the
        # NOACTIVATE styles settle. Hand focus straight back to the app the
        # user was in; the overlay must never steal input.
        if (
            self.foreground_before_tk
            and self.foreground_after_tk != self.foreground_before_tk
        ):
            try:
                user32.SetForegroundWindow(wintypes.HWND(self.foreground_before_tk))
                self.foreground_after_tk = int(user32.GetForegroundWindow())
            except Exception:
                pass
        self.root.after(20, self._poll)

    @staticmethod
    def _font_family(tkfont, root):
        available = set(tkfont.families(root))
        for name in (
            "Microsoft YaHei UI",
            "Microsoft YaHei",
            "SimHei",
            "Segoe UI",
            "Tahoma",
        ):
            if name in available:
                return name
        return "TkDefaultFont"

    # -- drawing -----------------------------------------------------------
    def _draw_banner(self):
        canvas = self.banner.canvas
        width = self.banner_width
        height = self.banner_height
        rounded = self._rounded_points(2, 2, width - 2, height - 2, 12)
        canvas.create_polygon(
            rounded,
            smooth=True,
            splinesteps=24,
            fill=BACKDROP,
            outline="",
        )
        canvas.create_polygon(
            rounded,
            smooth=True,
            splinesteps=24,
            fill="",
            outline=BORDER,
            width=2,
        )
        center_y = height // 2
        self.banner_dot = canvas.create_oval(
            19, center_y - 4, 27, center_y + 4, fill=AMBER, outline=""
        )
        canvas.create_text(
            38,
            center_y,
            anchor="w",
            text=BANNER_TEXT,
            fill=TEXT,
            font=self.font,
        )
        # A one-pixel inner hairline gives the pill a crisp edge over both
        # light and dark windows.
        canvas.create_polygon(
            self._rounded_points(4, 4, width - 4, height - 4, 10),
            smooth=True,
            splinesteps=24,
            fill="",
            outline="#203040",
            width=1,
        )

    @staticmethod
    def _rounded_points(x1, y1, x2, y2, radius):
        radius = max(1, min(radius, (x2 - x1) // 2, (y2 - y1) // 2))
        points = []
        steps = 6
        for cx, cy, start in (
            (x2 - radius, y1 + radius, -90),
            (x2 - radius, y2 - radius, 0),
            (x1 + radius, y2 - radius, 90),
            (x1 + radius, y1 + radius, 180),
        ):
            for step in range(steps + 1):
                angle = math.radians(start + 90.0 * step / steps)
                points.extend((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
        return points

    def _draw_screen(self):
        canvas = self.screen.canvas
        width = self.screen.width
        height = self.screen.height
        # A Codex-style screen highlight: a translucent framed halo hugging
        # the controlled desktop, never covering the center of the screen.
        canvas.create_rectangle(7, 7, width - 8, height - 8, outline="#0A2D36", width=14)
        canvas.create_rectangle(4, 4, width - 5, height - 5, outline="#0F7284", width=6)
        canvas.create_rectangle(2, 2, width - 3, height - 3, outline=RING_ACCENT, width=2)
        canvas.create_rectangle(14, 14, width - 15, height - 15, outline="#6B5A1E", width=1)
        length = 120
        inset = 16
        brackets = (
            (inset, inset, inset + length, inset),
            (inset, inset, inset, inset + length),
            (width - inset, inset, width - inset - length, inset),
            (width - inset, inset, width - inset, inset + length),
            (inset, height - inset, inset + length, height - inset),
            (inset, height - inset, inset, height - inset - length),
            (width - inset, height - inset, width - inset - length, height - inset),
            (width - inset, height - inset, width - inset, height - inset - length),
        )
        for x1, y1, x2, y2 in brackets:
            canvas.create_line(x1, y1, x2, y2, fill=RING_ACCENT, width=4, capstyle="round")

    def _draw_cursor(self):
        canvas = self.cursor.canvas
        center = CURSOR_WINDOW // 2
        self.cx = center
        self.cy = center
        # Plain high-contrast mouse arrow only. The banner and screen frame
        # already communicate control; no ring, crosshair, trail or ripples.
        arrow = [
            center, center,
            center + 18, center + 11,
            center + 10, center + 13,
            center + 15, center + 26,
            center + 9, center + 28,
            center + 4, center + 16,
            center - 3, center + 21,
        ]
        shadow = [(arrow[i] + 2, arrow[i + 1] + 2) for i in range(0, len(arrow), 2)]
        canvas.create_polygon(shadow, fill="#071018", outline="#071018", width=1)
        self.cursor_arrow = canvas.create_polygon(
            arrow, fill="#F7FAFF", outline="#071018", width=2, joinstyle="round"
        )
        self.trail_items = []
        self.ripple_items = []

    def _pulse_cursor(self):
        return

    def _redraw_trail(self, now):
        return

    def _redraw_ripples(self, now):
        return

    # -- events ------------------------------------------------------------
    def post(self, event):
        try:
            self.events.put_nowait(event)
        except queue.Full:
            try:
                self.events.get_nowait()
            except queue.Empty:
                pass
            try:
                self.events.put_nowait(event)
            except queue.Full:
                pass

    def client_change(self, delta):
        with self.client_lock:
            self.clients = max(0, self.clients + delta)
            if delta > 0:
                self.had_client = True
            self.last_client_change = time.monotonic()
            count = self.clients
        self.last_activity = time.monotonic()
        self.post({"op": "clients", "count": count})

    def _poll(self):
        if self.closing:
            return
        try:
            self._poll_once()
        except Exception as exc:  # noqa: BLE001 - a drawing glitch must not wedge it
            log_message(self.data_dir, "overlay tick failed: %r" % (exc,))
            if not self.closing:
                self.root.after(500, self._poll)

    def _poll_once(self):
        now = time.monotonic()
        while True:
            try:
                event = self.events.get_nowait()
            except queue.Empty:
                break
            self._handle(event, now)
        if self.closing:
            return

        if self.visible or self.level > 0 or self.level_target > 0:
            dt = min(0.12, max(0.0, now - self._last_tick))
            self._last_tick = now
            self.phase = (self.phase + dt) % 1000.0
            if self.level < self.level_target:
                self.level = min(self.level_target, self.level + dt * 7.0)
            elif self.level > self.level_target:
                self.level = max(self.level_target, self.level - dt * 4.5)
            self._apply_level()
            # The ring is a small layered window; redrawing its animation at
            # 25 fps costs several percent of a core for no benefit. Events
            # still land every tick; the decorative pulse and trail run at
            # half rate unless a ripple or a fade is in progress.
            self._frame += 1
            animate = (
                self._frame % 2 == 0
                or bool(self.ripples)
                or self.level != self.level_target
            )
            if animate and self.point is not None:
                self._pulse_cursor()
                self._redraw_trail(now)
                self._redraw_ripples(now)
                self._bob_banner()
            if now - self.last_topmost > 1.0:
                self.last_topmost = now
                self.screen.raise_topmost()
                self.cursor.raise_topmost()
                self.banner.raise_topmost()
            if self.level <= 0.0 and self.level_target <= 0.0:
                self.visible = False
            else:
                self.visible = True
            self._check_idle(now)
            delay = 40
        else:
            self._check_idle(now)
            delay = 120 if self.clients else 200
        if not self.closing:
            self.root.after(delay, self._poll)

    def _check_idle(self, now):
        if self.visible and now - self.last_event >= self.idle_hide:
            self.level_target = 0.0
        with self.client_lock:
            clients = self.clients
        if (
            self.had_client
            and clients == 0
            and now - self.last_client_change > 0.9
        ):
            self.shutdown("client disconnected")
            return
        if not self.parent_alive and clients == 0 and now - self.last_client_change > 0.9:
            self.shutdown("parent exited")
            return
        if now - self.last_activity >= self.idle_exit and clients == 0:
            self.shutdown("idle")

    def _handle(self, event, now):
        op = event.get("op")
        if op == "show":
            try:
                x = int(event.get("x"))
                y = int(event.get("y"))
            except (TypeError, ValueError):
                return
            jump = (
                self.point is None
                or math.hypot(x - self.point[0], y - self.point[1]) > 140
                or now - self.last_event > 1.2
            )
            self.point = (x, y)
            self.kind = str(event.get("kind") or "move")
            self.from_point = None
            if event.get("fx") is not None and event.get("fy") is not None:
                try:
                    self.from_point = (int(event["fx"]), int(event["fy"]))
                except (TypeError, ValueError):
                    self.from_point = None
            self.last_event = now
            self.last_activity = now
            self.level_target = 1.0
            if self.level <= 0.01:
                self._apply_alpha(0)
            self._position(now)
            self._apply_level()
        elif op == "hide":
            self.level_target = 0.0
        elif op == "clients":
            self.last_activity = now
        elif op == "probe":
            path = event.get("path")
            if path:
                try:
                    write_json_atomic(path, self._probe(now))
                except OSError as exc:
                    log_message(self.data_dir, "probe failed: %s" % exc)
        elif op == "parent_gone":
            self.parent_alive = False
        elif op == "quit":
            self.shutdown("quit")
        elif op == "shutdown":
            self.shutdown(str(event.get("reason") or "shutdown"))

    def _position(self, now):
        x, y = self.point
        self.monitor = monitor_rect(x, y)
        bx, by, placement = banner_placement(
            self.monitor, (self.banner_width, self.banner_height), (x, y)
        )
        self.banner_placement_name = placement
        self.banner_rect = (bx, by, self.banner_width, self.banner_height)
        self.banner.place(bx, by)
        self.cursor.place(
            x - CURSOR_WINDOW // 2,
            y - CURSOR_WINDOW // 2,
        )

    def _bob_banner(self):
        # A barely perceptible breathing dot shows the overlay is alive without
        # redrawing the text or competing with the content underneath.
        canvas = self.banner.canvas
        center_y = self.banner_height // 2
        radius = 4.0 + 0.8 * math.sin(self.phase * 2.4)
        canvas.coords(
            self.banner_dot,
            23 - radius,
            center_y - radius,
            23 + radius,
            center_y + radius,
        )

    def _apply_level(self):
        if self.level <= 0.0:
            self._apply_alpha(0)
        else:
            self._apply_alpha(int(round(255 * self.level)), banner_ratio=0.92)

    def _apply_alpha(self, alpha, banner_ratio=1.0):
        self.cursor.set_alpha(alpha)
        self.banner.set_alpha(max(0, min(255, int(alpha * banner_ratio))))
        # Keep the Codex-style screen frame clearly visible for the whole
        # control session without tinting the center of the desktop.
        self.screen.set_alpha(max(0, min(255, int(alpha * 0.72))))

    def _probe(self, now):
        banner_center = None
        if self.banner_rect:
            bx, by, bw, bh = self.banner_rect
            banner_center = (bx + bw // 2, by + bh // 2)
        under = None
        under_cursor = None
        if banner_center:
            hwnd = user32.WindowFromPoint(wintypes.POINT(*banner_center))
            root = int(user32.GetAncestor(hwnd, GA_ROOT) or hwnd) if hwnd else 0
            if root:
                under = {
                    "hwnd": root,
                    "pid": window_pid(root),
                    "class": window_class(root),
                    "title": window_title(root),
                    "is_overlay": window_pid(root) == os.getpid(),
                }
        if self.point:
            hwnd = user32.WindowFromPoint(wintypes.POINT(*self.point))
            root = int(user32.GetAncestor(hwnd, GA_ROOT) or hwnd) if hwnd else 0
            if root:
                under_cursor = {
                    "hwnd": root,
                    "pid": window_pid(root),
                    "class": window_class(root),
                    "title": window_title(root),
                    "is_overlay": window_pid(root) == os.getpid(),
                }
        return {
            "pid": os.getpid(),
            "renderer": "tk",
            "version": 1,
            "banner_text": BANNER_TEXT,
            "banner_text_units": len(BANNER_TEXT),
            "visible": bool(self.visible),
            "level": round(self.level, 3),
            "alpha": self.cursor._alpha,
            "banner_alpha": self.banner._alpha,
            "screen_alpha": self.screen._alpha,
            "point": list(self.point) if self.point else None,
            "kind": self.kind,
            "from_point": list(self.from_point) if self.from_point else None,
            "banner": self.banner.info(),
            "cursor": self.cursor.info(),
            "banner_placement": self.banner_placement_name,
            "banner_rect": list(self.banner_rect) if self.banner_rect else None,
            "monitor": list(self.monitor),
            "foreground": int(user32.GetForegroundWindow()),
            "foreground_before_tk": self.foreground_before_tk,
            "foreground_at_start": self.foreground_at_start,
            "window_at_banner_center": under,
            "window_at_cursor_center": under_cursor,
            "clients": self.clients,
            "idle_hide_ms": int(self.idle_hide * 1000),
            "ts": time.time(),
        }

    def shutdown(self, reason):
        if self.closing:
            return
        self.closing = True
        log_message(self.data_dir, "stopping: %s" % reason)
        if self.server is not None:
            self.server.stop()
        remove_endpoint(self.data_dir)
        try:
            self.root.destroy()
        except Exception:  # noqa: BLE001 - shutting down anyway
            pass


# --------------------------------------------------------------------------
# IPC server
# --------------------------------------------------------------------------
class OverlayServer:
    def __init__(self, app, data_dir):
        self.app = app
        self.data_dir = data_dir
        self.token = secrets.token_hex(16)
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.socket.bind(("127.0.0.1", 0))
        self.socket.listen(8)
        self.port = self.socket.getsockname()[1]
        self.stop_event = threading.Event()
        self.thread = threading.Thread(
            target=self._accept_loop, name="cu-overlay-ipc", daemon=True
        )

    def start(self):
        write_json_atomic(
            endpoint_path(self.data_dir),
            {
                "pid": os.getpid(),
                "port": self.port,
                "token": self.token,
                "started": time.time(),
                "banner": BANNER_TEXT,
                "renderer": "tk",
            },
        )
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        try:
            self.socket.close()
        except OSError:
            pass
        remove_endpoint(self.data_dir)

    def _accept_loop(self):
        self.socket.settimeout(0.3)
        while not self.stop_event.is_set():
            try:
                connection, _ = self.socket.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(
                target=self._client,
                args=(connection,),
                name="cu-overlay-client",
                daemon=True,
            ).start()

    def _client(self, connection):
        authed = False
        buffer = b""
        connection.settimeout(0.6)
        try:
            while not self.stop_event.is_set():
                try:
                    chunk = connection.recv(8192)
                except socket.timeout:
                    continue
                except OSError:
                    break
                if not chunk:
                    break
                buffer += chunk
                while b"\n" in buffer:
                    raw, buffer = buffer.split(b"\n", 1)
                    raw = raw.strip()
                    if not raw:
                        continue
                    try:
                        event = json.loads(raw.decode("utf-8", "replace"))
                    except ValueError:
                        continue
                    if not isinstance(event, dict):
                        continue
                    if not authed:
                        if (
                            event.get("op") == "hello"
                            and str(event.get("token") or "") == self.token
                        ):
                            authed = True
                            self.app.client_change(+1)
                        else:
                            return
                        continue
                    if event.get("op") == "quit":
                        self.app.post({"op": "hide"})
                        return
                    self.app.post(event)
        finally:
            try:
                connection.close()
            except OSError:
                pass
            if authed:
                self.app.client_change(-1)


def watch_parent(app, parent_pid):
    while not app.closing:
        time.sleep(1.0)
        if parent_pid and not _pid_alive(parent_pid):
            app.post({"op": "parent_gone"})
            return


def main(argv=None):
    parser = argparse.ArgumentParser(description="computer-use visible overlay host")
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--parent-pid", type=int, default=0)
    parser.add_argument("--idle-hide-ms", type=int, default=int(IDLE_HIDE_SECONDS * 1000))
    parser.add_argument("--idle-exit-ms", type=int, default=30000)
    parser.add_argument(
        "--renderer",
        default="tk",
        choices=("tk",),
        help="Window renderer; tkinter is the stdlib implementation.",
    )
    args = parser.parse_args(argv)

    if not sys.platform.startswith("win"):
        log_message(args.data_dir, "overlay host requires Windows")
        return 0
    os.makedirs(args.data_dir, exist_ok=True)
    lock = acquire_instance_lock(args.data_dir)
    if lock is None:
        return 0
    log_message(args.data_dir, "starting overlay host (parent=%s)" % args.parent_pid)
    enable_dpi_awareness()
    app = None
    try:
        app = OverlayApp(args)
        server = OverlayServer(app, args.data_dir)
        app.server = server
        server.start()
        threading.Thread(
            target=watch_parent,
            args=(app, args.parent_pid),
            name="cu-overlay-parent",
            daemon=True,
        ).start()
        app.root.mainloop()
        return 0
    except Exception as exc:  # noqa: BLE001 - never leave a half overlay behind
        log_message(args.data_dir, "overlay host failed: %s: %s" % (type(exc).__name__, exc))
        return 1
    finally:
        if app is not None:
            try:
                remove_endpoint(args.data_dir)
            except Exception:
                pass
        try:
            lock.close()
        except OSError:
            pass
        log_message(args.data_dir, "overlay host exited")


if __name__ == "__main__":
    sys.exit(main())
