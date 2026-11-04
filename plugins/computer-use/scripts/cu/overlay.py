"""Visible control overlay: the cursor ring and the control banner.

The MCP server must never block on drawing, so this module is only the
*controller* side: tools push points into a bounded queue, a background thread
talks to a separate overlay process over a localhost socket, and that process
owns the windows. If the process is missing it is started once, lazily, on the
first controlling action.

The overlay is deliberately independent of the policy and audit paths: it can
only draw, it never sends input, and a failure here can never change the
outcome of a tool call.

Disable it with ``CU_OVERLAY=0`` in the environment or ``"overlay": false``
in the policy file. It is on by default.
"""

import json
import os
import queue
import socket
import subprocess
import sys
import threading
import time

BANNER_TEXT = "谷谷嘎嘎正在控制你的电脑"
ENV_FLAG = "CU_OVERLAY"

#: The banner window is transparent everywhere except what is drawn on it.
KEY_COLOR = "#FF00FF"
KEY_COLORREF = 0x00FF00FF  # COLORREF is 0x00BBGGRR

CURSOR_WINDOW = 176
BANNER_FONT_PX = 16
# Sticky control session: once the first action draws the overlay, the cursor,
# screen frame and banner stay up until the overlay host loses its last client
# (MCP server shutdown / Antigravity exit) or the user disables the overlay.
IDLE_HIDE_SECONDS = 24 * 60 * 60.0

ENDPOINT_NAME = "overlay-endpoint.json"
LOCK_NAME = "overlay.lock"
LOG_NAME = "overlay.log"

_OFF_VALUES = frozenset({"0", "false", "off", "no", "none", "disabled"})
_ON_VALUES = frozenset({"1", "true", "on", "yes", "enabled"})

_SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOST_SCRIPT = os.path.join(_SCRIPTS, "overlay_host.py")


def overlay_supported(platform=None):
    """The host is a Win32 layered-window program, so this is Windows-only."""
    platform = sys.platform if platform is None else platform
    return platform.startswith("win")


def tkinter_available():
    """tkinter is stdlib on the official Windows installer; check, don't guess."""
    try:
        import importlib.util

        return importlib.util.find_spec("tkinter") is not None
    except (ImportError, ValueError):
        return False


def overlay_available(platform=None):
    """Can this interpreter show the overlay at all?"""
    return overlay_supported(platform) and tkinter_available()


def overlay_enabled(policy=None, env=None):
    """Decide whether the overlay is on.

    An explicit ``CU_OVERLAY`` value wins in both directions, which makes it
    usable as a one-off debugging switch. Otherwise the policy field decides,
    defaulting to on so a fresh install gets the indicator without any setup.
    """
    environment = os.environ if env is None else env
    raw = str(environment.get(ENV_FLAG, "") or "").strip().lower()
    if raw in _OFF_VALUES:
        return False
    if raw in _ON_VALUES:
        return True
    data = getattr(policy, "data", None)
    if data is None:
        data = policy if isinstance(policy, dict) else {}
    return bool(data.get("overlay", True))


def endpoint_path(data_dir):
    return os.path.join(data_dir, ENDPOINT_NAME)


def log_path(data_dir):
    return os.path.join(data_dir, LOG_NAME)


def encode_event(event):
    """One UTF-8 JSON line; compact so a burst stays cheap."""
    return (
        json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        + b"\n"
    )


def banner_placement(monitor, size, point, gap=10, margin=24):
    """Pick a top-of-monitor banner position that avoids the action point.

    Returns ``(x, y, placement)``. The point is avoided with a ``margin`` of
    slack so the banner never covers what the agent is about to touch, and the
    fallback is deterministic: the candidate farthest away wins.
    """
    mx, my, mw, mh = (int(value) for value in monitor)
    bw, bh = (int(value) for value in size)
    px, py = (int(value) for value in point)
    gap = max(0, int(gap))
    margin = max(0, int(margin))
    mw = max(1, mw)
    mh = max(1, mh)
    bw = max(1, bw)
    bh = max(1, bh)

    highest = my + gap
    candidates = [
        ("top-center", mx + max(0, (mw - bw) // 2), highest),
        ("top-right", mx + max(0, mw - bw - gap), highest),
        ("top-left", mx + gap, highest),
    ]
    rects = []
    for name, x, y in candidates:
        x = min(max(mx, x), mx + max(0, mw - bw))
        y = min(max(my, y), my + max(0, mh - bh))
        rects.append((name, x, y))

    def near(rect):
        x, y = rect[1], rect[2]
        return (
            x - margin <= px <= x + bw + margin
            and y - margin <= py <= y + bh + margin
        )

    for name, x, y in rects:
        if not near((name, x, y)):
            return (x, y, name)

    def distance(rect):
        cx = rect[1] + bw // 2
        cy = rect[2] + bh // 2
        return (cx - px) ** 2 + (cy - py) ** 2

    name, x, y = max(rects, key=distance)
    return (x, y, name)


# --------------------------------------------------------------------------
# Controller side
# --------------------------------------------------------------------------
def _pid_alive(pid):
    """Cheap process liveness probe, without os.kill (which terminates on Windows)."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if os.name != "nt":
        try:
            os.kill(pid, 0)
        except OSError:
            return False
        return True
    import ctypes
    from ctypes import wintypes

    process_query_limited_information = 0x1000
    still_active = 259
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
    if not handle:
        # Access denied still means the process exists.
        return ctypes.get_last_error() == 5
    try:
        code = wintypes.DWORD()
        if kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return code.value == still_active
        return True
    finally:
        kernel32.CloseHandle(handle)


class OverlayBridge:
    """Non-blocking client for the overlay host.

    ``show`` is safe to call from the tool thread: it validates the point,
    drops it into a bounded queue and returns. Connection, spawning and
    retries all happen on the worker thread.
    """

    def __init__(
        self,
        data_dir=None,
        enabled=True,
        spawn=True,
        host_script=None,
        env=None,
        idle_close=0.0,
    ):
        if data_dir is None:
            from .policy import default_data_dir

            data_dir = default_data_dir()
        self.data_dir = data_dir
        self.enabled = bool(enabled)
        self.spawn = bool(spawn)
        self.host_script = host_script or HOST_SCRIPT
        self.env = dict(os.environ if env is None else env)
        self.idle_close = float(idle_close)

        self._queue = queue.Queue(maxsize=64)
        self._stop = threading.Event()
        self._thread = None
        self._guard = threading.Lock()  # protects the socket and the thread
        self._send_guard = threading.Lock()
        self._sock = None
        self._host_pid = 0
        self._token = ""
        self._last_spawn = 0.0
        self._last_activity = 0.0
        self._spawn_failures = 0
        self._closed = False
        self._logged = set()

    # -- public API --------------------------------------------------------
    def show(self, x, y, kind="move", from_point=None):
        if not self.enabled or self._closed:
            return False
        try:
            x = int(x)
            y = int(y)
        except (TypeError, ValueError):
            return False
        event = {"op": "show", "x": x, "y": y, "kind": str(kind or "move")}
        if from_point is not None:
            try:
                event["fx"] = int(from_point[0])
                event["fy"] = int(from_point[1])
            except (TypeError, ValueError, IndexError):
                pass
        return self._enqueue(event)

    def hide(self):
        if not self.enabled or self._closed:
            return False
        return self._enqueue({"op": "hide"})

    def probe(self, path):
        """Ask the host to write a diagnostic snapshot to ``path``."""
        if not self.enabled or self._closed or not path:
            return False
        return self._enqueue({"op": "probe", "path": str(path)})

    def close(self):
        """Tell the host to quit and stop the worker. Idempotent."""
        with self._guard:
            if self._closed:
                return
            self._closed = True
            sock = self._sock
        if sock is not None:
            with self._send_guard:
                try:
                    sock.sendall(encode_event({"op": "quit", "pid": os.getpid()}))
                except (OSError, ValueError):
                    pass
        self._stop.set()
        try:
            self._queue.put_nowait(None)
        except queue.Full:
            pass
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=1.5)

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        self.close()
        return False

    # -- worker ------------------------------------------------------------
    def _enqueue(self, event):
        self._ensure_worker()
        self._last_activity = time.monotonic()
        try:
            self._queue.put_nowait(event)
            return True
        except queue.Full:
            # A burst of stale points is worth less than the newest one.
            try:
                self._queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self._queue.put_nowait(event)
                return True
            except queue.Full:
                return False

    def _ensure_worker(self):
        with self._guard:
            if self._thread is not None:
                return
            self._thread = threading.Thread(
                target=self._worker, name="cu-overlay", daemon=True
            )
            self._thread.start()

    def _worker(self):
        while not self._stop.is_set():
            try:
                item = self._queue.get(timeout=0.5)
            except queue.Empty:
                self._verify()
                continue
            if item is None:
                break
            try:
                self._deliver(item)
            except Exception as exc:  # noqa: BLE001 - drawing never breaks a tool
                self._log_once("deliver:%s" % type(exc).__name__, "overlay delivery failed: %s" % exc)
                self._disconnect()
        self._disconnect()

    def _deliver(self, event):
        for attempt in (0, 1):
            if self._sock is None:
                if not self._connect():
                    return
            try:
                with self._send_guard:
                    sock = self._sock
                    if sock is None:
                        raise OSError("overlay socket closed")
                    sock.sendall(encode_event(event))
                self._last_activity = time.monotonic()
                return
            except (OSError, ValueError):
                self._disconnect()
                if attempt == 0:
                    continue
                return

    def _connect(self):
        endpoint = self._read_endpoint()
        if endpoint and self._try_connect(endpoint):
            return True
        if not self.spawn or not overlay_available():
            return False
        now = time.monotonic()
        if now - self._last_spawn < 1.5 or self._spawn_failures >= 2:
            return False
        self._last_spawn = now
        if not self._spawn_host():
            self._spawn_failures += 1
            return False
        deadline = time.monotonic() + 3.0
        while not self._stop.is_set() and time.monotonic() < deadline:
            endpoint = self._read_endpoint(allow_stale=False)
            if endpoint and self._try_connect(endpoint):
                self._spawn_failures = 0
                return True
            time.sleep(0.06)
        self._spawn_failures += 1
        self._log_once(
            "spawn-failed:%d" % self._spawn_failures,
            "overlay host did not publish an endpoint after being started",
        )
        if self._spawn_failures >= 2:
            self.enabled = False
            self._log_once("disabled", "overlay disabled after repeated host failures")
        return False

    def _read_endpoint(self, allow_stale=True):
        path = endpoint_path(self.data_dir)
        try:
            with open(path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, ValueError):
            return None
        if not isinstance(data, dict):
            return None
        try:
            int(data.get("port"))
        except (TypeError, ValueError):
            return None
        if allow_stale and data.get("pid") and not _pid_alive(data.get("pid")):
            return None
        return data

    def _try_connect(self, endpoint):
        sock = None
        try:
            sock = socket.create_connection(
                ("127.0.0.1", int(endpoint["port"])), timeout=0.35
            )
            sock.settimeout(0.35)
            hello = {
                "op": "hello",
                "token": str(endpoint.get("token") or ""),
                "pid": os.getpid(),
                "client": "computer-use",
            }
            sock.sendall(encode_event(hello))
        except (OSError, ValueError):
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass
            return False
        with self._guard:
            if self._closed:
                sock.close()
                return False
            self._sock = sock
            self._host_pid = int(endpoint.get("pid") or 0)
            self._token = str(endpoint.get("token") or "")
        self._last_activity = time.monotonic()
        return True

    def _spawn_host(self):
        host = self.host_script
        if not os.path.isfile(host):
            self._log_once("missing-host", "overlay host script is missing: %s" % host)
            return False
        if not tkinter_available():
            self._log_once(
                "no-tkinter",
                "tkinter is not available in this interpreter; overlay stays off",
            )
            return False
        command = [
            sys.executable,
            "-X",
            "utf8",
            host,
            "--data-dir",
            os.path.abspath(self.data_dir),
            "--parent-pid",
            str(os.getpid()),
        ]
        kwargs = {
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
            "close_fds": True,
            "cwd": os.path.dirname(host) or None,
            "env": self.env,
        }
        if os.name == "nt":
            # DETACHED_PROCESS: no console window, and the overlay outlives a
            # hard kill of the server only long enough to notice the socket
            # closing (it watches the parent pid as well).
            kwargs["creationflags"] = 0x00000008
        try:
            subprocess.Popen(command, **kwargs)
        except OSError as exc:
            self._log_once("spawn-error", "could not start overlay host: %s" % exc)
            return False
        return True

    def _disconnect(self):
        with self._guard:
            sock = self._sock
            self._sock = None
            pid = self._host_pid
        self._host_pid = 0
        if sock is not None:
            with self._send_guard:
                try:
                    sock.close()
                except OSError:
                    pass

    def _verify(self):
        """Drop a connection to a host that has gone away."""
        with self._guard:
            sock = self._sock
            pid = self._host_pid
            idle = time.monotonic() - (self._last_activity or time.monotonic())
        if sock is None:
            return
        if pid and not _pid_alive(pid):
            self._disconnect()
            return
        if self.idle_close and idle > self.idle_close:
            # Optional opt-out for callers that want the old idle-close
            # behaviour; the default keeps the sticky overlay connected.
            self._disconnect()

    def _log_once(self, key, message):
        if key in self._logged:
            return
        self._logged.add(key)
        try:
            os.makedirs(self.data_dir, exist_ok=True)
            with open(log_path(self.data_dir), "a", encoding="utf-8") as handle:
                handle.write(
                    "%s overlay[%d]: %s\n"
                    % (time.strftime("%Y-%m-%d %H:%M:%S"), os.getpid(), message)
                )
        except OSError:
            pass


__all__ = [
    "BANNER_TEXT",
    "ENV_FLAG",
    "KEY_COLOR",
    "KEY_COLORREF",
    "CURSOR_WINDOW",
    "IDLE_HIDE_SECONDS",
    "endpoint_path",
    "encode_event",
    "banner_placement",
    "overlay_enabled",
    "overlay_supported",
    "overlay_available",
    "tkinter_available",
    "OverlayBridge",
]
