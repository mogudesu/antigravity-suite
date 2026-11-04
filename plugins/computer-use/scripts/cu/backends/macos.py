"""macOS backend built on the tools that ship with the system.

Screen capture uses ``screencapture`` and desktop actions go through
``osascript``/System Events. The controlling process needs Accessibility and
Screen Recording permission; without them macOS raises a permission error
which is surfaced verbatim so the user knows what to grant.
"""

import os
import shutil
import subprocess

from .base import Backend, BackendError, UnsupportedAction

KEY_CODES = {
    "enter": 36,
    "return": 36,
    "tab": 48,
    "space": 49,
    "delete": 51,
    "backspace": 51,
    "esc": 53,
    "escape": 53,
    "left": 123,
    "right": 124,
    "down": 125,
    "up": 126,
}

MODIFIERS = {"ctrl": "control down", "control": "control down", "alt": "option down", "option": "option down",
             "shift": "shift down", "win": "command down", "cmd": "command down", "command": "command down"}


def _run(args, timeout=30, text=None):
    try:
        completed = subprocess.run(
            args,
            input=text.encode("utf-8") if text is not None else None,
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


def _osascript(script):
    return _run(["/usr/bin/osascript", "-e", script])


class MacBackend(Backend):
    platform = "macos"
    display_name = "macOS"

    def __init__(self):
        self.capture = shutil.which("screencapture")
        self.osascript = shutil.which("osascript")

    def capabilities(self):
        return {
            "platform": self.platform,
            "display": bool(self.capture),
            "screenshot": bool(self.capture),
            "pointer": bool(self.osascript),
            "keyboard": bool(self.osascript),
            "windows": bool(self.osascript),
            "ui_tree": False,
            "clipboard": bool(shutil.which("pbcopy")),
            "notes": (
                "Requires Accessibility (System Settings > Privacy & Security) and Screen "
                "Recording permission for the process that launches Antigravity. "
                "Accessibility-tree control is only implemented on Windows."
            ),
        }

    def screen_info(self):
        out = _osascript(
            'tell application "Finder" to get bounds of window of desktop'
        ).strip()
        parts = [int(float(p)) for p in out.split(",")] if out else [0, 0, 0, 0]
        width = parts[2] if len(parts) == 4 else 0
        height = parts[3] if len(parts) == 4 else 0
        return {"width": width, "height": height, "scale": 1.0, "virtual": {"width": width, "height": height}}

    def list_windows(self):
        script = (
            'tell application "System Events"\n'
            "set out to {}\n"
            "repeat with p in (every process whose background only is false)\n"
            "repeat with w in (every window of p)\n"
            'set end of out to (name of p) & "\\t" & (name of w)\n'
            "end repeat\n"
            "end repeat\n"
            "return out\n"
            "end tell"
        )
        raw = _osascript(script)
        windows = []
        for index, line in enumerate(raw.split(", ")):
            if not line.strip():
                continue
            app, _, title = line.partition("\t")
            windows.append(
                {"id": "win-%d" % index, "title": title.strip(), "app": app.strip(), "bounds": None}
            )
        return windows

    def resolve_window(self, window_id=None, title=None):
        for window in self.list_windows():
            if window_id and str(window["id"]) == str(window_id):
                return window
            if title and title.lower() in (window["title"] or "").lower():
                return window
        raise BackendError("no window matched %s" % (window_id or title))

    def focus_window(self, window_id=None, title=None):
        window = self.resolve_window(window_id, title)
        _osascript('tell application "%s" to activate' % window["app"])
        return window

    def capture_screenshot(self, path, region=None, max_width=None):
        args = [self.capture, "-x"]
        if region:
            args += ["-R", "%d,%d,%d,%d" % (region[0], region[1], region[2], region[3])]
        args.append(path)
        _run(args, timeout=30)
        return path

    def _click_script(self, x, y, count):
        return (
            'tell application "System Events" to click at {%d, %d}' % (int(x), int(y))
        )

    def move_mouse(self, x, y, duration_ms=0):
        raise UnsupportedAction(
            "macOS has no cursor-move primitive without native bindings; use click with coordinates instead"
        )

    def click(self, x, y, button="left", count=1):
        for _ in range(max(1, int(count))):
            _osascript(self._click_script(x, y, count))

    def drag(self, from_x, from_y, to_x, to_y, button="left", duration_ms=400):
        raise UnsupportedAction("drag is not implemented on macOS; use click plus keystrokes")

    def scroll(self, amount, x=None, y=None):
        direction = "down" if amount > 0 else "up"
        script = (
            'tell application "System Events" to scroll %s by %d'
            % (direction, abs(int(amount)))
        )
        _osascript(script)

    def type_text(self, text, interval_ms=0):
        escaped = text.replace("\\", "\\\\").replace('"', '\\"')
        _osascript('tell application "System Events" to keystroke "%s"' % escaped)

    def press_keys(self, keys):
        mods = [MODIFIERS[k] for k in keys[:-1] if k in MODIFIERS]
        key = keys[-1]
        using = (" using {%s}" % ", ".join(mods)) if mods else ""
        if key in KEY_CODES:
            _osascript("tell application \"System Events\" to key code %d%s" % (KEY_CODES[key], using))
        else:
            _osascript('tell application "System Events" to keystroke "%s"%s' % (key, using))

    def clipboard(self, action, text=None):
        if action == "read":
            return _run(["/usr/bin/pbpaste"])
        _run(["/usr/bin/pbcopy"], text=text or "")
        return ""

    def open_app(self, target):
        subprocess.Popen(
            ["/usr/bin/open", target],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return target
