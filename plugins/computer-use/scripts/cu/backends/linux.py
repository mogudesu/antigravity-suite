"""Linux (X11 / Wayland) backend built on standard desktop utilities.

No Python packages are required; each primitive shells out to the tool that
is conventionally present on the platform (xdotool, wmctrl, ImageMagick,
scrot, grim). When a tool is missing the corresponding capability is reported
as unavailable instead of failing at call time.
"""

import os
import shutil
import subprocess
import time

from .base import Backend, BackendError, UnsupportedAction

VK_BUTTONS = {"left": "1", "middle": "2", "right": "3"}


def _which(*names):
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    return None


def _run(args, timeout=15):
    try:
        completed = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise BackendError("failed to run %s: %s" % (args[0], exc))
    if completed.returncode != 0:
        raise BackendError(
            "%s exited with %d: %s"
            % (args[0], completed.returncode, completed.stderr.decode("utf-8", "replace").strip())
        )
    return completed.stdout.decode("utf-8", "replace")


class LinuxBackend(Backend):
    platform = "linux"
    display_name = "Linux desktop"

    def __init__(self):
        self.session = os.environ.get("XDG_SESSION_TYPE", "")
        self.display = os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")
        self.xdotool = _which("xdotool")
        self.wmctrl = _which("wmctrl")
        self.capture_tool = _which("grim", "gnome-screenshot", "scrot", "import")
        self.clipboard_tool = _which("xclip", "xsel", "wl-copy")
        self.paste_tool = _which("xclip", "xsel", "wl-paste")

    def capabilities(self):
        return {
            "platform": self.platform,
            "display": bool(self.display),
            "screenshot": bool(self.display and self.capture_tool),
            "pointer": bool(self.display and self.xdotool),
            "keyboard": bool(self.display and self.xdotool),
            "windows": bool(self.display and (self.wmctrl or self.xdotool)),
            "ui_tree": False,
            "clipboard": bool(self.clipboard_tool),
            "notes": (
                "Accessibility-tree control is only implemented on Windows; "
                "use screenshot plus click coordinates on this platform."
            ),
        }

    def _require(self, tool, what):
        if not self.display:
            raise UnsupportedAction("no graphical session detected (DISPLAY unset); %s unavailable" % what)
        if not tool:
            raise UnsupportedAction(
                "%s is unavailable; install xdotool (and wmctrl) to enable %s" % (what, what)
            )

    def screen_info(self):
        if not self.display:
            raise UnsupportedAction("no graphical session detected (DISPLAY unset)")
        geometry = {"width": 0, "height": 0}
        if self.xdotool:
            out = _run([self.xdotool, "getdisplaygeometry"]).split()
            if len(out) == 2:
                geometry = {"width": int(out[0]), "height": int(out[1])}
        return {
            "width": geometry["width"],
            "height": geometry["height"],
            "scale": 1.0,
            "virtual": geometry,
            "session": self.session or "unknown",
        }

    def list_windows(self):
        self._require(self.wmctrl or self.xdotool, "window enumeration")
        windows = []
        if self.wmctrl:
            for line in _run([self.wmctrl, "-lpG"]).splitlines():
                parts = line.split(None, 7)
                if len(parts) < 8:
                    continue
                handle, desktop, pid, x, y, width, height, title = parts
                if title.strip() == "N/A":
                    title = ""
                windows.append(
                    {
                        "id": handle,
                        "title": title.strip(),
                        "app": title.strip(),
                        "pid": int(pid) if pid.isdigit() else 0,
                        "bounds": {
                            "x": int(x),
                            "y": int(y),
                            "width": int(width),
                            "height": int(height),
                        },
                        "desktop": desktop,
                    }
                )
        return windows

    def resolve_window(self, window_id=None, title=None):
        for window in self.list_windows():
            if window_id and str(window["id"]).lower() == str(window_id).lower():
                return window
            if title and title.lower() in (window["title"] or "").lower():
                return window
        raise BackendError("no window matched %s" % (window_id or title))

    def focus_window(self, window_id=None, title=None):
        window = self.resolve_window(window_id, title)
        if self.wmctrl:
            _run([self.wmctrl, "-i", "-a", window["id"]])
        else:
            _run([self.xdotool, "windowactivate", window["id"]])
        return window

    def capture_screenshot(self, path, region=None, max_width=None):
        tool = self.capture_tool
        name = os.path.basename(tool)
        if name == "grim":
            args = [tool]
            if region:
                args += ["-g", "%d,%d %dx%d" % (region[0], region[1], region[2], region[3])]
            args.append(path)
        elif name == "gnome-screenshot":
            args = [tool, "-f", path]
        elif name == "scrot":
            args = [tool, path]
        else:
            args = [tool, "-window", "root", path]
        _run(args, timeout=30)
        return path

    def move_mouse(self, x, y, duration_ms=0):
        self._require(self.xdotool, "pointer control")
        _run([self.xdotool, "mousemove", "--sync", str(int(x)), str(int(y))])

    def click(self, x, y, button="left", count=1):
        self._require(self.xdotool, "pointer control")
        code = VK_BUTTONS.get(button, "1")
        args = [self.xdotool, "mousemove", str(int(x)), str(int(y)), "click"]
        args += ["--repeat", str(int(count)), code]
        _run(args)

    def drag(self, from_x, from_y, to_x, to_y, button="left", duration_ms=400):
        self._require(self.xdotool, "pointer control")
        code = VK_BUTTONS.get(button, "1")
        _run([self.xdotool, "mousemove", str(int(from_x)), str(int(from_y))])
        _run([self.xdotool, "mousedown", code])
        steps = max(2, int(duration_ms / 20))
        for step in range(1, steps + 1):
            x = int(from_x + (to_x - from_x) * step / steps)
            y = int(from_y + (to_y - from_y) * step / steps)
            _run([self.xdotool, "mousemove", str(x), str(y)])
            time.sleep(0.02)
        _run([self.xdotool, "mouseup", code])

    def scroll(self, amount, x=None, y=None):
        self._require(self.xdotool, "pointer control")
        if x is not None and y is not None:
            _run([self.xdotool, "mousemove", str(int(x)), str(int(y))])
        button = "4" if amount > 0 else "5"
        for _ in range(max(1, abs(int(amount)))):
            _run([self.xdotool, "click", button])

    def type_text(self, text, interval_ms=0):
        self._require(self.xdotool, "keyboard control")
        args = [self.xdotool, "type", "--clearmodifiers", "--delay", str(int(interval_ms))]
        args.append(text)
        _run(args, timeout=60)

    def press_keys(self, keys):
        self._require(self.xdotool, "keyboard control")
        combo = "+".join(keys)
        _run([self.xdotool, "key", "--clearmodifiers", combo])

    def clipboard(self, action, text=None):
        if action == "read":
            if not self.paste_tool:
                raise UnsupportedAction("no clipboard tool found (install xclip)")
            name = os.path.basename(self.paste_tool)
            args = [self.paste_tool, "-o"] if name.startswith("x") else [self.paste_tool]
            return _run(args)
        if not self.clipboard_tool:
            raise UnsupportedAction("no clipboard tool found (install xclip)")
        name = os.path.basename(self.clipboard_tool)
        args = [self.clipboard_tool, "-i"] if name.startswith("x") else [self.clipboard_tool]
        try:
            subprocess.run(args, input=text.encode("utf-8"), check=True, timeout=15)
        except (OSError, subprocess.SubprocessError) as exc:
            raise BackendError("clipboard write failed: %s" % exc)
        return ""

    def open_app(self, target):
        opener = shutil.which("xdg-open")
        if not opener:
            raise UnsupportedAction("xdg-open is not available")
        subprocess.Popen(
            [opener, target],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return target
