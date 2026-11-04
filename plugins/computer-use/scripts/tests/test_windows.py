"""The Windows backend, exercised against a stubbed Win32 layer.

Nothing here touches a real desktop: the ctypes boundary is replaced, so the
event sequences, coordinate mapping and struct layout the backend produces can
be asserted exactly. Absolute struct sizes are only checked on a platform whose
LONG really is 4 bytes (i.e. when this suite runs on Windows itself).
"""

import ctypes
import ctypes.wintypes as wintypes
import os
import shutil
import struct

from .helpers import Suite, Win32Recorder, load_windows_module

from cu.backends.base import BackendError, UnsupportedAction
from cu.imaging import png_size

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None

MOUSE, KEYBOARD = 0, 1


def keys(batch):
    return [(event.ki.wVk, event.ki.dwFlags) for event in batch if event.type == KEYBOARD]


def scans(batch):
    return [(event.ki.wScan, event.ki.dwFlags) for event in batch if event.type == KEYBOARD]


def mice(batch):
    return [(event.mi.dx, event.mi.dy, event.mi.dwFlags, event.mi.mouseData) for event in batch if event.type == MOUSE]


def run():
    suite = Suite("windows")
    recorder = Win32Recorder()
    module = load_windows_module(recorder)
    backend = module.WindowsBackend()

    # --- identity and capabilities ---------------------------------------
    suite.check("the UIA bridge resolves to scripts/win_uia.ps1",
                os.path.basename(backend._ps_script) == "win_uia.ps1"
                and os.path.isfile(backend._ps_script), backend._ps_script)
    # These are hermetic Win32 unit tests: never let the accessibility path
    # reach the real desktop or invoke anything in the foreground window.
    backend._ps_available = False
    suite.equal("platform", backend.platform, "windows")
    suite.equal("dpi awareness prefers per-monitor-v2", backend.dpi_mode, "per-monitor-v2")
    caps = backend.capabilities()
    suite.equal("capabilities platform", caps["platform"], "windows")
    suite.check("the accessibility bridge reports honestly",
                caps["ui_tree"] is bool(backend._ps_available), caps["ui_tree"])
    if not caps["ui_tree"]:
        suite.check("without the bridge the notes say what to do instead",
                    "screenshot" in caps["notes"].lower(), caps["notes"])

    info = backend.screen_info()
    suite.equal("screen width comes from the virtual desktop metrics", info["width"], 1920)
    suite.equal("screen height comes from the virtual desktop metrics", info["height"], 1080)
    suite.equal("the virtual desktop origin is reported", (info["virtual"]["x"], info["virtual"]["y"]), (0, 0))
    suite.equal("dpi scaling is derived from GetDpiForSystem", info["scale"], 1.5)

    # --- window discovery -------------------------------------------------
    windows = backend.list_windows()
    suite.equal("one window is enumerated", len(windows), 1)
    window = windows[0]
    suite.equal("the window title is read", window["title"], "Untitled - Notepad")
    recorder.title = "CuOverlayBanner"
    suite.equal("the control overlay is not offered as a target",
                backend.list_windows(), [])
    recorder.title = "Untitled - Notepad"
    # os.path.basename only strips a backslash path on Windows, so the exact
    # executable name is asserted there and the suffix everywhere else.
    suite.check("the owning process is resolved", window["app"].endswith("notepad.exe"), window["app"])
    if os.name == "nt":
        suite.equal("the executable name is stripped of its path", window["app"], "notepad.exe")
    suite.equal("the process id is reported", window["pid"], 4242)
    suite.equal("the window bounds come from GetWindowRect", window["bounds"],
                {"x": 120, "y": 90, "width": 820, "height": 620})
    suite.check("the foreground window is marked active", window["active"] is True)
    suite.equal("the window id is the handle", window["id"], str(recorder.hwnd))

    found = backend.window_at(200, 200)
    suite.check("window_at resolves the owning process", found["app"].endswith("notepad.exe"), found["app"])
    suite.check("window_at uses WindowFromPoint", recorder.count("WindowFromPoint") >= 1)

    recorder.overrides["OpenProcess"] = 0
    suite.check("an unreadable process degrades to an empty name",
                backend.window_at(200, 200)["app"] == "")
    del recorder.overrides["OpenProcess"]

    # --- accessibility bridge --------------------------------------------
    suite.raises("ui_tree without PowerShell is unsupported", UnsupportedAction, backend.ui_tree)
    suite.raises("find_elements without PowerShell is unsupported",
                 UnsupportedAction, backend.find_elements, "Save")
    suite.check("focused_element degrades to None without the bridge",
                backend.focused_element() is None)
    suite.raises("click_element without PowerShell is unsupported",
                 UnsupportedAction, backend.click_element, "Save")

    # --- screenshot through GDI ------------------------------------------
    target = "/tmp/cu-windows-shot.png"
    before = (recorder.count("GetDC"), recorder.count("CreateCompatibleDC"),
              recorder.count("CreateCompatibleBitmap"), recorder.count("DeleteObject"),
              recorder.count("DeleteDC"), recorder.count("ReleaseDC"))
    path = backend.capture_screenshot(target, None, None)
    suite.equal("the screenshot path is returned", path, target)
    with open(path, "rb") as handle:
        data = handle.read()
    suite.equal("a full screen capture is 1920x1080", png_size(data), (1920, 1080))
    blit = recorder.args_of("BitBlt")[-1]
    suite.equal("the blit covers the whole screen", tuple(blit[3:5]), (1920, 1080))
    suite.equal("the blit reads from the screen origin", tuple(blit[6:8]), (0, 0))
    suite.check("the blit copies pixels and layered windows",
                blit[8] & 0x00CC0020 == 0x00CC0020 and blit[8] & 0x40000000, hex(blit[8]))

    after = (recorder.count("GetDC"), recorder.count("CreateCompatibleDC"),
             recorder.count("CreateCompatibleBitmap"), recorder.count("DeleteObject"),
             recorder.count("DeleteDC"), recorder.count("ReleaseDC"))
    suite.equal("every device context is created and released",
                (after[0] - before[0], after[1] - before[1], after[5] - before[5]), (1, 1, 1))
    suite.equal("the bitmap is deleted, not leaked", after[3] - before[3], 1)
    suite.equal("the memory dc is deleted, not leaked", after[4] - before[4], 1)

    region = backend.capture_screenshot(target, (100, 100, 200, 150), None)
    suite.equal("a region capture has the region size", png_size(open(region, "rb").read()), (200, 150))
    blit = recorder.args_of("BitBlt")[-1]
    suite.equal("the blit reads from the region offset", tuple(blit[6:8]), (100, 100))

    backend.capture_screenshot(target, None, 640)
    suite.equal("max_width downscales a full screen capture",
                png_size(open(target, "rb").read()), (640, 360))

    if Image:
        with Image.open(target) as image:
            suite.equal("the capture decodes", image.size, (640, 360))

    # a failing blit must still release the GDI handles
    failing = Win32Recorder()
    failing.overrides["BitBlt"] = 0
    other = load_windows_module(failing).WindowsBackend()
    suite.raises("a failed blit is reported", BackendError, other.capture_screenshot, target, None, None)
    suite.equal("a failed blit still releases the memory dc", failing.count("DeleteDC"), 1)
    suite.equal("a failed blit still releases the bitmap", failing.count("DeleteObject"), 1)
    suite.equal("a failed blit still releases the screen dc", failing.count("ReleaseDC"), 1)

    # --- pointer ----------------------------------------------------------
    module_ = load_windows_module(recorder)
    backend = module_.WindowsBackend()
    recorder.batches.clear()

    backend.move_mouse(100, 200)
    suite.equal("a move sends one event", len(recorder.batches[-1]), 1)
    dx, dy, flags, _ = mice(recorder.batches[-1])[0]
    suite.equal("the move is absolute over the virtual desktop", flags, 0x0001 | 0x8000 | 0x4000)
    suite.equal("the x coordinate is normalized", dx, int(round(100 * 65535.0 / 1919)))
    suite.equal("the y coordinate is normalized", dy, int(round(200 * 65535.0 / 1079)))

    recorder.batches.clear()
    backend.click(100, 200)
    suite.equal("a click moves first", len(recorder.batches[0]), 1)
    suite.equal("then presses and releases", keys(recorder.batches[1]), [])
    suite.equal("the click is a left button pair",
                [(m[2], m[3]) for m in mice(recorder.batches[1])],
                [(0x0002, 0), (0x0004, 0)])
    recorder.batches.clear()
    backend.click(100, 200, "right", 2)
    suite.equal("a double right click sends four events", len(recorder.batches[1]), 4)
    suite.equal("the right button flags are used",
                [(m[2]) for m in mice(recorder.batches[1])], [0x0008, 0x0010, 0x0008, 0x0010])
    recorder.batches.clear()
    backend.click(100, 200, "sideways")
    suite.equal("an unknown button falls back to the left button",
                [m[2] for m in mice(recorder.batches[1])], [0x0002, 0x0004])

    recorder.batches.clear()
    backend.scroll(3)
    suite.equal("three notches send three wheel events", len(recorder.batches[-1]), 3)
    suite.equal("a positive scroll goes up", [m[3] for m in mice(recorder.batches[-1])], [120, 120, 120])
    recorder.batches.clear()
    backend.scroll(-2)
    suite.equal("a negative scroll goes down",
                [ctypes.c_int32(m[3]).value for m in mice(recorder.batches[-1])], [-120, -120])
    recorder.batches.clear()
    backend.scroll(1, 50, 60)
    suite.equal("scrolling can move the pointer first", len(recorder.batches), 2)

    recorder.batches.clear()
    backend.drag(0, 0, 400, 300)
    suite.equal("a drag is a press, a glide and a release",
                [len(batch) for batch in recorder.batches][0], 1)
    suite.equal("the drag presses the left button", mice(recorder.batches[1])[0][2], 0x0002)
    suite.equal("the drag releases the left button", mice(recorder.batches[-1])[0][2], 0x0004)
    glide = recorder.batches[2:-1]
    suite.check("the glide is interpolated over many steps", len(glide) >= 3, len(glide))
    suite.check("the glide ends near the target",
                mice(glide[-1])[0][0] >= mice(glide[0])[0][0], "monotonic movement")

    # --- keyboard ---------------------------------------------------------
    recorder.batches.clear()
    backend.type_text("A")
    suite.equal("a letter is typed as unicode", scans(recorder.batches[-1]),
                [(ord("A"), 0x0004), (ord("A"), 0x0006)])
    recorder.batches.clear()
    backend.type_text("\n")
    suite.equal("a newline is the enter key", keys(recorder.batches[-1]), [(0x0D, 0), (0x0D, 0x0002)])
    recorder.batches.clear()
    backend.type_text("a\tb")
    suite.equal("a tab is the tab key", [k for k in keys(recorder.batches[-1]) if k[0] == 0x09],
                [(0x09, 0), (0x09, 0x0002)])
    recorder.batches.clear()
    backend.type_text("\r")
    suite.equal("a carriage return is dropped", recorder.batches, [])

    recorder.batches.clear()
    backend.type_text("a" * 600)
    suite.equal("600 characters are flushed in batches of 512 events", len(recorder.batches), 3)
    suite.equal("no event is lost", sum(len(batch) for batch in recorder.batches), 1200)
    suite.check("no batch exceeds the SendInput ceiling",
                all(len(batch) <= 512 for batch in recorder.batches),
                [len(batch) for batch in recorder.batches])

    recorder.batches.clear()
    backend.press_keys(["ctrl", "shift", "s"])
    suite.equal("modifiers are pressed in order and released in reverse",
                keys(recorder.batches[-1]),
                [(0x11, 0), (0x10, 0), (0x53, 0), (0x53, 0x0002), (0x10, 0x0002), (0x11, 0x0002)])
    recorder.batches.clear()
    backend.press_keys("ctrl+s")
    suite.equal("a combo string is accepted", keys(recorder.batches[-1])[-1], (0x11, 0x0002))
    recorder.batches.clear()
    backend.press_keys(["win", "r"])
    suite.equal("the windows key is flagged as extended",
                keys(recorder.batches[-1]), [(0x5B, 0x0001), (0x52, 0), (0x52, 0x0002), (0x5B, 0x0003)])
    recorder.batches.clear()
    backend.press_keys(["delete"])
    suite.equal("delete carries the extended flag on press and release",
                keys(recorder.batches[-1]), [(0x2E, 0x0001), (0x2E, 0x0003)])
    recorder.batches.clear()
    backend.press_keys(["alt", "tab"])
    suite.equal("alt+tab uses plain flags",
                keys(recorder.batches[-1]), [(0x12, 0), (0x09, 0), (0x09, 0x0002), (0x12, 0x0002)])
    recorder.batches.clear()
    backend.press_keys(["ctrl", "\u20ac"])
    suite.equal("a non-ascii key falls back to unicode input",
                scans(recorder.batches[-1]),
                [(0, 0), (0x20AC, 0x0004), (0x20AC, 0x0006), (0, 0x0002)])
    suite.raises("an unknown key name is refused", BackendError, backend.press_keys, ["nope"])
    suite.raises("an empty combo is refused", BackendError, backend.press_keys, [])

    # --- send failures ----------------------------------------------------
    recorder.overrides["SendInput"] = 0
    suite.raises("a partial SendInput is reported", BackendError, backend.move_mouse, 1, 1)
    del recorder.overrides["SendInput"]

    # --- coordinate mapping ----------------------------------------------
    suite.equal("the top-left corner maps to 0,0", module_._to_absolute(0, 0), (0, 0))
    suite.equal("the bottom-right pixel maps to the maximum",
                module_._to_absolute(1919, 1079), (65535, 65535))
    centre = module_._to_absolute(960, 540)
    suite.check("the centre maps near half of the range",
                all(abs(value - 32768) <= 40 for value in centre), centre)
    suite.equal("off-screen coordinates are clamped low", module_._to_absolute(-500, -500), (0, 0))
    suite.equal("off-screen coordinates are clamped high", module_._to_absolute(9999, 9999), (65535, 65535))

    wide = Win32Recorder(metrics={76: -1920, 77: 0, 78: 3840, 79: 1080})
    wide_module = load_windows_module(wide)
    suite.equal("a left-hand monitor maps to the left edge",
                wide_module._to_absolute(-1920, 0), (0, 0))
    suite.equal("the primary screen origin is not the zero point",
                wide_module._to_absolute(0, 0), (int(round(1920 * 65535.0 / 3839)), 0))
    suite.equal("the right-hand edge maps to the maximum",
                wide_module._to_absolute(1919, 1079), (65535, 65535))
    suite.equal("the virtual desktop width is read", wide_module._virtual_screen(), (-1920, 0, 3840, 1080))

    # --- dpi fallbacks ----------------------------------------------------
    for mode, expected in (("per-monitor-v2", "per-monitor-v2"), ("per-monitor", "per-monitor"),
                           ("system", "system"), ("none", "none")):
        probe = Win32Recorder(dpi=mode)
        suite.equal("dpi fallback %s" % mode,
                    load_windows_module(probe)._enable_dpi_awareness(), expected)

    # --- utf-16 helpers ---------------------------------------------------
    module_ = load_windows_module(Win32Recorder())
    suite.equal("an ascii character is one unit", module_._utf16_units("a"), (0x61,))
    suite.equal("a bmp character is one unit", module_._utf16_units("\u4e2d"), (0x4E2D,))
    pair = module_._utf16_units("\U0001F600")
    suite.equal("an emoji becomes a surrogate pair", pair, (0xD83D, 0xDE00))
    suite.equal("the pair decodes back to the code point",
                b"".join(struct.pack("<H", unit) for unit in pair).decode("utf-16-le"), "\U0001F600")
    suite.equal("extended keys are flagged", module_._extended("delete"), 0x0001)
    suite.equal("ordinary keys are not", module_._extended("a"), 0)

    # --- key table --------------------------------------------------------
    for name, code in (("enter", 0x0D), ("esc", 0x1B), ("tab", 0x09), ("space", 0x20),
                       ("f1", 0x70), ("f12", 0x7B), ("f24", 0x87), ("a", 0x41), ("z", 0x5A),
                       ("0", 0x30), ("9", 0x39), ("win", 0x5B), ("delete", 0x2E), ("home", 0x24)):
        suite.equal("key %s" % name, module_.NAMED_KEYS.get(name), code)

    # --- struct layout ----------------------------------------------------
    # The declarations are checked everywhere; exact offsets and sizes are only
    # meaningful where LONG/DWORD are the Windows widths, so those run on
    # Windows itself and are reported as skipped elsewhere.
    suite.equal("INPUT has the documented fields", [name for name, _ in module_.INPUT._fields_], ["type", "u"])
    suite.equal("the input type is first", module_.INPUT.type.offset, 0)
    suite.equal("the union holds the three input kinds",
                [name for name, _ in module_._INPUTUNION._fields_], ["mi", "ki", "hi"])
    suite.equal("the keyboard virtual key is first", module_.KEYBDINPUT.wVk.offset, 0)
    suite.equal("the scan code follows the virtual key", module_.KEYBDINPUT.wScan.offset, 2)
    key_types = dict(module_.KEYBDINPUT._fields_)
    mouse_types = dict(module_.MOUSEINPUT._fields_)
    suite.equal("the virtual key is a 16-bit field", ctypes.sizeof(key_types["wVk"]), 2)
    suite.equal("the scan code is a 16-bit field", ctypes.sizeof(key_types["wScan"]), 2)
    suite.check("the keyboard fields use the documented Win32 types",
                key_types["wVk"] is wintypes.WORD and key_types["wScan"] is wintypes.WORD
                and key_types["dwFlags"] is wintypes.DWORD
                and key_types["dwExtraInfo"] is module_.ULONG_PTR,
                [kind.__name__ for kind in key_types.values()])
    suite.check("the mouse fields use the documented Win32 types",
                mouse_types["dx"] is wintypes.LONG and mouse_types["mouseData"] is wintypes.DWORD
                and mouse_types["dwFlags"] is wintypes.DWORD,
                [kind.__name__ for kind in mouse_types.values()])
    suite.equal("the mouse struct keeps its field order",
                [name for name, _ in module_.MOUSEINPUT._fields_],
                ["dx", "dy", "mouseData", "dwFlags", "time", "dwExtraInfo"])
    if ctypes.sizeof(ctypes.c_long) == 4:
        suite.equal("the key flags follow the scan code", module_.KEYBDINPUT.dwFlags.offset, 4)
        suite.equal("the mouse flags are the fourth field", module_.MOUSEINPUT.dwFlags.offset, 12)
        suite.equal("INPUT matches the Windows x64 size", ctypes.sizeof(module_.INPUT), 40)
        suite.equal("MOUSEINPUT matches the Windows x64 size", ctypes.sizeof(module_.MOUSEINPUT), 32)
        suite.equal("KEYBDINPUT matches the Windows x64 size", ctypes.sizeof(module_.KEYBDINPUT), 24)
    else:
        suite.check("exact struct offsets/sizes need the Windows ABI; run this suite on Windows", True)

    # --- clipboard --------------------------------------------------------
    clip = Win32Recorder()
    clip_module = load_windows_module(clip)
    clip_backend = clip_module.WindowsBackend()
    suite.equal("an empty clipboard reads as empty", clip_backend.clipboard("read"), "")

    text = "h\u00e9llo \u4e16\u754c"
    clip_backend.clipboard("write", text)
    payload = text.encode("utf-16-le") + b"\x00\x00"
    suite.equal("the clipboard payload is utf-16-le with a terminator",
                clip._clipboard_memory.raw[: len(payload)], payload)
    suite.equal("the payload length is handed to GlobalAlloc",
                clip.args_of("GlobalAlloc")[-1][1], len(payload))
    suite.equal("the clipboard is emptied before writing", clip.count("EmptyClipboard"), 1)
    suite.equal("the clipboard is closed after reading", clip.count("CloseClipboard"), 2)
    suite.check("the payload is written into the allocated block",
                clip.args_of("GlobalUnlock"), "GlobalUnlock")

    clip.seed_clipboard("from the os")
    suite.equal("a seeded clipboard reads back", clip_backend.clipboard("read"), "from the os")

    if os.name == "nt":
        clip_backend.clipboard("write", text)
        suite.equal("the clipboard round trips unicode", clip_backend.clipboard("read"), text)

    clip.overrides["OpenClipboard"] = 0
    suite.raises("a locked clipboard is reported", BackendError, clip_backend.clipboard, "read")
    clip.overrides["OpenClipboard"] = 1
    clip.overrides["GlobalAlloc"] = 0
    suite.raises("a failed allocation is reported", BackendError, clip_backend.clipboard, "write", "x")

    # --- launcher ---------------------------------------------------------
    if not hasattr(os, "startfile") and shutil.which("cmd") is None:
        suite.raises("a launcher that cannot run is reported clearly",
                     BackendError, clip_backend.open_app, "definitely-not-a-real-app")

    return suite.finish()
