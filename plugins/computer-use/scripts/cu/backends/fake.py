"""A deterministic virtual desktop.

It exists so the whole plugin can be exercised end to end - protocol, policy,
tools, PNG pipeline, audit - on any machine, including a headless CI box, and
so a user can try the plugin in Antigravity before pointing it at their real
desktop. Enable it with ``CU_BACKEND=fake``.

Nothing here touches the operating system: input is recorded in ``actions``,
typing updates the value of the focused field, and screenshots are rendered
from an in-memory framebuffer.
"""

import time

from ..imaging import encode_png
from .base import Backend, BackendError

SCREEN = (0, 0, 1920, 1080)

# A tiny window manager: two windows and a small accessibility tree each.
WINDOWS = [
    {
        "id": "1001",
        "title": "Untitled - Notepad",
        "app": "notepad.exe",
        "pid": 4242,
        "bounds": {"x": 120, "y": 90, "width": 820, "height": 620},
        "active": True,
        "minimized": False,
    },
    {
        "id": "1002",
        "title": "Calculator",
        "app": "calc.exe",
        "pid": 4343,
        "bounds": {"x": 980, "y": 140, "width": 360, "height": 520},
        "active": False,
        "minimized": False,
    },
]

ELEMENTS = [
    {"id": "n0", "window": "1001", "depth": 0, "controlType": "Window", "name": "Untitled - Notepad",
     "automationId": "NotepadWindow", "rect": {"x": 120, "y": 90, "width": 820, "height": 620},
     "patterns": ["Window"], "enabled": True, "offscreen": False},
    {"id": "n1", "window": "1001", "depth": 1, "controlType": "MenuBar", "name": "", "automationId": "MenuBar",
     "rect": {"x": 120, "y": 90, "width": 820, "height": 28}, "patterns": [], "enabled": True, "offscreen": False},
    {"id": "n2", "window": "1001", "depth": 2, "controlType": "MenuItem", "name": "File", "automationId": "FileMenu",
     "rect": {"x": 124, "y": 92, "width": 44, "height": 24}, "patterns": ["Invoke"], "enabled": True, "offscreen": False},
    {"id": "n3", "window": "1001", "depth": 2, "controlType": "MenuItem", "name": "Edit", "automationId": "EditMenu",
     "rect": {"x": 172, "y": 92, "width": 44, "height": 24}, "patterns": ["Invoke"], "enabled": True, "offscreen": False},
    {"id": "n4", "window": "1001", "depth": 1, "controlType": "Document", "name": "Text Editor",
     "automationId": "Editor", "rect": {"x": 128, "y": 122, "width": 804, "height": 500},
     "patterns": ["Value", "Text"], "value": "", "enabled": True, "offscreen": False},
    {"id": "n5", "window": "1001", "depth": 1, "controlType": "Edit", "name": "Search", "automationId": "SearchBox",
     "rect": {"x": 128, "y": 626, "width": 300, "height": 26}, "patterns": ["Value"], "value": "",
     "enabled": True, "offscreen": False},
    {"id": "n6", "window": "1001", "depth": 1, "controlType": "Edit", "name": "Password", "automationId": "PwdField",
     "rect": {"x": 128, "y": 658, "width": 300, "height": 26}, "patterns": ["Value"], "value": "",
     "password": True, "enabled": True, "offscreen": False},
    {"id": "n7", "window": "1001", "depth": 1, "controlType": "Button", "name": "Save", "automationId": "SaveButton",
     "rect": {"x": 700, "y": 660, "width": 110, "height": 30}, "patterns": ["Invoke"], "enabled": True, "offscreen": False},
    {"id": "n8", "window": "1001", "depth": 1, "controlType": "Button", "name": "Close", "automationId": "CloseButton",
     "rect": {"x": 820, "y": 660, "width": 110, "height": 30}, "patterns": ["Invoke"], "enabled": False, "offscreen": False},
    {"id": "c0", "window": "1002", "depth": 0, "controlType": "Window", "name": "Calculator",
     "automationId": "CalcWindow", "rect": {"x": 980, "y": 140, "width": 360, "height": 520},
     "patterns": ["Window"], "enabled": True, "offscreen": False},
    {"id": "c1", "window": "1002", "depth": 1, "controlType": "Button", "name": "7", "automationId": "Seven",
     "rect": {"x": 990, "y": 400, "width": 80, "height": 60}, "patterns": ["Invoke"], "enabled": True, "offscreen": False},
    {"id": "c2", "window": "1002", "depth": 1, "controlType": "Text", "name": "Display", "automationId": "Display",
     "rect": {"x": 990, "y": 160, "width": 340, "height": 80}, "patterns": ["Value"], "value": "0",
     "enabled": True, "offscreen": False},
]


class FakeBackend(Backend):
    platform = "fake"
    display_name = "Virtual desktop"

    def __init__(self):
        self.windows = [dict(window) for window in WINDOWS]
        self.elements = [dict(element) for element in ELEMENTS]
        self.actions = []
        self.clipboard_text = ""
        self.cursor = (960, 540)
        self.focused = "n4"
        self.screen = SCREEN
        self.opened = []

    # -- introspection -----------------------------------------------------
    def capabilities(self):
        return {
            "platform": self.platform,
            "display": True,
            "screenshot": True,
            "pointer": True,
            "keyboard": True,
            "windows": True,
            "ui_tree": True,
            "clipboard": True,
            "virtual": True,
            "notes": (
                "Virtual desktop: nothing is sent to the real machine. "
                "Set CU_BACKEND=fake to get this on purpose."
            ),
        }

    def screen_info(self):
        x, y, width, height = self.screen
        return {
            "width": width,
            "height": height,
            "scale": 1.0,
            "virtual": {"x": x, "y": y, "width": width, "height": height},
            "virtual_desktop": True,
        }

    def focused_element(self):
        for element in self.elements:
            if element["id"] == self.focused:
                return dict(element)
        return None

    def _record(self, action, **fields):
        record = {"action": action}
        record.update(fields)
        self.actions.append(record)
        return record

    # -- windows -----------------------------------------------------------
    def list_windows(self):
        return [dict(window) for window in self.windows]

    def resolve_window(self, window_id=None, title=None):
        for window in self.windows:
            if window_id and str(window["id"]) == str(window_id):
                return dict(window)
            if title and title.lower() in window["title"].lower():
                return dict(window)
        raise BackendError("no window matches id=%r title=%r" % (window_id, title))

    def focus_window(self, window_id=None, title=None):
        window = self.resolve_window(window_id, title)
        for item in self.windows:
            item["active"] = item["id"] == window["id"]
        self._record("focus_window", window=window["title"])
        return window

    def active_window(self):
        for window in self.windows:
            if window["active"]:
                return dict(window)
        return None

    def window_at(self, x, y):
        for window in self.windows:
            bounds = window["bounds"]
            if (
                bounds["x"] <= x < bounds["x"] + bounds["width"]
                and bounds["y"] <= y < bounds["y"] + bounds["height"]
            ):
                return dict(window)
        return None

    # -- perception --------------------------------------------------------
    def capture_screenshot(self, path, region=None, max_width=None):
        x0, y0, width, height = self.screen
        if region:
            rx, ry, rw, rh = (int(value) for value in region)
            if rw <= 0 or rh <= 0:
                raise BackendError("screenshot region must have a positive size")
            x0, y0, width, height = rx, ry, rw, rh
        step = 1
        if max_width and width > int(max_width):
            step = max(1, -(-width // int(max_width)))
        buffer = bytearray(width * height * 4)
        for row in range(height):
            screen_y = y0 + row
            base = row * width * 4
            for column in range(width):
                screen_x = x0 + column
                offset = base + column * 4
                blue = (screen_x * 255) // max(1, self.screen[2])
                green = (screen_y * 255) // max(1, self.screen[3])
                buffer[offset] = blue
                buffer[offset + 1] = green
                buffer[offset + 2] = 90
                buffer[offset + 3] = 255
        for window in self.windows:
            bounds = window["bounds"]
            for row in range(max(0, bounds["y"] - y0), min(height, bounds["y"] - y0 + bounds["height"])):
                base = row * width * 4
                for column in range(
                    max(0, bounds["x"] - x0), min(width, bounds["x"] - x0 + bounds["width"])
                ):
                    offset = base + column * 4
                    buffer[offset] = 240
                    buffer[offset + 1] = 240
                    buffer[offset + 2] = 240
                    buffer[offset + 3] = 255
        png = encode_png(width, height, bytes(buffer), width * 4, bottom_up=False, step=step)
        with open(path, "wb") as handle:
            handle.write(png)
        return path

    # -- accessibility -----------------------------------------------------
    def ui_tree(self, window_id=None, max_depth=6, max_elements=200):
        target = str(window_id) if window_id else (self.active_window() or {}).get("id")
        found = []
        for element in self.elements:
            if target and element["window"] != target:
                continue
            if element.get("depth", 0) > int(max_depth):
                continue
            found.append(dict(element))
        return found[: int(max_elements)]

    def find_elements(self, query, window_id=None, limit=20):
        needle = str(query or "").lower()
        found = []
        if not needle:
            return found
        for element in self.elements:
            if window_id and element["window"] != str(window_id):
                continue
            haystack = "%s %s" % (element.get("name", ""), element.get("automationId", ""))
            if needle in haystack.lower():
                found.append(dict(element))
        return found[: int(limit)]

    def click_element(self, query=None, element_id=None, window_id=None):
        matches = self.find_elements(element_id or query, window_id, 1)
        if not matches:
            raise BackendError("no element matches %r" % (query or element_id))
        element = matches[0]
        if element.get("enabled") is False:
            raise BackendError("element %r is disabled" % element.get("name"))
        if element.get("password"):
            self.focused = element["id"]
            self._record("click_element", element=element["name"], via="focus")
            return {"element": element, "action": "focus"}
        if "Invoke" in (element.get("patterns") or []):
            self._record("click_element", element=element["name"], via="invoke")
            return {"element": element, "action": "invoke"}
        self.focused = element["id"]
        rect = element["rect"]
        self.click(rect["x"] + rect["width"] // 2, rect["y"] + rect["height"] // 2)
        return {"element": element, "action": "click"}

    # -- input -------------------------------------------------------------
    def move_mouse(self, x, y, duration_ms=0):
        self.cursor = (int(x), int(y))
        self._record("move_mouse", x=int(x), y=int(y))

    def click(self, x, y, button="left", count=1):
        self.cursor = (int(x), int(y))
        self._record("click", x=int(x), y=int(y), button=button, count=int(count))
        window = self.window_at(int(x), int(y))
        if window:
            for item in self.windows:
                item["active"] = item["id"] == window["id"]

    def drag(self, from_x, from_y, to_x, to_y, button="left", duration_ms=400):
        self._record(
            "drag", **{"from": [int(from_x), int(from_y)], "to": [int(to_x), int(to_y)], "button": button}
        )
        self.cursor = (int(to_x), int(to_y))

    def scroll(self, amount, x=None, y=None):
        if x is not None and y is not None:
            self.cursor = (int(x), int(y))
        self._record("scroll", amount=int(amount), x=x, y=y)

    def type_text(self, text, interval_ms=0):
        self._record("type_text", text=text, length=len(text))
        for element in self.elements:
            if element["id"] == self.focused and "Value" in (element.get("patterns") or []):
                element["value"] = (element.get("value") or "") + text

    def press_keys(self, keys):
        self._record("press_keys", keys=list(keys))

    def clipboard(self, action, text=None):
        if action == "read":
            return self.clipboard_text
        self.clipboard_text = text or ""
        self._record("clipboard", via="write", length=len(self.clipboard_text))
        return ""

    def open_app(self, target):
        self.opened.append(target)
        self._record("open_app", target=target)
        return target


__all__ = ["FakeBackend", "SCREEN", "WINDOWS", "ELEMENTS"]
