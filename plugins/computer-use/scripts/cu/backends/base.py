"""Platform backend interface.

A backend exposes desktop primitives. Anything a given platform cannot do
raises :class:`UnsupportedAction` with a message that tells the agent what to
do instead, rather than failing silently.
"""

import os
import time

from ..imaging import png_size


class BackendError(Exception):
    """A platform call failed at runtime."""


class UnsupportedAction(BackendError):
    """The current platform cannot perform this action."""


class Backend:
    platform = "unknown"
    display_name = "Unknown"

    # -- introspection -----------------------------------------------------
    def capabilities(self):
        return {
            "platform": self.platform,
            "display": False,
            "screenshot": False,
            "pointer": False,
            "keyboard": False,
            "windows": False,
            "ui_tree": False,
            "clipboard": False,
            "notes": "",
        }

    def screen_info(self):
        raise UnsupportedAction("screen inspection is not supported on %s" % self.platform)

    def focused_element(self):
        return None

    # -- windows -----------------------------------------------------------
    def list_windows(self):
        raise UnsupportedAction("window enumeration is not supported on %s" % self.platform)

    def resolve_window(self, window_id=None, title=None):
        raise UnsupportedAction("window lookup is not supported on %s" % self.platform)

    def focus_window(self, window_id=None, title=None):
        raise UnsupportedAction("window activation is not supported on %s" % self.platform)

    # -- perception --------------------------------------------------------
    def capture_screenshot(self, path, region=None, max_width=None):
        """Write a PNG of ``region`` (or the whole screen) to ``path``."""
        raise UnsupportedAction("screen capture is not supported on %s" % self.platform)

    def screenshot(self, window_id=None, region=None, max_width=None):
        """Capture the screen, a window or a region and return the PNG bytes.

        Shared by every backend so the tool layer sees one contract:
        ``{"png", "path", "width", "height", "region"}``.
        """
        if not self.capabilities().get("screenshot"):
            raise UnsupportedAction(
                "screen capture is unavailable on this system (%s)" % self.platform
            )
        if window_id:
            window = self.resolve_window(window_id)
            bounds = window.get("bounds") or {}
            if bounds:
                region = (
                    bounds.get("x", 0),
                    bounds.get("y", 0),
                    bounds.get("width", 0),
                    bounds.get("height", 0),
                )
        path = self._shot_path()
        self.capture_screenshot(path, region, max_width)
        try:
            with open(path, "rb") as handle:
                data = handle.read()
        except OSError as exc:
            raise BackendError("captured file could not be read: %s" % exc)
        width, height = png_size(data)
        return {
            "png": data,
            "path": path,
            "width": width,
            "height": height,
            "region": region,
        }

    def _shot_path(self):
        from ..policy import default_data_dir

        directory = os.path.join(default_data_dir(), "screenshots")
        os.makedirs(directory, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        return os.path.join(directory, "shot-%s-%d.png" % (stamp, os.getpid()))

    def ui_tree(self, window_id=None, max_depth=6, max_elements=200):
        raise UnsupportedAction("accessibility tree is not supported on %s" % self.platform)

    def find_elements(self, query, window_id=None, limit=20):
        raise UnsupportedAction("element search is not supported on %s" % self.platform)

    # -- action ------------------------------------------------------------
    def move_mouse(self, x, y, duration_ms=0):
        raise UnsupportedAction("pointer control is not supported on %s" % self.platform)

    def click(self, x, y, button="left", count=1):
        raise UnsupportedAction("pointer control is not supported on %s" % self.platform)

    def drag(self, from_x, from_y, to_x, to_y, button="left", duration_ms=400):
        raise UnsupportedAction("pointer control is not supported on %s" % self.platform)

    def scroll(self, amount, x=None, y=None):
        raise UnsupportedAction("pointer control is not supported on %s" % self.platform)

    def type_text(self, text, interval_ms=0):
        raise UnsupportedAction("keyboard control is not supported on %s" % self.platform)

    def press_keys(self, keys):
        raise UnsupportedAction("keyboard control is not supported on %s" % self.platform)

    def click_element(self, query=None, element_id=None, window_id=None):
        raise UnsupportedAction("element activation is not supported on %s" % self.platform)

    def clipboard(self, action, text=None):
        raise UnsupportedAction("clipboard access is not supported on %s" % self.platform)

    def open_app(self, target):
        raise UnsupportedAction("launching applications is not supported on %s" % self.platform)
