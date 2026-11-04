"""The visible control overlay: text, placement, IPC and tool hooks.

No test in this module opens a window or touches the desktop. The host is
exercised through a fake TCP peer that speaks the same JSONL protocol, and the
tool hooks are asserted with a recording double, so the suite stays safe on a
developer machine and in CI.
"""

import json
import os
import socket
import threading
import time

from .helpers import MCPClient, Suite, temp_dir

from cu.backends.fake import FakeBackend
from cu.overlay import (
    BANNER_TEXT,
    IDLE_HIDE_SECONDS,
    OverlayBridge,
    banner_placement,
    encode_event,
    endpoint_path,
    overlay_available,
    overlay_enabled,
    overlay_supported,
    tkinter_available,
)
from cu.policy import DEFAULT_POLICY, Policy
from cu.tools import Toolset

EXPECTED_BANNER = "谷谷嘎嘎正在控制你的电脑"


class RecordingOverlay:
    def __init__(self, explode=False):
        self.events = []
        self.explode = explode
        self.hides = 0
        self.closed = 0

    def show(self, x, y, kind="move", from_point=None):
        if self.explode:
            raise RuntimeError("overlay exploded")
        self.events.append(
            {"x": x, "y": y, "kind": kind, "from": from_point}
        )

    def hide(self):
        self.hides += 1

    def close(self):
        self.closed += 1


class FakeHost(threading.Thread):
    """A minimal overlay host: accepts one client and records its lines."""

    def __init__(self, data_dir, token="test-token"):
        super().__init__(daemon=True)
        self.data_dir = data_dir
        self.token = token
        self.events = []
        self._stop = threading.Event()
        self._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._socket.bind(("127.0.0.1", 0))
        self._socket.listen(4)
        self.port = self._socket.getsockname()[1]
        self._write_endpoint()

    def _write_endpoint(self):
        path = endpoint_path(self.data_dir)
        temporary = path + ".tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    # pid 0 means "no liveness check": the fake host is this
                    # process and the Win32 shim used by other test modules
                    # must not be able to change the outcome.
                    "pid": 0,
                    "port": self.port,
                    "token": self.token,
                    "banner": BANNER_TEXT,
                },
                handle,
            )
        os.replace(temporary, path)

    def wait_for(self, predicate, timeout=5.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if predicate(self.events):
                return True
            time.sleep(0.02)
        return False

    def run(self):
        self._socket.settimeout(0.2)
        while not self._stop.is_set():
            try:
                connection, _ = self._socket.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            connection.settimeout(0.3)
            buffer = b""
            try:
                while not self._stop.is_set():
                    try:
                        chunk = connection.recv(8192)
                    except socket.timeout:
                        continue
                    except OSError:
                        break
                    if not chunk:
                        break
                    buffer += chunk
                    while b"\n" in buffer:
                        raw, buffer = buffer.split(b"\n", 1)
                        raw = raw.strip()
                        if not raw:
                            continue
                        try:
                            self.events.append(json.loads(raw.decode("utf-8")))
                        except ValueError:
                            self.events.append({"malformed": raw.decode("utf-8", "replace")})
            finally:
                try:
                    connection.close()
                except OSError:
                    pass
        try:
            self._socket.close()
        except OSError:
            pass

    def close(self):
        self._stop.set()
        try:
            self._socket.close()
        except OSError:
            pass
        self.join(timeout=2)


def build_toolset(data=None, overlay=None, backend=None):
    work = temp_dir()
    settings = {"mode": "guarded"}
    settings.update(data or {})
    backend = backend if backend is not None else FakeBackend()
    policy = Policy(data=settings, data_dir=work)
    return Toolset(backend, policy, overlay=overlay), backend, policy, work


def run():
    suite = Suite("overlay")

    # --- the exact banner -------------------------------------------------
    suite.equal("the banner text is exact", BANNER_TEXT, EXPECTED_BANNER)
    suite.equal("the banner has twelve characters", len(BANNER_TEXT), 12)
    suite.check("the banner has no quotes", '"' not in BANNER_TEXT and "'" not in BANNER_TEXT)
    suite.check("the banner has no surrounding whitespace",
                BANNER_TEXT == BANNER_TEXT.strip() and "\n" not in BANNER_TEXT)
    suite.check("the overlay is sticky for a control session", IDLE_HIDE_SECONDS >= 3600,
                IDLE_HIDE_SECONDS)
    probe_bridge = OverlayBridge(spawn=False)
    suite.equal("the bridge keeps the sticky overlay connected by default",
                probe_bridge.idle_close, 0.0)
    probe_bridge.close()

    # --- enable / disable -------------------------------------------------
    suite.check("the overlay is on by default", overlay_enabled(None, {}))
    suite.check("the policy defaults to overlay on", DEFAULT_POLICY.get("overlay") is True)
    for value in ("0", "false", "off", "no", "disabled", " FALSE "):
        suite.check("CU_OVERLAY=%r disables it" % value,
                    not overlay_enabled({"overlay": True}, {"CU_OVERLAY": value}))
    for value in ("1", "true", "on", "yes"):
        suite.check("CU_OVERLAY=%r keeps it on" % value,
                    overlay_enabled({"overlay": False}, {"CU_OVERLAY": value}))
    suite.check("an empty CU_OVERLAY falls back to the policy",
                overlay_enabled({"overlay": True}, {"CU_OVERLAY": ""}))
    suite.check("a policy field can disable it",
                not overlay_enabled({"overlay": False}, {}))
    suite.check("the env can override a disabled policy",
                overlay_enabled({"overlay": False}, {"CU_OVERLAY": "1"}))
    suite.check("the env can override an enabled policy",
                not overlay_enabled({"overlay": True}, {"CU_OVERLAY": "0"}))
    suite.check("availability combines the platform and tkinter",
                overlay_available() == (overlay_supported() and tkinter_available()))

    # --- server wiring ----------------------------------------------------
    class DesktopBackend(FakeBackend):
        def capabilities(self):
            caps = super().capabilities()
            caps["virtual"] = False
            return caps

    import mcp_server

    work = temp_dir()
    policy = Policy(data={"overlay": True}, data_dir=work)
    suite.check("the virtual desktop gets no overlay",
                mcp_server._build_overlay(FakeBackend(), policy) is None)
    suite.check("a policy field still applies on a real backend",
                mcp_server._build_overlay(
                    DesktopBackend(), Policy(data={"overlay": False}, data_dir=work)
                ) is None)
    if overlay_available():
        bridge = mcp_server._build_overlay(DesktopBackend(), policy)
        suite.check("a real backend gets an enabled overlay bridge",
                    bridge is not None and bridge.enabled is True)
        if bridge is not None:
            bridge.close()

    # --- wire format ------------------------------------------------------
    line = encode_event({"op": "show", "x": 10, "y": 20, "kind": "click"})
    suite.check("an event is one newline-terminated line",
                line.endswith(b"\n") and line.count(b"\n") == 1, line)
    suite.equal("an event round trips",
                json.loads(line.decode("utf-8")),
                {"op": "show", "x": 10, "y": 20, "kind": "click"})
    decode_me = encode_event({"op": "show", "kind": "click", "label": BANNER_TEXT})
    suite.check("the wire format is utf-8 with real Chinese bytes",
                BANNER_TEXT.encode("utf-8") in decode_me and b"\\u8c37" not in decode_me)

    # --- banner placement -------------------------------------------------
    monitor = (0, 0, 3840, 2160)
    size = (218, 42)
    x, y, where = banner_placement(monitor, size, (1280, 300))
    suite.equal("the banner is top-centre away from the action", (x, y, where), (1811, 10, "top-center"))
    x, y, where = banner_placement(monitor, size, (1920, 20))
    suite.equal("a top-centre action pushes the banner right", (x, y, where), (3612, 10, "top-right"))
    x, y, where = banner_placement(monitor, size, (3700, 20))
    suite.check("a top-right action leaves the banner centred and clear",
                where == "top-center" and not (x <= 3700 <= x + 218), (x, y, where))
    x, y, where = banner_placement((0, 0, 800, 600), (400, 40), (610, 20))
    suite.equal("overlapping candidates fall through to the left",
                (x, y, where), (10, 10, "top-left"))
    x, y, where = banner_placement(monitor, size, (10, 20))
    suite.equal("a top-left action leaves the banner centred", (x, y, where), (1811, 10, "top-center"))
    x, y, where = banner_placement((-1920, 0, 1920, 1080), (200, 40), (-960, 500))
    suite.equal("a monitor left of the primary keeps negative coordinates",
                (x, y, where), (-1060, 10, "top-center"))
    x, y, where = banner_placement((0, 0, 1920, 1080), (200, 40), (960, 500))
    suite.check("the banner stays inside the monitor",
                0 <= x <= 1920 - 200 and 0 <= y <= 1080 - 40, (x, y))
    x, y, where = banner_placement((0, 0, 600, 400), (900, 60), (300, 10))
    suite.check("an oversized banner is still placed deterministically",
                where in ("top-center", "top-right", "top-left") and 0 <= x <= 600 and 0 <= y <= 400,
                (x, y, where))

    # --- IPC to a (fake) host --------------------------------------------
    work = temp_dir()
    host = FakeHost(work)
    host.start()
    bridge = OverlayBridge(data_dir=work, enabled=True, spawn=False)
    suite.check("show succeeds with a live endpoint", bridge.show(321, 432, "click", from_point=(100, 110)))
    suite.check("the fake host received hello and show",
                host.wait_for(lambda events: len(events) >= 2), host.events)
    suite.equal("hello carries the token", host.events[0].get("token"), "test-token")
    suite.equal("hello identifies the client", host.events[0].get("op"), "hello")
    show_event = host.events[1]
    suite.equal("the show event carries the point", (show_event.get("x"), show_event.get("y")), (321, 432))
    suite.equal("the show event carries the kind", show_event.get("kind"), "click")
    suite.equal("the show event carries the drag origin",
                (show_event.get("fx"), show_event.get("fy")), (100, 110))
    probe_path = os.path.join(work, "probe.json")
    suite.check("probe is accepted", bridge.probe(probe_path))
    suite.check("the fake host received the probe",
                host.wait_for(lambda events: any(e.get("op") == "probe" for e in events)), host.events)
    bridge.close()
    suite.check("close sends quit",
                host.wait_for(lambda events: any(e.get("op") == "quit" for e in events)), host.events)
    host.close()

    # --- a bridge with no host and no spawn never blocks ------------------
    work = temp_dir()
    bridge = OverlayBridge(data_dir=work, enabled=True, spawn=False)
    started = time.monotonic()
    for index in range(500):
        bridge.show(index, index, "move")
    elapsed = time.monotonic() - started
    suite.check("500 queued points return immediately", elapsed < 0.5, "%.3fs" % elapsed)
    bridge.close()

    # --- tool hooks -------------------------------------------------------
    overlay = RecordingOverlay()
    tools, backend, policy, work = build_toolset(overlay=overlay)
    result = tools.call("click", {"x": 700, "y": 660})
    suite.check("click succeeds", not result["isError"], result["text"])
    suite.equal("click draws the ring at the click point",
                overlay.events[-1], {"x": 700, "y": 660, "kind": "click", "from": None})
    suite.equal("inspection draws nothing", len(overlay.events), 1)
    for name, args in (
        ("screenshot", {"x": 0, "y": 0, "width": 32, "height": 32}),
        ("ui_tree", {}),
        ("list_windows", {}),
        ("find_elements", {"query": "Save"}),
    ):
        tools.call(name, args)
    suite.equal("read-only tools never move the ring", len(overlay.events), 1)

    tools.call("click_element", {"query": "Save"})
    suite.equal("element activation draws at the element centre",
                overlay.events[-1], {"x": 755, "y": 675, "kind": "element", "from": None})
    tools.call("click_element", {"query": "Text Editor"})
    suite.equal("the coordinate fallback draws at the same centre",
                overlay.events[-1], {"x": 530, "y": 372, "kind": "element", "from": None})
    tools.call("type_text", {"text": "hello"})
    suite.equal("typing reuses the last known point",
                overlay.events[-1], {"x": 530, "y": 372, "kind": "type", "from": None})
    tools.call("press_keys", {"keys": "ctrl+s"})
    suite.equal("shortcuts reuse the last known point",
                overlay.events[-1], {"x": 530, "y": 372, "kind": "keys", "from": None})
    tools.call("drag", {"from_x": 10, "from_y": 20, "to_x": 300, "to_y": 400})
    suite.equal("drag draws the drop point and remembers the origin",
                overlay.events[-1], {"x": 300, "y": 400, "kind": "drag", "from": (10, 20)})
    tools.call("scroll", {"amount": 2, "x": 100, "y": 200})
    suite.equal("scroll uses explicit coordinates",
                overlay.events[-1], {"x": 100, "y": 200, "kind": "scroll", "from": None})
    tools.call("move_mouse", {"x": 50, "y": 60})
    suite.equal("move_mouse draws at the pointer",
                overlay.events[-1], {"x": 50, "y": 60, "kind": "move", "from": None})
    tools.call("scroll", {"amount": -1})
    suite.equal("scroll without coordinates reuses the last point",
                overlay.events[-1], {"x": 50, "y": 60, "kind": "scroll", "from": None})

    # a first action with no known point falls back to the active window
    overlay = RecordingOverlay()
    tools, backend, policy, work = build_toolset(overlay=overlay)
    tools.call("press_keys", {"keys": "esc"})
    suite.equal("a first shortcut draws at the focused window centre",
                overlay.events[-1], {"x": 530, "y": 400, "kind": "keys", "from": None})
    overlay2 = RecordingOverlay()
    tools, backend, policy, work = build_toolset(overlay=overlay2)
    tools.call("scroll", {"amount": 1})
    suite.equal("a first scroll also falls back to the focused window",
                overlay2.events[-1]["x"], 530)

    # --- denials and dry runs draw nothing --------------------------------
    overlay = RecordingOverlay()
    tools, backend, policy, work = build_toolset({"mode": "readonly"}, overlay)
    suite.check("readonly refuses the click", tools.call("click", {"x": 1, "y": 1})["isError"])
    suite.equal("a policy refusal draws nothing", overlay.events, [])

    overlay = RecordingOverlay()
    tools, backend, policy, work = build_toolset({"dryRun": True}, overlay)
    rehearsal = tools.call("click", {"x": 1, "y": 1})
    suite.check("dry run is not an error", not rehearsal["isError"])
    suite.equal("a dry run draws nothing", overlay.events, [])
    tools.call("press_keys", {"keys": ["win", "l"]})
    suite.equal("a refused key combo draws nothing", overlay.events, [])

    class FailingBackend(FakeBackend):
        def click(self, x, y, button="left", count=1):
            from cu.backends.base import BackendError

            raise BackendError("boom")

    overlay = RecordingOverlay()
    tools, backend, policy, work = build_toolset(overlay=overlay, backend=FailingBackend())
    suite.check("a backend failure is still reported", tools.call("click", {"x": 5, "y": 5})["isError"])
    suite.equal("a failed action draws nothing", overlay.events, [])

    overlay = RecordingOverlay(explode=True)
    tools, backend, policy, work = build_toolset(overlay=overlay)
    suite.check("a broken overlay cannot break a click",
                not tools.call("click", {"x": 42, "y": 24})["isError"])
    suite.check("the click still reached the backend",
                backend.actions[-1]["action"] == "click", backend.actions[-1])

    # --- the environment report exposes the toggle ------------------------
    tools, backend, policy, work = build_toolset(overlay=RecordingOverlay())
    payload = json.loads(tools.call("get_environment", {})["text"])
    suite.check("get_environment reports the overlay toggle",
                payload.get("policy", {}).get("overlay") is True, payload.get("policy"))

    # --- the virtual desktop never opens a real overlay -------------------
    fake_dir = temp_dir()
    client = MCPClient(env={"CU_BACKEND": "fake", "CU_DATA_DIR": fake_dir, "CU_OVERLAY": "1"})
    try:
        client.initialize()
        response = client.call("click", {"x": 300, "y": 300})
        suite.check("the virtual desktop click succeeds", not client.is_error(response),
                    client.text(response)[:120])
        time.sleep(0.6)
        suite.check("the virtual desktop publishes no overlay endpoint",
                    not os.path.isfile(endpoint_path(fake_dir)),
                    os.listdir(fake_dir))
        suite.check("the virtual desktop starts no overlay process",
                    not os.path.isfile(os.path.join(fake_dir, "overlay.log")),
                    os.listdir(fake_dir))
    finally:
        client.close()

    return suite.finish()
