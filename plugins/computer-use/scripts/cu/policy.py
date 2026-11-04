"""Safety policy for desktop control.

Every action passes through this module before it reaches the operating
system: read-only / guarded / open modes, app and key-combo deny lists,
password-field protection, a rate limit, dry-run rehearsal and an
append-only audit trail.
"""

import datetime
import json
import os
import re
import threading
import time

KNOWN_TOOLS = (
    "get_environment",
    "list_windows",
    "focus_window",
    "screenshot",
    "ui_tree",
    "find_elements",
    "click_element",
    "click",
    "move_mouse",
    "drag",
    "scroll",
    "type_text",
    "press_keys",
    "clipboard",
    "open_app",
)

READ_ONLY_TOOLS = frozenset(
    {"get_environment", "list_windows", "screenshot", "ui_tree", "find_elements"}
)

MODES = ("readonly", "guarded", "open")

DEFAULT_POLICY = {
    "mode": "guarded",
    "dryRun": False,
    "allowApps": [],
    "denyApps": [
        "keepass",
        "1password",
        "bitwarden",
        "lastpass",
        "dashlane",
        "credential",
        "logonui",
        "winlogon",
    ],
    "denyKeyCombos": ["ctrl+alt+delete", "win+l", "ctrl+shift+esc"],
    "denyWindowTitles": [],
    "protectPasswordFields": True,
    "maxActionsPerMinute": 120,
    "confirmTools": [],
    "audit": True,
    # Show the persistent control cursor, screen frame and
    # "谷谷嘎嘎正在控制你的电脑" banner for the whole control session.
    # Presentation only: it never gates an action. CU_OVERLAY=0 also disables it.
    "overlay": True,
}

_ALIASES = {
    "control": "ctrl",
    "ctl": "ctrl",
    "return": "enter",
    "escape": "esc",
    "del": "delete",
    "meta": "win",
    "cmd": "win",
    "super": "win",
    "option": "alt",
    "windows": "win",
    "pgup": "pageup",
    "pgdn": "pagedown",
}


def normalize_combo(keys):
    """Normalize ``["Ctrl", "Shift", "s"]`` or ``"ctrl+shift+s"`` to a combo."""
    if isinstance(keys, str):
        parts = re.split(r"\s*\+\s*", keys.strip())
    elif isinstance(keys, (list, tuple)):
        parts = []
        for item in keys:
            parts.extend(re.split(r"\s*\+\s*", str(item).strip()))
    else:
        parts = [str(keys)]
    out = []
    for part in parts:
        part = part.strip().lower()
        if not part:
            continue
        out.append(_ALIASES.get(part, part))
    return out


def combo_string(keys):
    return "+".join(normalize_combo(keys))


_REGEX_HINT = set("^$*?[](){}|\\")


def _looks_like_regex(pattern):
    return any(char in _REGEX_HINT for char in pattern) or ".*" in pattern


def _matches_any(value, patterns):
    """Case-insensitive match against plain substrings or explicit regexes.

    Plain text (``win+l``, ``1password``) is matched as a substring so that
    regular-expression metacharacters inside ordinary names cannot silently
    change the meaning of a policy entry.
    """
    if not value:
        return False
    lowered = str(value).lower()
    for pattern in patterns or []:
        pattern = str(pattern).lower()
        if not pattern:
            continue
        if _looks_like_regex(pattern):
            try:
                if re.search(pattern, lowered):
                    return True
                continue
            except re.error:
                pass
        if pattern in lowered:
            return True
    return False


def default_data_dir():
    override = os.environ.get("CU_DATA_DIR")
    if override:
        return override
    base = os.environ.get("PLUGIN_DATA")
    if base:
        return base
    home = os.path.expanduser("~")
    if os.name == "nt":
        root = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
        return os.path.join(root, "computer-use")
    return os.path.join(home, ".local", "share", "computer-use")


def redact(text, keep=6):
    """Keep a short, non-identifying fingerprint of typed text for the audit log."""
    if text is None:
        return None
    text = str(text)
    if len(text) <= keep * 2:
        return "\u2022" * len(text)
    return "%s\u2026%s" % (text[:keep], text[-keep:])


class Policy:
    def __init__(self, data=None, path=None, data_dir=None, load=True):
        self.path = path
        self.data_dir = data_dir or default_data_dir()
        self._lock = threading.Lock()
        self._actions = []
        self._explicit = dict(data or {})
        self._signature = None
        self.data = dict(DEFAULT_POLICY)
        self.data.update(self._explicit)
        if load and path and os.path.isfile(path):
            self.reload()

    # -- loading -----------------------------------------------------------
    @classmethod
    def from_env(cls):
        # CU_POLICY_PATH is the Antigravity manifest name; CU_POLICY_FILE is
        # the historical name kept for existing installations and the tests.
        path = os.environ.get("CU_POLICY_PATH") or os.environ.get("CU_POLICY_FILE")
        if not path:
            path = os.path.join(default_data_dir(), "policy.json")
        return cls(path=path)

    def reload(self):
        """Reload the policy file. Returns False if it could not be used.

        A file that cannot be read or parsed must never leave stale rules in
        place: a policy that was just tightened would silently keep the looser
        previous version. The built-in defaults are restored instead, which is
        the same state a fresh process would start from.
        """
        failed = False
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                loaded = json.load(handle)
        except (OSError, ValueError):
            failed = True
        else:
            failed = not isinstance(loaded, dict)
        if failed:
            restored = dict(DEFAULT_POLICY)
            restored.update(self._explicit)
            with self._lock:
                self.data = restored
                self._signature = self._file_signature()
            return False
        merged = dict(DEFAULT_POLICY)
        merged.update(loaded)
        with self._lock:
            self.data = merged
            self._signature = self._file_signature()
        return True

    def _file_signature(self):
        """Cheap fingerprint of the policy file, or None when there is none."""
        if not self.path:
            return None
        try:
            info = os.stat(self.path)
        except OSError:
            return None
        return (info.st_mtime_ns, info.st_size)

    def refresh(self):
        """Reload if the policy file changed on disk. Returns True if reloaded.

        Editing the policy mid-session must not require restarting the agent, and
        the direction that matters is *tightening*: silently keeping a looser
        rule after the file was made stricter is the failure mode worth paying
        one stat() per call for. A file that has just been written non-atomically
        is treated like any other unreadable file and falls back to the built-in
        defaults, which are guarded.
        """
        signature = self._file_signature()
        if signature is None:
            return False
        with self._lock:
            if signature == self._signature:
                return False
        return self.reload()

    def ensure_file(self):
        """Materialize the default policy so users have something to edit."""
        if self.path and not os.path.isfile(self.path):
            try:
                os.makedirs(os.path.dirname(self.path), exist_ok=True)
                with open(self.path, "w", encoding="utf-8") as handle:
                    json.dump(DEFAULT_POLICY, handle, indent=2, ensure_ascii=False)
                    handle.write("\n")
                return True
            except OSError:
                return False
        return False

    # -- evaluation --------------------------------------------------------
    def evaluate(self, tool, args=None, context=None):
        """Return ``{"allowed": bool, "reason": str, "mode": str, "dryRun": bool}``."""
        args = args or {}
        context = context or {}
        self.refresh()
        with self._lock:
            data = dict(self.data)
        mode = data.get("mode", "guarded")
        if mode not in MODES:
            mode = "guarded"
        reason = ""

        if mode == "readonly" and tool not in READ_ONLY_TOOLS:
            reason = "policy mode 'readonly' only permits inspection tools"
        elif mode == "open":
            reason = ""

        if not reason and tool == "press_keys":
            combo = combo_string(args.get("keys"))
            if _matches_any(combo, data.get("denyKeyCombos")):
                reason = "key combination '%s' is blocked by the policy deny list" % combo

        app = context.get("app") or args.get("app") or ""
        title = context.get("window_title") or ""
        if not reason and _matches_any(app, data.get("denyApps")):
            reason = "application '%s' is on the policy deny list" % app
        if not reason and _matches_any(title, data.get("denyWindowTitles")):
            reason = "window title matches the policy deny list"
        allow_apps = data.get("allowApps") or []
        if not reason and allow_apps and app:
            if not _matches_any(app, allow_apps):
                reason = (
                    "application '%s' is not in allowApps; add it to %s to permit control"
                    % (app, self.path or "the policy file")
                )
        if not reason and tool == "type_text" and context.get("password_field"):
            if data.get("protectPasswordFields", True):
                reason = "target field is a password field; typing into it is blocked"

        if not reason:
            # The limit exists to slow down actuation, not inspection: reading a
            # window or a screenshot has no side effects, and an agent that is
            # inspecting a UI carefully must not be throttled out of clicking.
            limit = data.get("maxActionsPerMinute")
            if isinstance(limit, int) and limit > 0 and tool not in READ_ONLY_TOOLS:
                now = time.time()
                with self._lock:
                    self._actions = [t for t in self._actions if now - t < 60.0]
                    if len(self._actions) >= limit:
                        reason = "rate limit reached (%d actions/minute)" % limit
                    else:
                        self._actions.append(now)

        return {
            "allowed": not reason,
            "reason": reason,
            "mode": mode,
            "dryRun": bool(data.get("dryRun")),
        }

    # -- audit -------------------------------------------------------------
    def audit(self, entry):
        with self._lock:
            enabled = bool(self.data.get("audit", True))
        if not enabled:
            return None
        record = {"ts": datetime.datetime.now().astimezone().isoformat(timespec="seconds")}
        record.update(entry)
        path = os.path.join(self.data_dir, "audit-%s.jsonl" % datetime.date.today().isoformat())
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError:
            return None
        return path
