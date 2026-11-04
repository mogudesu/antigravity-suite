"""The tool catalogue exposed to the agent.

Tool descriptions are written for the model: they say when to reach for a
tool and what to try first, mirroring the ordering Codex uses for its own
computer use (prefer an existing MCP server or shell command, then a
browser tool, and only then synthesised input).

Every call is wrapped by :class:`Toolset.call`, which applies the safety
policy and writes the audit trail before the operating system is touched.
"""

import base64
import hashlib
import json

from .backends.base import BackendError, UnsupportedAction
from .policy import READ_ONLY_TOOLS, combo_string, normalize_combo, redact

DEFAULT_MAX_WIDTH = 1920

# Actions that can change the desktop. Clipboard and mouse-move are excluded:
# they are observable side effects but do not alter the visual state the
# watchdog hashes, so repeated calls are not evidence of being stuck.
GUARDED_MUTATIONS = frozenset(
    {"focus_window", "click_element", "click", "drag", "scroll", "type_text", "press_keys", "open_app"}
)


def _ok(text, images=None):
    return {"text": text, "images": images or [], "isError": False}


def _err(message):
    return {"text": "Error: %s" % message, "images": [], "isError": True}


def _require(args, key):
    value = args.get(key)
    if value is None or value == "":
        raise BackendError("missing required argument: %s" % key)
    return value


def _number(args, key, default=None):
    value = args.get(key, default)
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        raise BackendError("argument %s must be a number" % key)


def _integer(args, key, default=None):
    value = _number(args, key, default)
    return None if value is None else int(value)


def _required_int(args, key):
    """An integer argument that must be present.

    Without this, a missing coordinate reaches the backend as None and the
    resulting TypeError escapes the tool boundary instead of being reported
    as a normal tool error.
    """
    return int(_number(args, key, _require(args, key)))


def _format_windows(windows, limit=40):
    if not windows:
        return "No visible top-level windows were found."
    lines = []
    for window in windows[:limit]:
        bounds = window.get("bounds") or {}
        flags = []
        if window.get("active"):
            flags.append("ACTIVE")
        if window.get("minimized"):
            flags.append("minimized")
        lines.append(
            "id=%s app=%s%s title=%r bounds=(%s,%s %sx%s)"
            % (
                window.get("id"),
                window.get("app") or "?",
                (" [" + ",".join(flags) + "]") if flags else "",
                window.get("title") or "",
                bounds.get("x"),
                bounds.get("y"),
                bounds.get("width"),
                bounds.get("height"),
            )
        )
    if len(windows) > limit:
        lines.append("... %d more windows" % (len(windows) - limit))
    return "\n".join(lines)


def _format_elements(elements, limit=60):
    if not elements:
        return "No matching elements."
    lines = []
    for index, element in enumerate(elements[:limit]):
        rect = element.get("rect") or {}
        parts = [
            "[%d]" % index,
            element.get("controlType") or "?",
            "name=%r" % (element.get("name") or ""),
        ]
        if element.get("automationId"):
            parts.append("id=%r" % element["automationId"])
        parts.append(
            "rect=(%s,%s %sx%s)" % (rect.get("x"), rect.get("y"), rect.get("width"), rect.get("height"))
        )
        if element.get("password"):
            parts.append("password=true")
        elif element.get("value"):
            parts.append("value=%r" % element["value"])
        if element.get("offscreen"):
            parts.append("offscreen")
        if element.get("enabled") is False:
            parts.append("disabled")
        if element.get("patterns"):
            parts.append("patterns=[%s]" % ",".join(element["patterns"]))
        lines.append(" ".join(parts))
    if len(elements) > limit:
        lines.append("... %d more elements" % (len(elements) - limit))
    return "\n".join(lines)


def _format_tree(elements, limit=200):
    if not elements:
        return "The accessibility tree is empty for this window."
    lines = []
    for element in elements[:limit]:
        rect = element.get("rect") or {}
        indent = "  " * int(element.get("depth") or 0)
        parts = [
            indent + (element.get("controlType") or "?"),
            "name=%r" % (element.get("name") or ""),
        ]
        if element.get("automationId"):
            parts.append("id=%r" % element["automationId"])
        parts.append(
            "rect=(%s,%s %sx%s)" % (rect.get("x"), rect.get("y"), rect.get("width"), rect.get("height"))
        )
        if element.get("password"):
            parts.append("password=true")
        elif element.get("value"):
            parts.append("value=%r" % element["value"])
        if element.get("patterns"):
            parts.append("patterns=[%s]" % ",".join(element["patterns"]))
        lines.append(" ".join(parts))
    return "\n".join(lines)


class Toolset:
    def __init__(self, backend, policy, max_width=DEFAULT_MAX_WIDTH, overlay=None):
        self.backend = backend
        self.policy = policy
        self.max_width = max_width
        # A visible control cursor + banner. It is optional on purpose: the
        # overlay is a presentation aid, never part of the action's contract,
        # so tools keep working (and tests keep running headless) without one.
        self.overlay = overlay
        self._last_point = None
        self._last_action = None
        self.tools = {}
        self._build()

    # -- public API --------------------------------------------------------
    def list_tools(self):
        return [
            {
                "name": tool["name"],
                "description": tool["description"],
                "inputSchema": tool["inputSchema"],
            }
            for tool in self.tools.values()
        ]

    def call(self, name, args):
        tool = self.tools.get(name)
        if tool is None:
            return _err("unknown tool '%s'" % name)
        try:
            context = self._context_for(name, args)
        except Exception:  # noqa: BLE001
            # Resolving the target window must never take a tool call down: a
            # malformed argument is reported by the handler with a clear
            # message, and the policy falls back to its own checks.
            context = {}

        decision = self.policy.evaluate(name, args, context)
        audit = {
            "tool": name,
            "args": self._audit_args(name, args),
            "mode": decision["mode"],
            "app": context.get("app") or "",
        }
        if not decision["allowed"]:
            audit["decision"] = "deny"
            audit["reason"] = decision["reason"]
            self.policy.audit(audit)
            return _err("blocked by policy: %s" % decision["reason"])

        if decision["dryRun"] and name not in READ_ONLY_TOOLS:
            audit["decision"] = "dry_run"
            self.policy.audit(audit)
            return _ok(
                "[dry-run] %s would have been executed with %s. "
                "Set \"dryRun\": false in the policy file to run it for real."
                % (name, json.dumps(args, ensure_ascii=False))
            )

        guard_key, guard_state, guard_repeat, guard_message = self._no_progress_decision(name, args)
        if guard_message:
            audit["decision"] = "circuit_break"
            audit["reason"] = "same action repeated with unchanged desktop state"
            audit["repeat"] = guard_repeat + 1
            self.policy.audit(audit)
            return _err(guard_message)
        if guard_key and guard_state:
            # Record before execution so a handler that throws repeatedly is
            # also counted as no progress on the next identical call.
            self._last_action = {"key": guard_key, "state": guard_state, "noProgress": guard_repeat}

        try:
            result = tool["handler"](args)
        except UnsupportedAction as exc:
            audit["decision"] = "unsupported"
            audit["error"] = str(exc)
            self.policy.audit(audit)
            return _err(str(exc))
        except BackendError as exc:
            audit["decision"] = "error"
            audit["error"] = str(exc)
            self.policy.audit(audit)
            return _err(str(exc))
        except Exception as exc:  # noqa: BLE001 - the tool boundary must answer
            # An unexpected failure is reported like any other tool error so
            # the agent can adapt, rather than escaping as a protocol fault.
            audit["decision"] = "error"
            audit["error"] = "%s: %s" % (type(exc).__name__, exc)
            self.policy.audit(audit)
            return _err("unexpected %s: %s" % (type(exc).__name__, exc))
        audit["decision"] = "allow"
        audit["ok"] = True
        self.policy.audit(audit)
        return result

    # -- internals ---------------------------------------------------------
    def _action_key(self, name, args):
        try:
            payload = json.dumps(args, sort_keys=True, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            payload = repr(args)
        return name + ":" + hashlib.sha1(payload.encode("utf-8")).hexdigest()

    def _state_fingerprint(self):
        """Cheap visual+window signature; None disables the watchdog."""
        try:
            if getattr(self.backend, "platform", "") == "windows":
                shot = self.backend.screenshot(None, None, 120)
                core = hashlib.sha1(shot["png"]).hexdigest()
            else:
                tree = self.backend.ui_tree(max_depth=3, max_elements=80)
                core = hashlib.sha1(
                    json.dumps(tree, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
                ).hexdigest()
            try:
                windows = self.backend.list_windows()
            except (BackendError, UnsupportedAction):
                windows = []
            try:
                focus = self.backend.focused_element()
            except (BackendError, UnsupportedAction):
                focus = None
            blob = json.dumps([core, windows, focus], sort_keys=True, ensure_ascii=False, default=str)
            return hashlib.sha1(blob.encode("utf-8")).hexdigest()
        except (BackendError, UnsupportedAction, OSError, ValueError):
            return None

    def _no_progress_decision(self, name, args):
        """Return (key, state, repeat_count, blocked_message)."""
        if name not in GUARDED_MUTATIONS:
            return None, None, 0, None
        state = self._state_fingerprint()
        if not state:
            return None, None, 0, None
        key = self._action_key(name, args)
        repeat = 0
        previous = self._last_action
        if previous and previous["key"] == key and previous["state"] == state:
            repeat = previous["noProgress"] + 1
        if repeat >= 2:
            return key, state, repeat, (
                "circuit breaker: %s has run repeatedly while the desktop state stayed unchanged. "
                "A dialog, UIPI/permission boundary or a stale coordinate is probably blocking it. "
                "Stop repeating, inspect with screenshot or ui_tree, and ask the user before proceeding."
                % name
            )
        return key, state, repeat, None

    def _overlay_show(self, x, y, kind, from_point=None):
        """Tell the overlay where something just happened.

        Called only after the backend actually performed the action, so a
        dry-run rehearsal or a policy refusal never draws anything. The point
        is remembered even without an overlay: typing and shortcut keys are
        drawn at the last place the agent touched.
        """
        try:
            x = int(x)
            y = int(y)
        except (TypeError, ValueError):
            return
        self._last_point = (x, y)
        if self.overlay is None:
            return
        try:
            self.overlay.show(x, y, kind, from_point=from_point)
        except Exception:  # noqa: BLE001 - drawing must never fail a tool call
            pass

    def _overlay_focus_point(self):
        """Where to draw typing and shortcut keys: last point, else focus."""
        if self._last_point is not None:
            return self._last_point
        try:
            window = self.backend.active_window()
        except Exception:  # noqa: BLE001
            window = None
        bounds = (window or {}).get("bounds") or {}
        try:
            width = int(bounds.get("width") or 0)
            height = int(bounds.get("height") or 0)
            if width > 0 and height > 0:
                return (
                    int(bounds.get("x") or 0) + width // 2,
                    int(bounds.get("y") or 0) + height // 2,
                )
        except (TypeError, ValueError):
            pass
        try:
            point = self.backend.cursor_position()
            if point:
                return (int(point[0]), int(point[1]))
        except Exception:  # noqa: BLE001
            pass
        try:
            info = self.backend.screen_info()
            area = info.get("virtual") or {}
            return (
                int(area.get("x") or 0) + int(info.get("width") or 0) // 2,
                int(area.get("y") or 0) + int(info.get("height") or 0) // 2,
            )
        except Exception:  # noqa: BLE001
            return (0, 0)

    def _audit_args(self, name, args):
        safe = dict(args or {})
        if name == "type_text" and "text" in safe:
            safe["text"] = redact(safe["text"])
        if name == "clipboard" and "text" in safe:
            safe["text"] = redact(safe["text"])
        return safe

    def _context_for(self, name, args):
        context = {}
        window = None
        try:
            if args.get("window_id") or (name == "focus_window" and args.get("title")):
                window = self.backend.resolve_window(args.get("window_id"), args.get("title"))
        except BackendError:
            window = None
        if window is None and hasattr(self.backend, "window_at"):
            if name in ("click", "drag", "scroll", "move_mouse"):
                point = None
                if args.get("x") is not None and args.get("y") is not None:
                    point = (args["x"], args["y"])
                elif args.get("from_x") is not None:
                    point = (args["from_x"], args["from_y"])
                if point is not None:
                    try:
                        window = self.backend.window_at(point[0], point[1])
                    except BackendError:
                        window = None
        if window:
            context["app"] = window.get("app") or ""
            context["window_title"] = window.get("title") or ""
        if name == "open_app":
            context["app"] = str(args.get("target") or "")
        if name == "type_text" and self.policy.data.get("protectPasswordFields", True):
            try:
                focused = self.backend.focused_element()
            except (BackendError, UnsupportedAction):
                focused = None
            if focused and focused.get("password"):
                context["password_field"] = True
                context["app"] = context.get("app") or ""
        return context

    # -- tool definitions --------------------------------------------------
    def _register(self, name, description, properties, required, handler):
        self.tools[name] = {
            "name": name,
            "description": description,
            "inputSchema": {
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": False,
            },
            "handler": handler,
        }

    def _build(self):
        caps = self.backend.capabilities()
        ui_note = (
            "Accessibility tree available."
            if caps.get("ui_tree")
            else "Accessibility tree is NOT available on this system: fall back to screenshot + coordinates."
        )

        self._register(
            "get_environment",
            "Report the desktop environment: operating system, screen geometry, DPI "
            "scaling, the active window, which capabilities are available, and the active "
            "safety policy. Call this first before any other computer-use tool, and again "
            "after the user changes monitors or the policy file. " + ui_note,
            {},
            [],
            self._tool_environment,
        )
        self._register(
            "list_windows",
            "List visible top-level windows with their id, owning process, title and bounds. "
            "Use it to find the window you need, then pass its id to screenshot, ui_tree or "
            "focus_window. Cheaper and more reliable than reading a screenshot.",
            {},
            [],
            self._tool_list_windows,
        )
        self._register(
            "focus_window",
            "Bring a window to the foreground by id or by a case-insensitive title substring. "
            "Do this before sending keystrokes so they land in the right application.",
            {
                "window_id": {"type": "string", "description": "Window id from list_windows."},
                "title": {"type": "string", "description": "Title substring, used when no id is given."},
            },
            [],
            self._tool_focus_window,
        )
        self._register(
            "screenshot",
            "Capture the screen, a whole window, or a rectangle, and return it as an image. "
            "Prefer ui_tree or find_elements when they are available: they give exact element "
            "bounds and text, while a screenshot needs you to estimate coordinates. The reply "
            "states the captured region and, when the image was downscaled, how to convert "
            "image coordinates back to screen coordinates.",
            {
                "window_id": {"type": "string", "description": "Capture only this window."},
                "x": {"type": "integer", "description": "Left edge of the region, in screen coordinates."},
                "y": {"type": "integer", "description": "Top edge of the region, in screen coordinates."},
                "width": {"type": "integer", "description": "Region width in screen pixels."},
                "height": {"type": "integer", "description": "Region height in screen pixels."},
                "max_width": {
                    "type": "integer",
                    "description": "Downscale the image so it is at most this wide (default 1920, which keeps a 1080p screen pixel for pixel).",
                },
            },
            [],
            self._tool_screenshot,
        )
        self._register(
            "ui_tree",
            "Read a window's accessibility tree: control types, names, automation ids, screen "
            "rectangles, available action patterns and current values. This is the most precise "
            "way to understand a window, and it is far cheaper than a screenshot for finding "
            "what to click. " + ui_note,
            {
                "window_id": {"type": "string", "description": "Defaults to the foreground window."},
                "max_depth": {"type": "integer", "description": "Tree depth limit, default 6."},
                "max_elements": {"type": "integer", "description": "Element budget, default 200."},
            },
            [],
            self._tool_ui_tree,
        )
        self._register(
            "find_elements",
            "Search a window's accessibility tree for controls whose name or automation id "
            "contains the query. Use it instead of dumping a whole tree when you know roughly "
            "what the control is called (for example 'Save', 'Search', 'Address').",
            {
                "query": {"type": "string", "description": "Case-insensitive substring to look for."},
                "window_id": {"type": "string", "description": "Defaults to the foreground window."},
                "limit": {"type": "integer", "description": "Maximum matches, default 20."},
            },
            ["query"],
            self._tool_find_elements,
        )
        self._register(
            "click_element",
            "Activate a control through the accessibility layer, by name or automation id. "
            "Prefer this over coordinate clicking: it works regardless of window position and "
            "uses the control's own invoke action. If the control exposes no action pattern the "
            "tool falls back to clicking its centre and says so.",
            {
                "query": {"type": "string", "description": "Name or automation id substring."},
                "element_id": {"type": "string", "description": "Alternative to query: exact automation id."},
                "window_id": {"type": "string", "description": "Defaults to the foreground window."},
            },
            [],
            self._tool_click_element,
        )
        self._register(
            "click",
            "Click at absolute screen coordinates. Read the coordinates from ui_tree, "
            "find_elements or a screenshot; never guess them.",
            {
                "x": {"type": "integer", "description": "Screen x coordinate."},
                "y": {"type": "integer", "description": "Screen y coordinate."},
                "button": {"type": "string", "enum": ["left", "right", "middle"], "description": "Default left."},
                "count": {"type": "integer", "description": "Click count; 2 for a double click."},
                "window_id": {
                    "type": "string",
                    "description": "Optional window the click is expected to land in; used for policy checks only.",
                },
            },
            ["x", "y"],
            self._tool_click,
        )
        self._register(
            "move_mouse",
            "Move the pointer without clicking. Use it to trigger hover menus before clicking.",
            {
                "x": {"type": "integer", "description": "Screen x coordinate."},
                "y": {"type": "integer", "description": "Screen y coordinate."},
                "duration_ms": {"type": "integer", "description": "Glide duration; 0 moves instantly."},
            },
            ["x", "y"],
            self._tool_move_mouse,
        )
        self._register(
            "drag",
            "Press the mouse button at one point, move to another and release. Use it for "
            "sliders, scrollbars, drag-and-drop and marquee selection.",
            {
                "from_x": {"type": "integer", "description": "Screen x where the button goes down."},
                "from_y": {"type": "integer", "description": "Screen y where the button goes down."},
                "to_x": {"type": "integer", "description": "Screen x where the button is released."},
                "to_y": {"type": "integer", "description": "Screen y where the button is released."},
                "button": {
                    "type": "string",
                    "enum": ["left", "right", "middle"],
                    "description": "Mouse button to hold, default left.",
                },
                "duration_ms": {"type": "integer", "description": "Drag duration, default 400."},
            },
            ["from_x", "from_y", "to_x", "to_y"],
            self._tool_drag,
        )
        self._register(
            "scroll",
            "Scroll the wheel. Positive values scroll up, negative values scroll down; the "
            "magnitude is the number of wheel notches.",
            {
                "amount": {"type": "integer", "description": "Wheel notches; negative scrolls down."},
                "x": {"type": "integer", "description": "Optional pointer position first."},
                "y": {"type": "integer", "description": "Optional pointer position first."},
            },
            ["amount"],
            self._tool_scroll,
        )
        self._register(
            "type_text",
            "Type text into whatever currently has keyboard focus. Focus the target window and "
            "click the field first. Text is sent as Unicode, so any language works. Typing into "
            "a password field is refused when the policy protects password fields.",
            {
                "text": {"type": "string", "description": "The text to type; \\n presses Enter."},
                "interval_ms": {"type": "integer", "description": "Delay between characters."},
            },
            ["text"],
            self._tool_type_text,
        )
        self._register(
            "press_keys",
            "Press a key or a key combination, for example [\"ctrl\",\"s\"] or \"win+r\". "
            "Some combinations are refused by policy.",
            {
                "keys": {
                    "oneOf": [
                        {"type": "string"},
                        {"type": "array", "items": {"type": "string"}},
                    ],
                    "description": "Key names such as ctrl, alt, shift, win, enter, esc, tab, f5, a.",
                }
            },
            ["keys"],
            self._tool_press_keys,
        )
        self._register(
            "clipboard",
            "Read or replace the clipboard. Useful for moving text between applications "
            "without retyping it.",
            {
                "action": {
                    "type": "string",
                    "enum": ["read", "write"],
                    "description": "read returns the current clipboard text; write replaces it.",
                },
                "text": {"type": "string", "description": "Required when action is write."},
            },
            ["action"],
            self._tool_clipboard,
        )
        self._register(
            "open_app",
            "Open an application, document or URL, as if you had used the Run dialog. Pass an "
            "executable name, an absolute path, or an http(s) URL.",
            {"target": {"type": "string", "description": "Application, path or URL to open."}},
            ["target"],
            self._tool_open_app,
        )

    # -- handlers ----------------------------------------------------------
    def _tool_environment(self, args):
        payload = {"capabilities": self.backend.capabilities()}
        try:
            payload["screen"] = self.backend.screen_info()
        except (BackendError, UnsupportedAction) as exc:
            payload["screen_error"] = str(exc)
        active = None
        if hasattr(self.backend, "active_window"):
            try:
                active = self.backend.active_window()
            except BackendError:
                active = None
        payload["active_window"] = active
        payload["policy"] = {
            "mode": self.policy.data.get("mode"),
            "dryRun": self.policy.data.get("dryRun"),
            "allowApps": self.policy.data.get("allowApps"),
            "denyApps": self.policy.data.get("denyApps"),
            "denyKeyCombos": self.policy.data.get("denyKeyCombos"),
            "protectPasswordFields": self.policy.data.get("protectPasswordFields"),
            "maxActionsPerMinute": self.policy.data.get("maxActionsPerMinute"),
            "overlay": self.policy.data.get("overlay", True),
            "file": self.policy.path,
            "data_dir": self.policy.data_dir,
        }
        return _ok(json.dumps(payload, ensure_ascii=False, indent=2, default=str))

    def _tool_list_windows(self, args):
        windows = self.backend.list_windows()
        return _ok("%d visible window(s):\n%s" % (len(windows), _format_windows(windows)))

    def _tool_focus_window(self, args):
        window = self.backend.focus_window(args.get("window_id"), args.get("title"))
        return _ok("Focused: %s" % json.dumps(window, ensure_ascii=False, default=str))

    def _tool_screenshot(self, args):
        region = None
        if all(args.get(key) is not None for key in ("x", "y", "width", "height")):
            region = (
                _integer(args, "x"),
                _integer(args, "y"),
                _integer(args, "width"),
                _integer(args, "height"),
            )
        elif any(args.get(key) is not None for key in ("x", "y", "width", "height")):
            raise BackendError("provide all of x, y, width and height, or none of them")
        max_width = _integer(args, "max_width", self.max_width)
        shot = self.backend.screenshot(args.get("window_id"), region, max_width)
        captured = shot.get("region")
        width = shot.get("width") or 0
        height = shot.get("height") or 0
        if not captured and width:
            # A whole-screen capture was downscaled: without the mapping the
            # agent would click using image coordinates as screen coordinates.
            try:
                info = self.backend.screen_info()
                area = info.get("virtual") or {}
                captured = (
                    area.get("x", 0),
                    area.get("y", 0),
                    info.get("width"),
                    info.get("height"),
                )
            except (BackendError, UnsupportedAction, AttributeError):
                captured = None
        if not captured and width:
            # A whole-screen capture was downscaled: without the mapping the
            # agent would click using image coordinates as screen coordinates.
            try:
                info = self.backend.screen_info()
                area = info.get("virtual") or {}
                captured = (
                    area.get("x", 0),
                    area.get("y", 0),
                    info.get("width"),
                    info.get("height"),
                )
            except (BackendError, UnsupportedAction, AttributeError):
                captured = None
        lines = [
            "Captured image %dx%d (PNG, %d bytes)." % (width, height, len(shot["png"])),
            "File: %s" % shot["path"],
        ]
        if captured:
            lines.append(
                "Screen region: x=%d y=%d width=%d height=%d"
                % (captured[0], captured[1], captured[2], captured[3])
            )
            if width and captured[2]:
                factor = captured[2] / float(width)
                if abs(factor - 1.0) > 0.01:
                    lines.append(
                        "Image is downscaled: screen_x = %d + image_x * %.3f, screen_y = %d + image_y * %.3f"
                        % (captured[0], factor, captured[1], factor)
                    )
        lines.append("Coordinates in this image are screen coordinates unless stated otherwise.")
        image = {
            "data": base64.b64encode(shot["png"]).decode("ascii"),
            "mime": "image/png",
        }
        return _ok("\n".join(lines), [image])

    def _tool_ui_tree(self, args):
        elements = self.backend.ui_tree(
            args.get("window_id"),
            _integer(args, "max_depth", 6),
            _integer(args, "max_elements", 200),
        )
        return _ok(
            "%d element(s):\n%s" % (len(elements), _format_tree(elements))
        )

    def _tool_find_elements(self, args):
        elements = self.backend.find_elements(
            _require(args, "query"), args.get("window_id"), _integer(args, "limit", 20)
        )
        return _ok("%d match(es):\n%s" % (len(elements), _format_elements(elements)))

    def _tool_click_element(self, args):
        query = args.get("query")
        element_id = args.get("element_id")
        if not query and not element_id:
            raise BackendError(
                "give either query (a name or automation id substring) or element_id"
            )
        result = self.backend.click_element(query, element_id, args.get("window_id"))
        element = result.get("element") or {}
        # Element activation often never moves the real pointer, so the ring
        # is the only thing that shows the user which control was touched.
        rect = element.get("rect") or {}
        try:
            width = int(rect.get("width") or 0)
            height = int(rect.get("height") or 0)
        except (TypeError, ValueError):
            width = height = 0
        if width > 0 and height > 0:
            self._overlay_show(
                int(rect.get("x") or 0) + width // 2,
                int(rect.get("y") or 0) + height // 2,
                "element",
            )
        else:
            self._overlay_show(*self._overlay_focus_point(), kind="element")
        return _ok(
            "Activated %r via %s (rect=%s)."
            % (element.get("name") or element.get("automationId"), result.get("action"), element.get("rect"))
        )

    def _tool_click(self, args):
        x = _required_int(args, "x")
        y = _required_int(args, "y")
        button = args.get("button") or "left"
        count = _integer(args, "count", 1)
        self.backend.click(x, y, button, count)
        self._overlay_show(x, y, "click")
        return _ok("Clicked %s x%d at (%d, %d)." % (button, count, x, y))

    def _tool_move_mouse(self, args):
        x = _required_int(args, "x")
        y = _required_int(args, "y")
        self.backend.move_mouse(x, y, _integer(args, "duration_ms", 0))
        self._overlay_show(x, y, "move")
        return _ok("Pointer moved to (%d, %d)." % (x, y))

    def _tool_drag(self, args):
        from_x = _required_int(args, "from_x")
        from_y = _required_int(args, "from_y")
        to_x = _required_int(args, "to_x")
        to_y = _required_int(args, "to_y")
        self.backend.drag(
            from_x,
            from_y,
            to_x,
            to_y,
            args.get("button") or "left",
            _integer(args, "duration_ms", 400),
        )
        self._overlay_show(to_x, to_y, "drag", from_point=(from_x, from_y))
        return _ok(
            "Dragged from (%s, %s) to (%s, %s)."
            % (args.get("from_x"), args.get("from_y"), args.get("to_x"), args.get("to_y"))
        )

    def _tool_scroll(self, args):
        amount = _required_int(args, "amount")
        if amount == 0:
            # A zero notch count would otherwise be sent as a downward wheel
            # event, which is the opposite of doing nothing.
            return _ok("Scroll amount was 0: no wheel event was sent.")
        x = _integer(args, "x")
        y = _integer(args, "y")
        self.backend.scroll(amount, x, y)
        point = (x, y) if x is not None and y is not None else self._last_point
        if point is None:
            try:
                point = self.backend.cursor_position()
            except Exception:  # noqa: BLE001 - not every backend can report it
                point = None
        if point is None:
            point = self._overlay_focus_point()
        self._overlay_show(point[0], point[1], "scroll")
        return _ok("Scrolled %d notch(es)." % amount)

    def _tool_type_text(self, args):
        text = _require(args, "text")
        self.backend.type_text(text, _integer(args, "interval_ms", 0))
        self._overlay_show(*self._overlay_focus_point(), kind="type")
        return _ok("Typed %d character(s)." % len(text))

    def _tool_press_keys(self, args):
        raw = _require(args, "keys")
        if not isinstance(raw, (str, list, tuple)):
            raise BackendError(
                "argument keys must be a string like \"ctrl+s\" or a list of key names, got %s"
                % type(raw).__name__
            )
        keys = normalize_combo(raw)
        if not keys:
            raise BackendError("argument keys is empty: give at least one key name")
        self.backend.press_keys(keys)
        self._overlay_show(*self._overlay_focus_point(), kind="keys")
        return _ok("Pressed %s." % combo_string(keys))

    def _tool_clipboard(self, args):
        action = _require(args, "action")
        if action == "read":
            return _ok("Clipboard text:\n%s" % self.backend.clipboard("read"))
        if action != "write":
            raise BackendError("action must be 'read' or 'write'")
        text = _require(args, "text")
        self.backend.clipboard("write", text)
        return _ok("Clipboard replaced with %d character(s)." % len(text))

    def _tool_open_app(self, args):
        target = _require(args, "target")
        self.backend.open_app(target)
        return _ok("Requested the system to open %r." % target)
