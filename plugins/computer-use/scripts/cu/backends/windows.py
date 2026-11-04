"""Windows backend.

Screen capture and input synthesis go straight to Win32 through ``ctypes``, so
the plugin needs no compiled dependency. The accessibility tree is read
through UI Automation via a small PowerShell bridge that ships with the
plugin (``scripts/win_uia.ps1``), which is what makes element-level control
possible without third-party packages.
"""

import ctypes
import json
import os
import re
import subprocess
import time
from ctypes import wintypes

from ..imaging import encode_png
from ..policy import normalize_combo
from .base import Backend, BackendError, UnsupportedAction

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

ULONG_PTR = wintypes.WPARAM

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_VIRTUALDESK = 0x4000

KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
SM_CXVIRTUALSCREEN = 78
SM_CYVIRTUALSCREEN = 79

SW_RESTORE = 9
SRCCOPY = 0x00CC0020
CAPTUREBLT = 0x40000000
CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
WHEEL_DELTA = 120
VK_MENU = 0x12

BUTTON_FLAGS = {
    "left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
}

NAMED_KEYS = {
    "backspace": 0x08, "tab": 0x09, "enter": 0x0D, "shift": 0x10, "ctrl": 0x11,
    "alt": 0x12, "pause": 0x13, "capslock": 0x14, "esc": 0x1B, "space": 0x20,
    "pageup": 0x21, "pagedown": 0x22, "end": 0x23, "home": 0x24, "left": 0x25,
    "up": 0x26, "right": 0x27, "down": 0x28, "printscreen": 0x2C, "insert": 0x2D,
    "delete": 0x2E, "win": 0x5B, "apps": 0x5D, "numlock": 0x90, "scrolllock": 0x91,
    "add": 0x6B, "subtract": 0x6D, "multiply": 0x6A, "divide": 0x6F, "decimal": 0x6E,
}
for _index in range(1, 25):
    NAMED_KEYS["f%d" % _index] = 0x6F + _index
for _char in "abcdefghijklmnopqrstuvwxyz":
    NAMED_KEYS[_char] = ord(_char.upper())
for _digit in "0123456789":
    NAMED_KEYS[_digit] = ord(_digit)

EXTENDED_KEYS = {
    "insert", "delete", "home", "end", "pageup", "pagedown", "left", "up", "right",
    "down", "win", "apps", "printscreen", "divide", "numlock",
}


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

user32.EnumWindows.argtypes = (WNDENUMPROC, wintypes.LPARAM)
user32.EnumWindows.restype = wintypes.BOOL
user32.SendInput.argtypes = (wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int)
user32.SendInput.restype = wintypes.UINT
user32.GetDC.restype = wintypes.HDC
user32.GetDC.argtypes = (wintypes.HWND,)
user32.ReleaseDC.argtypes = (wintypes.HWND, wintypes.HDC)
user32.GetSystemMetrics.argtypes = (ctypes.c_int,)
user32.GetSystemMetrics.restype = ctypes.c_int
user32.OpenClipboard.argtypes = (wintypes.HWND,)
user32.GetClipboardData.restype = wintypes.HANDLE
user32.GetClipboardData.argtypes = (wintypes.UINT,)
user32.SetClipboardData.argtypes = (wintypes.UINT, wintypes.HANDLE)
user32.SetClipboardData.restype = wintypes.HANDLE
kernel32.GlobalAlloc.argtypes = (wintypes.UINT, ctypes.c_size_t)
kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
kernel32.GlobalLock.argtypes = (wintypes.HGLOBAL,)
kernel32.GlobalLock.restype = ctypes.c_void_p
kernel32.GlobalUnlock.argtypes = (wintypes.HGLOBAL,)
kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
kernel32.OpenProcess.restype = wintypes.HANDLE

user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetWindowTextLengthW.argtypes = (wintypes.HWND,)
user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = (wintypes.HWND, ctypes.c_wchar_p, ctypes.c_int)
user32.GetWindowTextW.restype = ctypes.c_int
user32.IsWindowVisible.argtypes = (wintypes.HWND,)
user32.IsIconic.argtypes = (wintypes.HWND,)
user32.ShowWindow.argtypes = (wintypes.HWND, ctypes.c_int)
user32.SetForegroundWindow.argtypes = (wintypes.HWND,)
user32.SetForegroundWindow.restype = wintypes.BOOL
user32.BringWindowToTop.argtypes = (wintypes.HWND,)
user32.GetWindowRect.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.RECT))
user32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.GetCursorPos.argtypes = (ctypes.POINTER(wintypes.POINT),)
user32.WindowFromPoint.argtypes = (wintypes.POINT,)
user32.WindowFromPoint.restype = wintypes.HWND
user32.GetAncestor.argtypes = (wintypes.HWND, wintypes.UINT)
user32.GetAncestor.restype = wintypes.HWND
user32.OpenClipboard.restype = wintypes.BOOL
user32.EmptyClipboard.argtypes = ()
user32.CloseClipboard.argtypes = ()
user32.GetDpiForSystem.restype = wintypes.UINT
# HANDLE is pointer-sized: without an explicit signature ctypes assumes a
# 32-bit int and a 64-bit handle overflows it (OverflowError on CloseHandle).
kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
kernel32.CloseHandle.restype = wintypes.BOOL
# DPI_AWARENESS_CONTEXT is an opaque pointer (-4 is PER_MONITOR_AWARE_V2).
user32.SetProcessDpiAwarenessContext.argtypes = (ctypes.c_void_p,)
user32.SetProcessDpiAwarenessContext.restype = wintypes.BOOL
kernel32.GlobalFree.argtypes = (wintypes.HGLOBAL,)
kernel32.GlobalUnlock.restype = wintypes.BOOL
kernel32.QueryFullProcessImageNameW.argtypes = (
    wintypes.HANDLE,
    wintypes.DWORD,
    ctypes.c_wchar_p,
    ctypes.POINTER(wintypes.DWORD),
)
gdi32.CreateCompatibleDC.argtypes = (wintypes.HDC,)
gdi32.CreateCompatibleDC.restype = wintypes.HDC
gdi32.CreateCompatibleBitmap.argtypes = (wintypes.HDC, ctypes.c_int, ctypes.c_int)
gdi32.CreateCompatibleBitmap.restype = wintypes.HBITMAP
gdi32.SelectObject.argtypes = (wintypes.HDC, wintypes.HGDIOBJ)
gdi32.SelectObject.restype = wintypes.HGDIOBJ
gdi32.BitBlt.argtypes = (
    wintypes.HDC,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    wintypes.HDC,
    ctypes.c_int,
    ctypes.c_int,
    wintypes.DWORD,
)
gdi32.BitBlt.restype = wintypes.BOOL
gdi32.GetDIBits.argtypes = (
    wintypes.HDC,
    wintypes.HBITMAP,
    wintypes.UINT,
    wintypes.UINT,
    ctypes.c_void_p,
    ctypes.POINTER(BITMAPINFO),
    wintypes.UINT,
)
gdi32.GetDIBits.restype = ctypes.c_int
gdi32.DeleteObject.argtypes = (wintypes.HGDIOBJ,)
gdi32.DeleteDC.argtypes = (wintypes.HDC,)


def _input_mouse(flags, dx=0, dy=0, data=0):
    union = _INPUTUNION()
    union.mi = MOUSEINPUT(dx, dy, data, flags, 0, 0)
    return INPUT(INPUT_MOUSE, union)


def _input_key(vk=0, scan=0, flags=0):
    union = _INPUTUNION()
    union.ki = KEYBDINPUT(vk, scan, flags, 0, 0)
    return INPUT(INPUT_KEYBOARD, union)


def _send(inputs):
    count = len(inputs)
    if not count:
        return
    array = (INPUT * count)(*inputs)
    sent = user32.SendInput(count, array, ctypes.sizeof(INPUT))
    if sent != count:
        raise BackendError(
            "SendInput delivered %d of %d events (WinError %d)"
            % (sent, count, ctypes.get_last_error())
        )


def _virtual_screen():
    return (
        user32.GetSystemMetrics(SM_XVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_YVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_CXVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_CYVIRTUALSCREEN),
    )


def _to_absolute(x, y):
    vx, vy, vw, vh = _virtual_screen()
    nx = int(round((x - vx) * 65535.0 / max(1, vw - 1)))
    ny = int(round((y - vy) * 65535.0 / max(1, vh - 1)))
    clamp = lambda value: max(0, min(65535, value))
    return clamp(nx), clamp(ny)


def _enable_dpi_awareness():
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


def _process_name(pid):
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ""
    try:
        buffer = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(len(buffer))
        if kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return os.path.basename(buffer.value)
    finally:
        kernel32.CloseHandle(handle)
    return ""


class WindowsBackend(Backend):
    platform = "windows"
    display_name = "Windows"

    def __init__(self):
        self.dpi_mode = _enable_dpi_awareness()
        # scripts/cu/backends/windows.py -> scripts/win_uia.ps1 (three levels
        # up; two levels lands inside scripts/cu and silently disables UIA).
        self._ps_script = os.path.join(
            os.path.dirname(
                os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            ),
            "win_uia.ps1",
        )
        self._ps_available = bool(
            os.path.isfile(self._ps_script) and self._find_powershell()
        )

    # -- helpers -----------------------------------------------------------
    @staticmethod
    def _find_powershell():
        import shutil

        for name in ("powershell.exe", "powershell", "pwsh.exe", "pwsh"):
            found = shutil.which(name)
            if found:
                return found
        return None

    def capabilities(self):
        return {
            "platform": self.platform,
            "display": True,
            "screenshot": True,
            "pointer": True,
            "keyboard": True,
            "windows": True,
            "ui_tree": self._ps_available,
            "clipboard": True,
            "dpi_awareness": self.dpi_mode,
            "notes": (
                "Accessibility tree uses UI Automation through PowerShell."
                if self._ps_available
                else "UI Automation bridge unavailable; use screenshots and coordinates."
            ),
        }

    def screen_info(self):
        vx, vy, vw, vh = _virtual_screen()
        try:
            dpi = user32.GetDpiForSystem()
            scale = round(dpi / 96.0, 3)
        except (AttributeError, OSError):
            scale = 1.0
        return {
            "width": vw,
            "height": vh,
            "scale": scale,
            "virtual": {"x": vx, "y": vy, "width": vw, "height": vh},
            "dpi_awareness": self.dpi_mode,
        }

    # -- windows -----------------------------------------------------------
    def _windows(self):
        found = []

        def callback(hwnd, _lparam):
            if not user32.IsWindowVisible(hwnd):
                return True
            length = user32.GetWindowTextLengthW(hwnd)
            if length <= 0:
                return True
            buffer = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buffer, length + 1)
            title = buffer.value.strip()
            if not title:
                return True
            if title in ("CuOverlayCursor", "CuOverlayBanner", "CuOverlayScreen"):
                # The computer-use control overlay is a click-through tool
                # window owned by this plugin. It is visible by design, but it
                # is not a target: listing it would let the agent try to
                # screenshot or focus its own decoration.
                return True
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            rect = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            found.append(
                {
                    "id": str(int(hwnd)),
                    "title": title,
                    "app": _process_name(pid.value),
                    "pid": pid.value,
                    "bounds": {
                        "x": rect.left,
                        "y": rect.top,
                        "width": max(0, rect.right - rect.left),
                        "height": max(0, rect.bottom - rect.top),
                    },
                    "minimized": bool(user32.IsIconic(hwnd)),
                    "active": hwnd == user32.GetForegroundWindow(),
                }
            )
            return True

        user32.EnumWindows(WNDENUMPROC(callback), 0)
        return found

    def list_windows(self):
        return self._windows()

    def resolve_window(self, window_id=None, title=None):
        windows = self._windows()
        if window_id:
            wanted = str(window_id).lower()
            for window in windows:
                if window["id"].lower() == wanted:
                    return window
        if title:
            needle = str(title).lower()
            for window in windows:
                if needle in window["title"].lower():
                    return window
        raise BackendError("no visible window matched %s" % (window_id or title))

    def focus_window(self, window_id=None, title=None):
        window = self.resolve_window(window_id, title)
        hwnd = wintypes.HWND(int(window["id"]))
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, SW_RESTORE)
        if not user32.SetForegroundWindow(hwnd):
            # The foreground lock rejects background activation; a synthetic
            # ALT press is the documented way to release it.
            _send([_input_key(VK_MENU)])
            raised = bool(user32.SetForegroundWindow(hwnd))
            _send([_input_key(VK_MENU, 0, KEYEVENTF_KEYUP)])
            if not raised:
                user32.BringWindowToTop(hwnd)
        time.sleep(0.15)
        return self.resolve_window(window["id"])

    def window_at(self, x, y):
        """Resolve the top-level window under a screen point (for app-level policy)."""
        point = wintypes.POINT(int(x), int(y))
        hwnd = user32.WindowFromPoint(point)
        if not hwnd:
            return None
        root = user32.GetAncestor(hwnd, 2)  # GA_ROOT
        if root:
            hwnd = root
        length = user32.GetWindowTextLengthW(hwnd)
        title = ""
        if length > 0:
            buffer = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buffer, length + 1)
            title = buffer.value.strip()
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        return {
            "id": str(int(hwnd)),
            "title": title,
            "app": _process_name(pid.value),
            "pid": pid.value,
            "bounds": {
                "x": rect.left,
                "y": rect.top,
                "width": max(0, rect.right - rect.left),
                "height": max(0, rect.bottom - rect.top),
            },
        }

    def active_window(self):
        hwnd = user32.GetForegroundWindow()
        for window in self._windows():
            if window["id"] == str(int(hwnd)):
                return window
        return None

    # -- capture -----------------------------------------------------------
    def capture_screenshot(self, path, region=None, max_width=None):
        if region:
            x, y, width, height = (int(value) for value in region)
        else:
            x, y, width, height = _virtual_screen()
        width = max(1, width)
        height = max(1, height)

        screen_dc = user32.GetDC(None)
        if not screen_dc:
            raise BackendError("screenshot unavailable: GetDC failed")
        memory_dc = gdi32.CreateCompatibleDC(screen_dc)
        bitmap = gdi32.CreateCompatibleBitmap(screen_dc, width, height)
        if not memory_dc or not bitmap:
            user32.ReleaseDC(None, screen_dc)
            raise BackendError("screenshot unavailable: could not allocate a capture surface")
        previous = gdi32.SelectObject(memory_dc, bitmap)
        try:
            if not gdi32.BitBlt(
                memory_dc, 0, 0, width, height, screen_dc, x, y, SRCCOPY | CAPTUREBLT
            ):
                raise BackendError("screenshot unavailable: BitBlt failed (WinError %d)" % ctypes.get_last_error())
            info = BITMAPINFO()
            info.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
            info.bmiHeader.biWidth = width
            info.bmiHeader.biHeight = -height
            info.bmiHeader.biPlanes = 1
            info.bmiHeader.biBitCount = 32
            info.bmiHeader.biCompression = 0
            buffer = ctypes.create_string_buffer(width * height * 4)
            scanned = gdi32.GetDIBits(
                memory_dc, bitmap, 0, height, buffer, ctypes.byref(info), 0
            )
            if not scanned:
                raise BackendError("GetDIBits failed (WinError %d)" % ctypes.get_last_error())
        finally:
            gdi32.SelectObject(memory_dc, previous)
            gdi32.DeleteObject(bitmap)
            gdi32.DeleteDC(memory_dc)
            user32.ReleaseDC(None, screen_dc)

        step = 1
        if max_width and width > int(max_width):
            # Ceiling division: rounding down would emit a wider image than
            # the caller asked for.
            step = max(1, -(-width // int(max_width)))
        png = encode_png(
            width, height, buffer.raw, stride=width * 4, bottom_up=False, step=step
        )
        with open(path, "wb") as handle:
            handle.write(png)
        return path

    # -- input -------------------------------------------------------------
    def move_mouse(self, x, y, duration_ms=0):
        nx, ny = _to_absolute(int(x), int(y))
        flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
        if duration_ms and duration_ms > 0:
            start = self.cursor_position()
            steps = max(2, min(60, int(duration_ms / 15)))
            for step in range(1, steps + 1):
                px = int(start[0] + (int(x) - start[0]) * step / steps)
                py = int(start[1] + (int(y) - start[1]) * step / steps)
                ax, ay = _to_absolute(px, py)
                _send([_input_mouse(flags, ax, ay)])
                time.sleep(max(0.001, duration_ms / 1000.0 / steps))
            return
        _send([_input_mouse(flags, nx, ny)])

    def cursor_position(self):
        point = wintypes.POINT()
        user32.GetCursorPos(ctypes.byref(point))
        return (point.x, point.y)

    def click(self, x, y, button="left", count=1):
        down, up = BUTTON_FLAGS.get(button, BUTTON_FLAGS["left"])
        self.move_mouse(x, y)
        time.sleep(0.02)
        events = []
        for _ in range(max(1, int(count))):
            events.append(_input_mouse(down))
            events.append(_input_mouse(up))
        _send(events)

    def drag(self, from_x, from_y, to_x, to_y, button="left", duration_ms=400):
        down, up = BUTTON_FLAGS.get(button, BUTTON_FLAGS["left"])
        self.move_mouse(from_x, from_y)
        time.sleep(0.05)
        _send([_input_mouse(down)])
        steps = max(3, min(80, int(duration_ms / 12) or 3))
        for step in range(1, steps + 1):
            x = int(from_x + (to_x - from_x) * step / steps)
            y = int(from_y + (to_y - from_y) * step / steps)
            nx, ny = _to_absolute(x, y)
            _send(
                [
                    _input_mouse(
                        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                        nx,
                        ny,
                    )
                ]
            )
            time.sleep(max(0.005, duration_ms / 1000.0 / steps))
        _send([_input_mouse(up)])

    def scroll(self, amount, x=None, y=None):
        if x is not None and y is not None:
            self.move_mouse(x, y)
            time.sleep(0.02)
        steps = max(1, int(abs(int(amount))))
        delta = WHEEL_DELTA if int(amount) > 0 else -WHEEL_DELTA
        # MOUSEINPUT.mouseData is an unsigned DWORD. Assigning -120 directly
        # raises OverflowError on a 64-bit interpreter, so wrap it explicitly:
        # the high bit is how Windows encodes a downward wheel rotation.
        wheel_data = wintypes.DWORD(delta & 0xFFFFFFFF).value
        _send(
            [_input_mouse(MOUSEEVENTF_WHEEL, 0, 0, wheel_data) for _ in range(steps)]
        )

    def type_text(self, text, interval_ms=0):
        pending = []

        def flush():
            if pending:
                _send(list(pending))
                del pending[:]

        for char in text:
            if char == "\n":
                pending.append(_input_key(NAMED_KEYS["enter"]))
                pending.append(_input_key(NAMED_KEYS["enter"], 0, KEYEVENTF_KEYUP))
            elif char == "\t":
                pending.append(_input_key(NAMED_KEYS["tab"]))
                pending.append(_input_key(NAMED_KEYS["tab"], 0, KEYEVENTF_KEYUP))
            elif char == "\r":
                continue
            else:
                for unit in _utf16_units(char):
                    pending.append(_input_key(0, unit, KEYEVENTF_UNICODE))
                    pending.append(
                        _input_key(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)
                    )
            if len(pending) >= 512:
                flush()
            if interval_ms:
                time.sleep(max(0.0, interval_ms / 1000.0))
        flush()

    def press_keys(self, keys):
        combo = normalize_combo(keys)
        if not combo:
            raise BackendError("no keys were supplied")
        events = []
        for name in combo[:-1]:
            vk = NAMED_KEYS.get(name)
            if vk is None:
                raise BackendError("unknown key name: %s" % name)
            events.append(_input_key(vk, 0, _extended(name)))
        key = combo[-1]
        if key in NAMED_KEYS:
            vk = NAMED_KEYS[key]
            events.append(_input_key(vk, 0, _extended(key)))
            events.append(_input_key(vk, 0, _extended(key) | KEYEVENTF_KEYUP))
        elif len(key) == 1:
            for unit in _utf16_units(key):
                events.append(_input_key(0, unit, KEYEVENTF_UNICODE))
                events.append(_input_key(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
        else:
            raise BackendError("unknown key name: %s" % key)
        for name in reversed(combo[:-1]):
            vk = NAMED_KEYS[name]
            events.append(_input_key(vk, 0, _extended(name) | KEYEVENTF_KEYUP))
        _send(events)

    # -- clipboard ---------------------------------------------------------
    def clipboard(self, action, text=None):
        if action == "read":
            return self._clipboard_read()
        self._clipboard_write(text or "")
        return ""

    def _clipboard_read(self):
        if not user32.OpenClipboard(None):
            raise BackendError("OpenClipboard failed (WinError %d)" % ctypes.get_last_error())
        try:
            handle = user32.GetClipboardData(CF_UNICODETEXT)
            if not handle:
                return ""
            pointer = kernel32.GlobalLock(handle)
            if not pointer:
                return ""
            try:
                return ctypes.c_wchar_p(pointer).value or ""
            finally:
                kernel32.GlobalUnlock(handle)
        finally:
            user32.CloseClipboard()

    def _clipboard_write(self, text):
        payload = text.encode("utf-16-le") + b"\x00\x00"
        if not user32.OpenClipboard(None):
            raise BackendError("OpenClipboard failed (WinError %d)" % ctypes.get_last_error())
        try:
            user32.EmptyClipboard()
            handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(payload))
            if not handle:
                raise BackendError("GlobalAlloc failed")
            pointer = kernel32.GlobalLock(handle)
            if not pointer:
                kernel32.GlobalFree(handle)
                raise BackendError("GlobalLock failed")
            ctypes.memmove(pointer, payload, len(payload))
            kernel32.GlobalUnlock(handle)
            if not user32.SetClipboardData(CF_UNICODETEXT, handle):
                kernel32.GlobalFree(handle)
                raise BackendError("SetClipboardData failed")
        finally:
            user32.CloseClipboard()

    # -- launch ------------------------------------------------------------
    def open_app(self, target):
        if os.path.exists(target) or re.match(r"^[a-zA-Z][a-zA-Z0-9+.\-]*://", target):
            try:
                os.startfile(target)  # noqa: S606 - deliberate shell-free open
            except (OSError, AttributeError) as exc:
                raise BackendError("could not open %s: %s" % (target, exc))
        else:
            try:
                subprocess.Popen(["cmd", "/c", "start", "", target], shell=False)
            except OSError as exc:
                raise BackendError("could not launch %s: %s" % (target, exc))
        return target

    # -- UI Automation bridge ---------------------------------------------
    def _uia(self, mode, **params):
        if not self._ps_available:
            raise UnsupportedAction(
                "UI Automation bridge unavailable; use screenshot plus click coordinates"
            )
        shell = self._find_powershell()
        args = [
            shell,
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            self._ps_script,
            "-Mode",
            mode,
        ]
        for key, value in params.items():
            if value is None or value == "":
                continue
            args += ["-" + key, str(value)]
        try:
            completed = subprocess.run(
                args,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=90,
                check=False,
                # Without this every accessibility read flashes a black
                # conhost window on the user's desktop.
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000),
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise BackendError("UI Automation bridge failed to run: %s" % exc)
        stdout = completed.stdout.decode("utf-8", "replace").lstrip("\ufeff").strip()
        stderr = completed.stderr.decode("utf-8", "replace").strip()
        if not stdout:
            raise BackendError(
                "UI Automation bridge returned nothing (exit %d): %s"
                % (completed.returncode, stderr[:400] or "no stderr")
            )
        try:
            payload = json.loads(stdout)
        except ValueError:
            raise BackendError("UI Automation bridge returned invalid JSON: %s" % stdout[:400])
        if isinstance(payload, dict) and payload.get("error"):
            raise BackendError("UI Automation: %s" % payload["error"])
        return payload

    def ui_tree(self, window_id=None, max_depth=6, max_elements=200):
        payload = self._uia(
            "tree",
            Handle=window_id or "",
            MaxDepth=int(max_depth),
            MaxElements=int(max_elements),
        )
        return payload.get("elements", [])

    def find_elements(self, query, window_id=None, limit=20):
        payload = self._uia(
            "find", Query=query, Handle=window_id or "", MaxElements=int(limit)
        )
        return payload.get("elements", [])

    def focused_element(self):
        try:
            payload = self._uia("focus")
        except (BackendError, UnsupportedAction):
            return None
        return payload.get("element")

    def click_element(self, query=None, element_id=None, window_id=None):
        payload = self._uia("invoke", Query=query or element_id or "", Handle=window_id or "")
        element = payload.get("element") or {}
        if payload.get("invoked"):
            return {"element": element, "action": "invoke"}
        rect = element.get("rect") or {}
        if not rect.get("width"):
            raise BackendError(
                "element could not be invoked and has no usable bounds; try screenshot coordinates"
            )
        self.click(rect["x"] + rect["width"] // 2, rect["y"] + rect["height"] // 2)
        return {"element": element, "action": "click"}


def _extended(name):
    return KEYEVENTF_EXTENDEDKEY if name in EXTENDED_KEYS else 0


def _utf16_units(char):
    code = ord(char)
    if code > 0xFFFF:
        code -= 0x10000
        return (0xD800 + (code >> 10), 0xDC00 + (code & 0x3FF))
    return (code,)
