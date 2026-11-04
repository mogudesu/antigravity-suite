#!/usr/bin/env python3
"""End-to-end self test: starts the MCP server and exercises the protocol.

Run with ``python3 scripts/selftest.py``. It never touches the real desktop:
it asserts the protocol handshake, the tool catalogue, the policy gates, the
error contract and the audit trail.
"""

import base64
import json
import os
import struct
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SERVER = os.path.join(HERE, "mcp_server.py")

PASSED = []
FAILED = []


def check(name, condition, detail=""):
    if condition:
        PASSED.append(name)
        print("  PASS  %s" % name)
    else:
        FAILED.append((name, detail))
        print("  FAIL  %s %s" % (name, detail))


class Client:
    def __init__(self, env):
        self.proc = subprocess.Popen(
            [sys.executable, SERVER],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=ROOT,
            env=env,
            text=True,
            encoding="utf-8",
        )
        self.next_id = 1

    def send(self, method, params=None):
        message = {"jsonrpc": "2.0", "id": self.next_id, "method": method}
        if params is not None:
            message["params"] = params
        self.next_id += 1
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("server closed the stream: %s" % self.proc.stderr.read()[:400])
        return json.loads(line)

    def notify(self, method, params=None):
        message = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def call(self, name, arguments=None):
        return self.send("tools/call", {"name": name, "arguments": arguments or {}})

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def make_env(policy, data_dir):
    env = dict(os.environ)
    env["CU_POLICY_FILE"] = policy
    env["CU_DATA_DIR"] = data_dir
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


def text_of(response):
    return "\n".join(
        item.get("text", "")
        for item in response.get("result", {}).get("content", [])
        if item.get("type") == "text"
    )


def main():
    workdir = tempfile.mkdtemp(prefix="cu-selftest-")
    policy_path = os.path.join(workdir, "policy.json")
    data_dir = os.path.join(workdir, "data")
    os.makedirs(data_dir, exist_ok=True)
    with open(policy_path, "w", encoding="utf-8") as handle:
        json.dump({"mode": "guarded", "dryRun": False}, handle)

    print("1. handshake")
    client = Client(make_env(policy_path, data_dir))
    init = client.send(
        "initialize",
        {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "selftest", "version": "1.0"},
        },
    )
    result = init.get("result", {})
    check("initialize returns serverInfo", result.get("serverInfo", {}).get("name") == "computer-use")
    check("initialize echoes protocol version", result.get("protocolVersion") == "2025-06-18")
    check("initialize advertises tools capability", "tools" in result.get("capabilities", {}))
    check("initialize carries agent instructions", len(result.get("instructions", "")) > 200)
    client.notify("notifications/initialized")

    print("2. tool catalogue")
    listing = client.send("tools/list", {})
    tools = listing.get("result", {}).get("tools", [])
    names = [tool["name"] for tool in tools]
    expected = {
        "get_environment", "list_windows", "focus_window", "screenshot", "ui_tree",
        "find_elements", "click_element", "click", "move_mouse", "drag", "scroll",
        "type_text", "press_keys", "clipboard", "open_app",
    }
    check("catalogue exposes the expected tools", expected.issubset(set(names)), str(sorted(expected - set(names))))
    check("catalogue has no duplicates", len(names) == len(set(names)))
    from cu.policy import KNOWN_TOOLS
    check("catalogue matches the policy tool list", set(names) == set(KNOWN_TOOLS),
          str(set(names) ^ set(KNOWN_TOOLS)))
    bad_schema = [
        tool["name"]
        for tool in tools
        if tool.get("inputSchema", {}).get("type") != "object" or len(tool.get("description", "")) < 40
    ]
    check("every tool has an object schema and a real description", not bad_schema, str(bad_schema))
    required_ok = all(
        isinstance(tool["inputSchema"].get("required"), list) for tool in tools
    )
    check("every tool declares a required list", required_ok)

    print("3. read-only calls")
    env = json.loads(text_of(client.call("get_environment")))
    check("get_environment reports capabilities", "capabilities" in env)
    check("get_environment reports policy", env.get("policy", {}).get("mode") == "guarded")
    check(
        "capability report is honest about a headless host",
        env["capabilities"]["display"] in (True, False),
    )

    print("4. policy enforcement")
    denied = client.call("press_keys", {"keys": ["win", "l"]})
    check("denied key combo is refused", denied.get("result", {}).get("isError") is True)
    check("refusal names the policy", "policy" in text_of(denied).lower())

    print("5. error contract")
    missing = client.call("click", {})
    check("missing required argument is an error", missing.get("result", {}).get("isError") is True)
    unknown = client.call("does_not_exist", {})
    check("unknown tool is an error", unknown.get("result", {}).get("isError") is True)
    bad_method = client.send("tools/nonsense", {})
    check("unknown method returns a JSON-RPC error", "error" in bad_method)
    check("unknown method uses -32601", bad_method.get("error", {}).get("code") == -32601)

    print("6. platform honesty")
    shot = client.call("screenshot", {})
    shot_text = text_of(shot)
    if shot.get("result", {}).get("isError"):
        check("headless screenshot fails with a readable message", "unavailable" in shot_text.lower(), shot_text[:160])
    else:
        check("screenshot returns an image", any(
            item.get("type") == "image" for item in shot["result"]["content"]
        ))
    client.close()

    print("7. dry-run mode")
    with open(policy_path, "w", encoding="utf-8") as handle:
        json.dump({"mode": "guarded", "dryRun": True}, handle)
    client = Client(make_env(policy_path, data_dir))
    client.send("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}})
    client.notify("notifications/initialized")
    rehearsal = client.call("type_text", {"text": "hello"})
    check("dry-run rehearses instead of typing", "[dry-run]" in text_of(rehearsal), text_of(rehearsal)[:120])
    check("dry-run is not an error", rehearsal.get("result", {}).get("isError") is not True)
    client.close()

    print("8. read-only mode")
    with open(policy_path, "w", encoding="utf-8") as handle:
        json.dump({"mode": "readonly", "dryRun": False}, handle)
    client = Client(make_env(policy_path, data_dir))
    client.send("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}})
    client.notify("notifications/initialized")
    blocked = client.call("click", {"x": 10, "y": 10})
    check("read-only mode refuses actuation", blocked.get("result", {}).get("isError") is True)
    check("read-only refusal explains itself", "readonly" in text_of(blocked).lower(), text_of(blocked)[:120])
    allowed = client.call("get_environment", {})
    check("read-only mode still allows inspection", allowed.get("result", {}).get("isError") is not True)
    client.close()

    print("9. audit trail")
    audit_files = [name for name in os.listdir(data_dir) if name.startswith("audit-")]
    check("audit file was written", bool(audit_files), str(os.listdir(data_dir)))
    if audit_files:
        records = []
        with open(os.path.join(data_dir, audit_files[0]), encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if line:
                    records.append(json.loads(line))
        check("audit records are valid JSON lines", len(records) > 0)
        check("audit records name the tool", all("tool" in record for record in records))
        check(
            "audit records a denial",
            any(record.get("decision") == "deny" for record in records),
        )
        typed = [record for record in records if record.get("tool") == "type_text"]
        check("a type_text call was audited", bool(typed))
        for record in typed:
            logged = str(record.get("args", {}).get("text", ""))
            check(
                "typed text is redacted in the audit log",
                "\u2022" in logged and "hello" not in logged,
                logged,
            )

    print("10. policy file bootstrap")
    boot = os.path.join(workdir, "fresh", "policy.json")
    env = make_env(boot, os.path.join(workdir, "fresh-data"))
    client = Client(env)
    client.send("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}})
    client.notify("notifications/initialized")
    client.call("get_environment")
    client.close()
    check("a missing policy file is materialised", os.path.isfile(boot))
    if os.path.isfile(boot):
        with open(boot, encoding="utf-8") as handle:
            defaults = json.load(handle)
        check("materialised policy keeps guarded defaults", defaults.get("mode") == "guarded")

    print("11. virtual desktop end to end")
    fake_dir = os.path.join(workdir, "virtual")
    fake_policy = os.path.join(fake_dir, "policy.json")
    fake_env = make_env(fake_policy, fake_dir)
    fake_env["CU_BACKEND"] = "fake"
    client = Client(fake_env)
    client.send("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}})
    client.notify("notifications/initialized")

    environment = client.call("get_environment")
    payload = json.loads(text_of(environment) or "{}")
    check("the virtual desktop reports itself as fake",
          payload.get("capabilities", {}).get("platform") == "fake", str(payload)[:120])
    check("the virtual desktop reports a screen geometry",
          payload.get("screen", {}).get("width") == 1920, str(payload.get("screen"))[:120])

    windows = client.call("list_windows")
    check("the virtual desktop lists two windows",
          text_of(windows).startswith("2 visible window"), text_of(windows)[:80])

    tree = client.call("ui_tree")
    check("the accessibility tree exposes the Save button", "Save" in text_of(tree))

    found = client.call("find_elements", {"query": "save"})
    check("element search finds the Save button by name", "SaveButton" in text_of(found))

    activated = client.call("click_element", {"query": "Save"})
    check("clicking an element succeeds", activated.get("result", {}).get("isError") is not True,
          text_of(activated)[:120])
    check("the click used the control's own action", "invoke" in text_of(activated), text_of(activated)[:120])

    typed = client.call("type_text", {"text": "hello"})
    check("typing succeeds", typed.get("result", {}).get("isError") is not True, text_of(typed)[:120])

    client.call("clipboard", {"action": "write", "text": "from selftest"})
    check("the clipboard round trips", "from selftest" in text_of(client.call("clipboard", {"action": "read"})))

    shot = client.call("screenshot", {"x": 0, "y": 0, "width": 64, "height": 48})
    images = [item for item in shot.get("result", {}).get("content", []) if item.get("type") == "image"]
    check("the virtual desktop returns an image", bool(images), text_of(shot)[:120])
    if images:
        raw = base64.b64decode(images[0].get("data", ""))
        check("the image is a png", raw[:8] == b"\x89PNG\r\n\x1a\n")
        check("the image is a real image, not a placeholder",
              len(raw) > 100 and struct.unpack(">II", raw[16:24]) == (64, 48),
              "%d bytes" % len(raw))
        check("the image declares its media type", images[0].get("mimeType") == "image/png")

    # read-only tools must never be rate limited: a careful agent inspects a lot
    throttle = os.path.join(fake_dir, "throttle.json")
    with open(throttle, "w", encoding="utf-8") as handle:
        json.dump({"mode": "guarded", "maxActionsPerMinute": 1}, handle)
    client.close()
    throttle_env = make_env(throttle, os.path.join(fake_dir, "throttle-data"))
    throttle_env["CU_BACKEND"] = "fake"
    client = Client(throttle_env)
    client.send("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}})
    client.notify("notifications/initialized")
    client.call("click", {"x": 300, "y": 300})  # inside the virtual notepad window
    second = client.call("click", {"x": 301, "y": 301})
    check("the rate limit stops a second action",
          second.get("result", {}).get("isError") is True, text_of(second)[:120])
    checks = [client.call("list_windows").get("result", {}).get("isError") for _ in range(5)]
    check("inspection is never rate limited", not any(checks), str(checks))

    def read_audit(directory):
        found = []
        for name in sorted(os.listdir(directory)) if os.path.isdir(directory) else []:
            if name.startswith("audit-"):
                with open(os.path.join(directory, name), encoding="utf-8") as handle:
                    found += [json.loads(line) for line in handle if line.strip()]
        return found

    records = read_audit(fake_dir)
    check("the virtual desktop writes an audit trail", bool(records), str(os.listdir(fake_dir)))
    check("the audit records successful actions",
          any(record.get("decision") == "allow" for record in records))
    throttled = read_audit(os.path.join(fake_dir, "throttle-data"))
    check("the audit attributes a click to the window under the pointer",
          any(record.get("app") == "notepad.exe" for record in throttled),
          str(throttled[:2])[:200])
    check("the audit records the rate-limit refusal",
          any(record.get("decision") == "deny" for record in throttled))
    client.close()

    print("\n%d passed, %d failed" % (len(PASSED), len(FAILED)))
    if FAILED:
        for name, detail in FAILED:
            print("  - %s %s" % (name, detail))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
