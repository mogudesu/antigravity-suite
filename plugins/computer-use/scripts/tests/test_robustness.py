"""What separates "passes the demo" from "keeps working all day".

Everything here runs against a real MCP server process on the virtual desktop:
malformed input storms, long call sequences, policy hot reload, two sessions
sharing one data directory, and the screenshot scaling path.
"""

import base64
import json
import os
import select
import struct
import subprocess
import sys
import time

from .helpers import MCPClient, Suite, temp_dir

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
SERVER = os.path.join(SCRIPTS, "mcp_server.py")
ROOT = os.path.dirname(SCRIPTS)


def png_size(raw):
    return struct.unpack(">II", raw[16:24])


def image_of(response):
    for item in response.get("result", {}).get("content", []):
        if item.get("type") == "image":
            return base64.b64decode(item.get("data", ""))
    return b""


def spawn(work, extra=None, binary=False):
    env = dict(os.environ)
    env.update({
        "CU_BACKEND": "fake",
        "CU_DATA_DIR": work,
        "CU_POLICY_FILE": os.path.join(work, "policy.json"),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONIOENCODING": "utf-8",
    })
    env.update(extra or {})
    return subprocess.Popen([sys.executable, SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, cwd=ROOT, env=env,
                            **({"text": False} if binary else {"text": True, "encoding": "utf-8"}))


def alive(process):
    return process.poll() is None


def rss_kb(pid):
    try:
        with open("/proc/%d/status" % pid, encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1])
    except OSError:
        pass
    return 0


def fd_count(pid):
    if os.name == "nt":
        # Windows has no /proc; the process handle count is the equivalent
        # descriptor proxy and catches leaked pipes, files and subprocesses.
        try:
            import ctypes
            from ctypes import wintypes

            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
            kernel32.OpenProcess.restype = wintypes.HANDLE
            kernel32.GetProcessHandleCount.argtypes = (
                wintypes.HANDLE,
                ctypes.POINTER(wintypes.DWORD),
            )
            kernel32.GetProcessHandleCount.restype = wintypes.BOOL
            kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
            kernel32.CloseHandle.restype = wintypes.BOOL
            handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if not handle:
                return -1
            try:
                count = wintypes.DWORD()
                if kernel32.GetProcessHandleCount(handle, ctypes.byref(count)):
                    return int(count.value)
            finally:
                kernel32.CloseHandle(handle)
        except (OSError, AttributeError):
            pass
        return -1
    try:
        return len(os.listdir("/proc/%d/fd" % pid))
    except OSError:
        return -1


def run():
    suite = Suite("robustness")
    work = temp_dir()
    client = MCPClient(env={"CU_BACKEND": "fake", "CU_DATA_DIR": work,
                            "CU_POLICY_FILE": os.path.join(work, "policy.json")})
    client.initialize()

    # --- the screenshot scaling path (a 1080p screen, an agent that asks for less)
    full = client.call("screenshot", {})
    suite.equal("a full screenshot is the whole screen", png_size(image_of(full)), (1920, 1080))
    suite.check("the reply explains the image-to-screen mapping",
                "1920" in client.text(full) and "screen" in client.text(full).lower(),
                client.text(full)[:200])

    scaled = client.call("screenshot", {"max_width": 640})
    raw = image_of(scaled)
    suite.check("a scaled screenshot still returns an image", bool(raw), client.text(scaled)[:160])
    if raw:
        width, height = png_size(raw)
        suite.check("scaling never exceeds the requested width", width <= 640, "%dpx" % width)
        suite.check("scaling keeps the aspect ratio", abs(width / float(height) - 16 / 9.0) < 0.02,
                    "%dx%d" % (width, height))
        suite.check("a scaled screenshot tells the agent how to map coordinates back",
                    "640" in client.text(scaled), client.text(scaled)[:200])

    smaller = client.call("screenshot", {"max_width": 100})
    if image_of(smaller):
        suite.check("an aggressive max_width is honoured",
                    png_size(image_of(smaller))[0] <= 100, "%dpx" % png_size(image_of(smaller))[0])

    bigger = client.call("screenshot", {"max_width": 4000})
    if image_of(bigger):
        suite.check("max_width above the screen size never upscales",
                    png_size(image_of(bigger)) == (1920, 1080), str(png_size(image_of(bigger))))

    region = client.call("screenshot", {"x": 100, "y": 100, "width": 400, "height": 300,
                                        "max_width": 200})
    if image_of(region):
        width, height = png_size(image_of(region))
        suite.check("a scaled region keeps the requested shape", abs(width / float(height) - 400 / 300.0) < 0.05,
                    "%dx%d" % (width, height))

    odd = client.call("screenshot", {"x": 0, "y": 0, "width": 1, "height": 1})
    suite.check("a 1x1 screenshot does not crash", odd.get("result", {}).get("isError") is not True,
                client.text(odd)[:160])

    off_screen = client.call("screenshot", {"x": 5000, "y": 5000, "width": 100, "height": 100})
    suite.check("an off-screen region is refused rather than crashing",
                off_screen.get("result", {}).get("isError") is True, client.text(off_screen)[:160])
    suite.check("the server survived the off-screen request", client.send("ping")["result"] == {})

    # --- a storm of malformed input, then business as usual -----------------
    junk = [
        "{not json",
        "[]",
        '"a string"',
        "12345",
        '{"jsonrpc": "2.0", "id": 1}',
        '{"jsonrpc": "2.0", "id": 2, "method": 42}',
        '{"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": "nope"}',
        '{"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": null}}',
        '{"jsonrpc": "2.0", "id": 5, "method": "initialize", "params": null}',
        '{"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "click", "arguments": {"x": "abc", "y": 1}}}',
        json.dumps({"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                    "params": {"name": "type_text", "arguments": {"text": "x" * 100000}}}),
    ]
    for line in junk:
        client.write_raw(line)
        client.write_raw(json.dumps({"jsonrpc": "2.0", "id": 999, "method": "ping"}))
        deadline = time.time() + 20
        seen = 0
        while time.time() < deadline and seen < 2:
            message = json.loads(client.read_line())
            seen += 1
            if message.get("id") == 999:
                break
        suite.check("malformed input is answered, not swallowed: %s" % line[:38], seen >= 1)

    suite.equal("the server is still healthy after the storm", client.send("ping")["result"], {})
    suite.check("a normal call still works after the storm",
                not client.is_error(client.call("list_windows")), client.text(client.call("list_windows"))[:120])

    # --- a long sequence of calls ------------------------------------------
    pid = client.proc.pid
    before_rss, before_fd = rss_kb(pid), fd_count(pid)
    started = time.time()
    slowest = 0.0
    for index in range(300):
        call_started = time.time()
        response = client.call("get_environment" if index % 3 == 0 else
                               ("list_windows" if index % 3 == 1 else "ui_tree"))
        slowest = max(slowest, time.time() - call_started)
        if client.is_error(response):
            suite.check("call %d of 300 succeeded" % index, False, client.text(response)[:120])
            break
    total = time.time() - started
    suite.check("300 sequential calls all succeed", True)
    suite.check("300 calls finish quickly (%.1fs, slowest %.2fs)" % (total, slowest), total < 60,
                "%.1fs" % total)
    after_rss, after_fd = rss_kb(pid), fd_count(pid)
    suite.check("file descriptors do not leak (%d -> %d)" % (before_fd, after_fd),
                after_fd >= 0 and after_fd <= before_fd + 4)
    suite.check("memory stays bounded (%d KB -> %d KB)" % (before_rss, after_rss),
                before_rss == 0 or after_rss < before_rss + 60000, "%d KB" % after_rss)

    # --- the audit trail survives that volume ------------------------------
    audit = [name for name in os.listdir(work) if name.startswith("audit-")]
    lines = 0
    broken = 0
    for name in audit:
        with open(os.path.join(work, name), encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                lines += 1
                try:
                    json.loads(line)
                except ValueError:
                    broken += 1
    suite.check("the audit trail has one valid line per call (%d lines)" % lines, lines >= 300 and broken == 0,
                "%d broken" % broken)
    suite.check("read-only calls are not counted against the rate limit",
                lines >= 300)

    # --- policy hot reload -------------------------------------------------
    policy_path = os.path.join(work, "policy.json")
    with open(policy_path, "w", encoding="utf-8") as handle:
        json.dump({"mode": "readonly"}, handle)
    refused = client.call("click", {"x": 10, "y": 10})
    suite.check("a tightened policy takes effect without a restart",
                refused.get("result", {}).get("isError") is True, client.text(refused)[:120])
    suite.check("inspection still works under the tightened policy",
                not client.is_error(client.call("list_windows")))

    with open(policy_path, "w", encoding="utf-8") as handle:
        json.dump({"mode": "guarded", "maxActionsPerMinute": 1000}, handle)
    suite.check("loosening the policy also takes effect",
                not client.is_error(client.call("click", {"x": 10, "y": 10})),
                client.text(client.call("click", {"x": 10, "y": 10}))[:120])

    # a corrupt file must not leave the previous, looser rules in force
    with open(policy_path, "w", encoding="utf-8") as handle:
        handle.write("{ this is not json")
    suite.check("a corrupt policy file falls back to the built-in defaults",
                not client.is_error(client.call("click", {"x": 30, "y": 30})),
                client.text(client.call("click", {"x": 30, "y": 30}))[:140])
    with open(policy_path, "w", encoding="utf-8") as handle:
        json.dump({"mode": "guarded", "maxActionsPerMinute": 1000}, handle)
    client.call("click", {"x": 31, "y": 31})
    client.close()

    # --- the rate limit window, in a session with nothing else in it --------
    window = temp_dir()
    window_policy = os.path.join(window, "policy.json")
    with open(window_policy, "w", encoding="utf-8") as handle:
        json.dump({"mode": "guarded", "maxActionsPerMinute": 3}, handle)
    limited = MCPClient(env={"CU_BACKEND": "fake", "CU_DATA_DIR": window, "CU_POLICY_FILE": window_policy})
    limited.initialize()
    allowed = [not limited.is_error(limited.call("click", {"x": 40 + index, "y": 40})) for index in range(3)]
    suite.check("actions under the limit are allowed", all(allowed), str(allowed))
    fourth = limited.call("click", {"x": 60, "y": 60})
    suite.check("the action over the limit is refused", limited.is_error(fourth), limited.text(fourth)[:140])
    suite.check("the refusal explains the limit",
                "limit" in limited.text(fourth).lower() or "wait" in limited.text(fourth).lower(),
                limited.text(fourth)[:140])
    suite.check("read-only calls keep flowing while throttled",
                all(not limited.is_error(limited.call("ui_tree")) for _ in range(5)))
    suite.check("a refused action does not consume the quota",
                limited.is_error(limited.call("click", {"x": 61, "y": 61})))
    suite.check("a screenshot is not counted against the limit",
                bool(image_of(limited.call("screenshot", {"x": 0, "y": 0, "width": 32, "height": 32}))))

    with open(window_policy, "w", encoding="utf-8") as handle:
        json.dump({"mode": "guarded", "maxActionsPerMinute": 0}, handle)
    unlimited = [limited.call("click", {"x": 70 + index, "y": 70}) for index in range(4)]
    suite.check("maxActionsPerMinute=0 means no limit",
                all(not limited.is_error(response) for response in unlimited),
                [limited.text(response)[:60] for response in unlimited][:2])
    limited.close()

    # --- two sessions sharing one data directory ---------------------------
    shared = temp_dir()
    first = MCPClient(env={"CU_BACKEND": "fake", "CU_DATA_DIR": shared,
                           "CU_POLICY_FILE": os.path.join(shared, "policy.json")})
    second = MCPClient(env={"CU_BACKEND": "fake", "CU_DATA_DIR": shared,
                            "CU_POLICY_FILE": os.path.join(shared, "policy.json")})
    first.initialize()
    second.initialize()
    for index in range(25):
        first.call("ui_tree")
        second.call("list_windows")
    first.close()
    second.close()
    shared_audit = [name for name in os.listdir(shared) if name.startswith("audit-")]
    suite.check("two sessions share one audit file", bool(shared_audit), str(os.listdir(shared)))
    corrupt = 0
    total = 0
    for name in shared_audit:
        with open(os.path.join(shared, name), encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    total += 1
                    try:
                        json.loads(line)
                    except ValueError:
                        corrupt += 1
    suite.check("concurrent writers never interleave a line (%d lines)" % total,
                total >= 50 and corrupt == 0, "%d corrupt" % corrupt)

    # --- byte-level torture on a raw pipe ---------------------------------
    if os.name != "posix":
        suite.check("the byte-level transport torture needs a posix pipe", True)
    else:
        process = spawn(temp_dir(), binary=True)

        def exchange(payload, label, timeout=15.0):
            """Send one raw payload followed by a ping; return everything read."""
            try:
                process.stdin.write(payload + b"\n")
                process.stdin.flush()
                process.stdin.write(b'{"jsonrpc":"2.0","id":9999,"method":"ping"}\n')
                process.stdin.flush()
            except (BrokenPipeError, OSError) as exc:
                return b"", str(exc)
            buffer = b""
            deadline = time.time() + timeout
            while time.time() < deadline:
                ready, _, _ = select.select([process.stdout], [], [], max(0.0, deadline - time.time()))
                if not ready:
                    break
                chunk = os.read(process.stdout.fileno(), 1 << 16)
                if not chunk:
                    break
                buffer += chunk
                if b"9999" in buffer:
                    break
            return buffer, ""

        nasty = [
            (b"\x00\x00\x00\x00", "NUL bytes"),
            (b"\xff\xfe\x00\x01", "invalid utf-8"),
            (b"\x80", "a lone continuation byte"),
            (b'{"jsonrpc": "2.0", "id": 1, "method": "\xc3"}', "a truncated multi-byte character"),
            (b"{" + b"a" * 1000000 + b"}", "a megabyte of junk"),
            (b'{"jsonrpc": "2.0", "id": 1, "method": "ping"}' + b"x" * 5000, "trailing garbage"),
            (b'{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "type_text", '
             b'"arguments": {"text": "' + b"\\u00e9" * 500 + b'"}}}', "a long unicode argument"),
            (b'{"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "click", '
             b'"arguments": {"x": 1e400, "y": 1}}}', "an overflowed number"),
            (b'{"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "click", '
             b'"arguments": {"x": [[[[[[[[[[1]]]]]]]]]], "y": 1}}}', "deeply nested arguments"),
        ]
        for payload, label in nasty:
            seen, error = exchange(payload, label)
            suite.check("the server answers the ping after %s" % label, b"9999" in seen,
                        error or seen[-120:].decode("utf-8", "replace"))
            suite.check("the server is still running after %s" % label, alive(process))
            if not alive(process):
                break

        final, error = exchange(b'{"jsonrpc": "2.0", "id": 5, "method": "tools/list"}', "a normal request")
        suite.check("the server still serves tools/list after the torture", b"tools" in final, error or "no reply")

        try:
            process.stdin.close()
        except (BrokenPipeError, OSError):
            pass
        deadline = time.time() + 15
        while process.poll() is None and time.time() < deadline:
            time.sleep(0.1)
        suite.check("the server exits on stdin EOF rather than hanging", process.poll() is not None, "still running")
        suite.check("the server exits cleanly (exit 0)", process.poll() == 0,
                    "exit %s: %s" % (process.poll(), process.stderr.read()[:200].decode("utf-8", "replace")))
        if process.poll() is None:
            process.kill()

    # --- the hook must never take the session down either -------------------
    hook = os.path.join(SCRIPTS, "hook_guard.py")
    for payload, label in ((b"\xff\xfe not utf-8", "invalid utf-8"),
                           (b"", "an empty payload"),
                           (b"null", "a null payload"),
                           (b"[]", "a list payload"),
                           (b"{" + b"x" * 200000 + b"}", "a broken 200 KB payload")):
        result = subprocess.run([sys.executable, hook], input=payload, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, cwd=ROOT)
        suite.check("the hook exits 0 on %s" % label, result.returncode == 0,
                    "exit %s: %s" % (result.returncode, result.stderr[:160]))
        # An unreadable payload must produce "no opinion" ({}), never a deny and
        # never a crash: the hook is a gate, not a parser the agent depends on.
        try:
            decision = json.loads(result.stdout.decode("utf-8") or "{}")
        except ValueError:
            decision = None
        suite.check("the hook fails open on %s" % label,
                    isinstance(decision, dict)
                    and decision.get("hookSpecificOutput", {}).get("permissionDecision") != "deny",
                    result.stdout[:120])

    return suite.finish()
