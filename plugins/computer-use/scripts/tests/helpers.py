"""Shared test scaffolding: assertions, temp dirs, an MCP client and a Win32 shim."""

import ctypes
import json
import os
import queue
import threading
import subprocess
import sys
import tempfile

SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)


class Suite:
    """A tiny assertion collector so the output stays readable."""

    def __init__(self, name):
        self.name = name
        self.passed = 0
        self.failures = []

    def check(self, name, condition, detail=""):
        if condition:
            self.passed += 1
        else:
            self.failures.append((name, detail))
            print("  FAIL  %s%s" % (name, ("  <- " + str(detail)) if detail else ""))
        return bool(condition)

    def equal(self, name, actual, expected):
        return self.check(name, actual == expected, "got %r, expected %r" % (actual, expected))

    def raises(self, name, exception, function, *args, **kwargs):
        try:
            function(*args, **kwargs)
        except exception as caught:
            self.passed += 1
            return caught
        except Exception as other:  # noqa: BLE001 - the point is to report it
            self.failures.append((name, "wrong exception %r" % (other,)))
            print("  FAIL  %s  wrong exception %r" % (name, other))
            return None
        self.failures.append((name, "did not raise"))
        print("  FAIL  %s  did not raise" % name)
        return None

    def finish(self):
        total = self.passed + len(self.failures)
        print("  %-22s %d/%d passed" % (self.name, self.passed, total))
        return self.passed, len(self.failures)


def temp_dir(prefix="cu-test-"):
    return tempfile.mkdtemp(prefix=prefix)


# --------------------------------------------------------------------------
# MCP client over stdio
# --------------------------------------------------------------------------
class MCPClient:
    def __init__(self, server=os.path.join(SCRIPTS, "mcp_server.py"), env=None, cwd=None):
        environment = dict(os.environ)
        environment["PYTHONIOENCODING"] = "utf-8"
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        environment.update(env or {})
        self.proc = subprocess.Popen(
            [sys.executable, server],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=cwd or SCRIPTS,
            env=environment,
            text=True,
            encoding="utf-8",
        )
        self.next_id = 1
        self._lines = queue.Queue()
        self._reader = threading.Thread(target=self._pump)
        self._reader.daemon = True
        self._reader.start()

    def send(self, method, params=None):
        message = {"jsonrpc": "2.0", "id": self.next_id, "method": method}
        if params is not None:
            message["params"] = params
        self.next_id += 1
        return self._exchange(message)

    def notify(self, method, params=None):
        message = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def read_line(self, timeout=30.0):
        """Read one reply, failing loudly instead of hanging the suite.

        A reader thread pumps stdout into a queue. Polling the pipe with
        ``select`` is not enough: ``readline`` pulls a whole OS chunk into the
        text wrapper's own buffer, so a second reply that arrived in the same
        chunk leaves the file descriptor empty and ``select`` would report a
        timeout while the reply is sitting in memory.
        """
        try:
            line = self._lines.get(timeout=timeout)
        except queue.Empty:
            raise RuntimeError("no reply within %.0fs" % timeout)
        if line is None:
            raise RuntimeError("server closed the stream: %s" % self.proc.stderr.read()[:500])
        return line

    def _pump(self):
        try:
            for line in self.proc.stdout:
                self._lines.put(line)
        except (OSError, ValueError):  # pragma: no cover - the pipe went away
            pass
        finally:
            self._lines.put(None)

    def write_raw(self, text):
        self.proc.stdin.write(text + "\n")
        self.proc.stdin.flush()

    def send_raw(self, text):
        self.write_raw(text)
        line = self.read_line()
        return json.loads(line) if line.strip() else None

    def _exchange(self, message):
        self.write_raw(json.dumps(message))
        return json.loads(self.read_line())

    def initialize(self, version="2025-06-18"):
        result = self.send(
            "initialize",
            {"protocolVersion": version, "capabilities": {}, "clientInfo": {"name": "tests", "version": "1"}},
        )
        self.notify("notifications/initialized")
        return result

    def call(self, name, arguments=None):
        return self.send("tools/call", {"name": name, "arguments": arguments or {}})

    def text(self, response):
        return "\n".join(
            item.get("text", "")
            for item in response.get("result", {}).get("content", [])
            if item.get("type") == "text"
        )

    def images(self, response):
        return [
            item
            for item in response.get("result", {}).get("content", [])
            if item.get("type") == "image"
        ]

    def is_error(self, response):
        return bool(response.get("result", {}).get("isError"))

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()


# --------------------------------------------------------------------------
# Win32 shim: makes cu.backends.windows importable off Windows and records
# every call, so the event sequences it produces can be asserted.
# --------------------------------------------------------------------------
class _FakeFunction:
    def __init__(self, name, recorder):
        self.name = name
        self.argtypes = None
        self.restype = None
        self._recorder = recorder

    def __call__(self, *args):
        return self._recorder.dispatch(self.name, args)


class _FakeDLL:
    def __init__(self, name, recorder):
        self.name = name
        self._recorder = recorder
        self._functions = {}

    def __getattr__(self, item):
        if item.startswith("__"):
            raise AttributeError(item)
        if item not in self._functions:
            self._functions[item] = _FakeFunction(item, self._recorder)
        return self._functions[item]


class Win32Recorder:
    """Answers the Win32 calls the Windows backend makes, and records them.

    ``dpi`` selects which DPI-awareness path succeeds: "per-monitor-v2",
    "per-monitor", "system" or "none".
    """

    def __init__(self, title="Untitled - Notepad", app=r"C:\Windows\System32\notepad.exe",
                 metrics=None, dpi="per-monitor-v2", cursor=(640, 480)):
        self.title = title
        self.app = app
        self.metrics = metrics or {76: 0, 77: 0, 78: 1920, 79: 1080}
        self.dpi = dpi
        self.cursor = cursor
        self.calls = []
        self.batches = []
        self.hwnd = 1234567
        self.overrides = {}
        self.clipboard_handle = 0
        self._clipboard_memory = None

    def count(self, name):
        return len([call for call in self.calls if call[0] == name])

    def args_of(self, name):
        return [call[1] for call in self.calls if call[0] == name]

    def dispatch(self, name, args):
        self.calls.append((name, args))
        if name in self.overrides:
            return self.overrides[name]
        handler = getattr(self, "_" + name, None)
        if handler is not None:
            return handler(args)
        return 1

    # a clipboard backed by real memory, so the utf-16 payload is exercised
    def _GlobalAlloc(self, args):
        self._clipboard_memory = ctypes.create_string_buffer(max(1, int(args[1])))
        return ctypes.addressof(self._clipboard_memory)

    def _GlobalLock(self, args):
        return int(args[0])

    def _GetClipboardData(self, args):
        return self.clipboard_handle

    def _SetClipboardData(self, args):
        self.clipboard_handle = args[1]
        return 1

    def seed_clipboard(self, text):
        """Put text on the fake clipboard in a form c_wchar_p can read back.

        c_wchar_p is UTF-16 on Windows and UCS-4 elsewhere, so a UTF-16 buffer
        can only be read back on Windows; this uses the platform's own wide
        character width.
        """
        self._clipboard_memory = ctypes.create_unicode_buffer(text)
        self.clipboard_handle = ctypes.addressof(self._clipboard_memory)
        return self.clipboard_handle

    def _OpenClipboard(self, args):
        return 1

    def _CloseClipboard(self, args):
        return 1

    def _EmptyClipboard(self, args):
        self.clipboard_handle = 0
        return 1

    # individual API behaviours
    def _GetSystemMetrics(self, args):
        return self.metrics.get(args[0], 0)

    def _SendInput(self, args):
        self.batches.append(args[1])
        return args[0]

    def _GetCursorPos(self, args):
        args[0]._obj.x, args[0]._obj.y = self.cursor
        return 1

    def _WindowFromPoint(self, args):
        return self.hwnd

    def _GetAncestor(self, args):
        return self.hwnd

    def _GetWindowTextLengthW(self, args):
        return len(self.title)

    def _GetWindowTextW(self, args):
        args[1].value = self.title
        return len(self.title)

    def _GetWindowThreadProcessId(self, args):
        args[1]._obj.value = 4242
        return 1

    def _GetWindowRect(self, args):
        rect = args[1]._obj
        rect.left, rect.top, rect.right, rect.bottom = 120, 90, 940, 710
        return 1

    def _IsWindowVisible(self, args):
        return 1

    def _IsIconic(self, args):
        return 0

    def _GetForegroundWindow(self, args):
        return self.hwnd

    def _EnumWindows(self, args):
        callback = args[0]
        callback(self.hwnd, 0)
        return 1

    def _OpenProcess(self, args):
        return 99

    def _QueryFullProcessImageNameW(self, args):
        args[2].value = self.app
        args[3]._obj.value = len(self.app)
        return 1

    def _CloseHandle(self, args):
        return 1

    def _SetProcessDpiAwarenessContext(self, args):
        if self.dpi != "per-monitor-v2":
            raise AttributeError("SetProcessDpiAwarenessContext")
        return 1

    def _SetProcessDPIAware(self, args):
        return 1 if self.dpi == "system" else 0

    def _GetDpiForSystem(self, args):
        return 144

    def batches_named(self):
        return [list(batch) for batch in self.batches]


def load_windows_module(recorder):
    """Import cu.backends.windows against a stubbed Win32 layer."""
    for name in [n for n in sys.modules if n.startswith("cu.backends.windows")]:
        del sys.modules[name]

    ctypes.WinDLL = lambda name, **kwargs: _FakeDLL(name, recorder)
    ctypes.WINFUNCTYPE = ctypes.CFUNCTYPE
    ctypes.get_last_error = lambda: 87

    class _Shcore:
        @staticmethod
        def SetProcessDpiAwareness(value):
            return 0 if recorder.dpi == "per-monitor" else 1

    # The shim stays installed: the backend resolves shcore lazily, so
    # restoring the real ctypes.WinDLL here would hide the fallback paths.
    ctypes.WinDLL = lambda name, **kwargs: (
        _Shcore() if name == "shcore" else _FakeDLL(name, recorder)
    )
    import cu.backends.windows as module
    return module
