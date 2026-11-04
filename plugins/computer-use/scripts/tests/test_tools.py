"""Tool layer: schemas, argument handling, policy interaction, audit trail."""

import base64
import json
import os

from .helpers import MCPClient, Suite, temp_dir

from cu.backends.fake import FakeBackend
from cu.imaging import png_size
from cu.policy import KNOWN_TOOLS, READ_ONLY_TOOLS, Policy
from cu.tools import Toolset

MINIMAL_ARGS = {
    "get_environment": {},
    "list_windows": {},
    "focus_window": {"title": "Notepad"},
    "screenshot": {},
    "ui_tree": {},
    "find_elements": {"query": "Save"},
    "click_element": {"query": "Save"},
    "click": {"x": 700, "y": 660},
    "move_mouse": {"x": 10, "y": 10},
    "drag": {"from_x": 1, "from_y": 1, "to_x": 9, "to_y": 9},
    "scroll": {"amount": 2},
    "type_text": {"text": "hi"},
    "press_keys": {"keys": ["ctrl", "s"]},
    "clipboard": {"action": "read"},
    "open_app": {"target": "notepad.exe"},
}

# every one of these must come back as a plain error result, never an exception
MUST_ERROR = [
    ("click", {}), ("click", {"x": 1}), ("click", {"y": 1}), ("click", {"x": 1, "y": 2, "count": "many"}),
    ("click", {"x": "left", "y": 2}),
    ("move_mouse", {}), ("move_mouse", {"x": 1}),
    ("drag", {"from_x": 1, "from_y": 1, "to_x": 2}),
    ("scroll", {}), ("scroll", {"amount": "up"}),
    ("type_text", {}), ("type_text", {"text": ""}),
    ("press_keys", {}), ("press_keys", {"keys": 123}), ("press_keys", {"keys": []}),
    ("clipboard", {}), ("clipboard", {"action": "write"}), ("clipboard", {"action": "paste"}),
    ("open_app", {}), ("find_elements", {}),
    ("screenshot", {"x": 1, "y": 2}),
    ("ui_tree", {"max_depth": "deep"}),
    ("click_element", {}),
]


def build(data=None, backend=None):
    work = temp_dir()
    settings = {"mode": "guarded"}
    settings.update(data or {})
    backend = backend if backend is not None else FakeBackend()
    policy = Policy(data=settings, data_dir=work)
    return Toolset(backend, policy), backend, policy, work


def records(work):
    found = []
    for name in sorted(os.listdir(work)):
        if name.startswith("audit-"):
            with open(os.path.join(work, name), encoding="utf-8") as handle:
                found += [json.loads(line) for line in handle if line.strip()]
    return found


def run():
    suite = Suite("tools")
    tools, backend, policy, work = build()
    schemas = tools.list_tools()
    by_name = {tool["name"]: tool for tool in schemas}

    # --- catalogue --------------------------------------------------------
    suite.equal("the catalogue has 15 tools", len(schemas), 15)
    suite.equal("tool names match the policy vocabulary", sorted(by_name), sorted(KNOWN_TOOLS))
    thin = [name for name, tool in by_name.items() if len(tool["description"]) < 60]
    suite.check("every tool explains itself", not thin, str(thin))
    missing = [
        name for name, tool in by_name.items()
        if not set(tool["inputSchema"].get("required", [])) <= set(tool["inputSchema"]["properties"])
    ]
    suite.check("required arguments are always declared", not missing, str(missing))
    undocumented = [
        "%s.%s" % (name, key)
        for name, tool in by_name.items()
        for key, prop in tool["inputSchema"]["properties"].items()
        if not prop.get("description") and not prop.get("oneOf")
    ]
    suite.check("every argument is documented", not undocumented, str(undocumented))
    loose = [name for name, tool in by_name.items() if tool["inputSchema"].get("additionalProperties") is not False]
    suite.check("schemas reject unknown arguments", not loose, str(loose))
    for name, tool in by_name.items():
        suite.check("%s schema is an object schema" % name, tool["inputSchema"]["type"] == "object")
    suite.check("the read-only tools are a subset of the catalogue",
                set(READ_ONLY_TOOLS) <= set(by_name))

    # --- every tool runs against the virtual desktop ----------------------
    for name in sorted(KNOWN_TOOLS):
        result = tools.call(name, MINIMAL_ARGS[name])
        suite.check("%s returns the result envelope" % name,
                    isinstance(result, dict) and set(result) == {"text", "images", "isError"},
                    sorted(result) if isinstance(result, dict) else type(result))
        suite.check("%s succeeds" % name, result.get("isError") is False, str(result.get("text"))[:120])
        suite.check("%s returns text" % name, isinstance(result.get("text"), str) and len(result["text"]) > 5)

    # --- argument robustness ---------------------------------------------
    for name, args in MUST_ERROR:
        try:
            result = tools.call(name, args)
        except Exception as exc:  # noqa: BLE001 - a raise here is the bug
            suite.check("%s%r fails gracefully" % (name, args), False, "raised %r" % (exc,))
            continue
        suite.check("%s%r reports an error" % (name, args), result.get("isError") is True,
                    str(result.get("text"))[:90])
    error_text = tools.call("click", {})["text"]
    suite.check("the error names the missing argument", "x" in error_text, error_text)
    suite.check("errors are prefixed for the model", error_text.startswith("Error:"))
    suite.check("an unknown tool is reported",
                tools.call("nope", {})["isError"] and "unknown tool" in tools.call("nope", {})["text"])

    # --- perception -------------------------------------------------------
    tools, backend, policy, work = build()
    listing = tools.call("list_windows", {})
    suite.check("list_windows names the notepad window", "Notepad" in listing["text"])
    suite.check("list_windows names the calculator window", "Calculator" in listing["text"])

    tree = tools.call("ui_tree", {})
    suite.check("ui_tree lists the Save button", "Save" in tree["text"])
    suite.check("ui_tree reports action patterns", "Invoke" in tree["text"])

    found = tools.call("find_elements", {"query": "save"})
    suite.check("find_elements is case-insensitive", "SaveButton" in found["text"])
    suite.equal("find_elements reports a match count", found["text"].split(" ")[0], "1")
    suite.check("find_elements can miss", "0 match" in tools.call("find_elements", {"query": "zzz"})["text"])

    shot = tools.call("screenshot", {})
    suite.equal("screenshot returns one image", len(shot["images"]), 1)
    image = shot["images"][0]
    suite.equal("the image declares its mime type", image["mime"], "image/png")
    raw = base64.b64decode(image["data"])
    suite.equal("the image is a full screen png", png_size(raw), (1920, 1080))
    suite.check("the reply states the size", "1920x1080" in shot["text"])
    suite.check("the reply points at the file", "File:" in shot["text"])

    small = tools.call("screenshot", {"max_width": 640})
    suite.equal("max_width downscales the image", png_size(base64.b64decode(small["images"][0]["data"])), (640, 360))
    suite.check("the reply explains the downscale factor", "downscaled" in small["text"])

    suite.check("a downscaled full-screen capture still explains the mapping",
                "screen_x = 0 + image_x * 3.000" in small["text"], small["text"])

    region = tools.call("screenshot", {"x": 100, "y": 100, "width": 200, "height": 150})
    suite.equal("a region is captured at its own size",
                png_size(base64.b64decode(region["images"][0]["data"])), (200, 150))
    suite.check("the reply states the region", "x=100 y=100 width=200 height=150" in region["text"])

    # --- actuation --------------------------------------------------------
    tools, backend, policy, work = build()
    tools.call("click", {"x": 300, "y": 400, "count": 2})
    suite.check("click reaches the backend", backend.actions[-1]["action"] == "click", backend.actions[-1])
    suite.equal("click passes the coordinates", (backend.actions[-1]["x"], backend.actions[-1]["y"]), (300, 400))
    suite.equal("click passes the count", backend.actions[-1]["count"], 2)

    tools.call("move_mouse", {"x": 5, "y": 6})
    suite.equal("move_mouse reaches the backend", backend.actions[-1]["action"], "move_mouse")
    tools.call("drag", {"from_x": 1, "from_y": 2, "to_x": 3, "to_y": 4})
    suite.equal("drag reaches the backend", backend.actions[-1]["action"], "drag")
    tools.call("scroll", {"amount": -3})
    suite.equal("scroll passes the direction", backend.actions[-1]["amount"], -3)
    tools.call("type_text", {"text": "hello world"})
    suite.equal("type_text reaches the backend", backend.actions[-1]["text"], "hello world")
    tools.call("press_keys", {"keys": "ctrl+shift+s"})
    suite.equal("press_keys normalizes the combo", backend.actions[-1]["keys"], ["ctrl", "shift", "s"])
    tools.call("press_keys", {"keys": ["win", "r"]})
    suite.equal("press_keys accepts a list", backend.actions[-1]["keys"], ["win", "r"])

    typed = tools.call("clipboard", {"action": "write", "text": "shared text"})
    suite.check("clipboard write is acknowledged", "11 character" in typed["text"], typed["text"])
    suite.equal("clipboard read returns what was written", tools.call("clipboard", {"action": "read"})["text"],
                "Clipboard text:\nshared text")
    tools.call("open_app", {"target": "calc.exe"})
    suite.equal("open_app reaches the backend", backend.opened, ["calc.exe"])

    # click_element: invoke pattern, coordinate fallback, focus
    tools, backend, policy, work = build()
    result = tools.call("click_element", {"query": "Save"})
    suite.check("click_element uses the invoke pattern", "invoke" in result["text"], result["text"])
    suite.equal("invoke is recorded once", len([a for a in backend.actions if a["action"] == "click_element"]), 1)
    editor = tools.call("click_element", {"query": "Text Editor"})
    suite.check("click_element falls back to a coordinate click", "click" in editor["text"], editor["text"])
    suite.check("the fallback actually clicks", any(a["action"] == "click" for a in backend.actions))
    suite.check("a disabled control is refused",
                tools.call("click_element", {"query": "Close"})["isError"])
    suite.check("an unknown control is refused",
                tools.call("click_element", {"query": "Nonexistent"})["isError"])

    # --- policy interaction ----------------------------------------------
    tools, backend, policy, work = build()
    tools.call("click_element", {"query": "Password"})
    denied = tools.call("type_text", {"text": "hunter2"})
    suite.check("typing into a password field is blocked", denied["isError"], denied["text"])
    suite.check("the refusal explains itself", "password" in denied["text"].lower(), denied["text"])
    suite.check("nothing was typed", not any(a["action"] == "type_text" for a in backend.actions))

    tools, backend, policy, work = build()
    suite.check("win+l is blocked", tools.call("press_keys", {"keys": ["win", "l"]})["isError"])
    suite.check("win+r is allowed", not tools.call("press_keys", {"keys": ["win", "r"]})["isError"])
    suite.check("a denied app is blocked", tools.call("open_app", {"target": "KeePassXC.exe"})["isError"])
    suite.check("an allowed app still opens", not tools.call("open_app", {"target": "notepad.exe"})["isError"])

    # read-only mode
    tools, backend, policy, work = build({"mode": "readonly"})
    suite.check("readonly still allows screenshots", not tools.call("screenshot", {"x": 0, "y": 0, "width": 8, "height": 8})["isError"])
    suite.check("readonly blocks clicking", tools.call("click", {"x": 1, "y": 1})["isError"])
    suite.equal("a blocked action never reaches the backend",
                [a for a in backend.actions if a["action"] == "click"], [])

    # dry run
    tools, backend, policy, work = build({"dryRun": True})
    rehearsal = tools.call("click", {"x": 1, "y": 1})
    suite.check("dry run does not fail", not rehearsal["isError"])
    suite.check("dry run announces itself", rehearsal["text"].startswith("[dry-run]"), rehearsal["text"])
    suite.check("dry run shows the arguments", "\"x\": 1" in rehearsal["text"], rehearsal["text"])
    suite.check("dry run sends nothing", [a for a in backend.actions if a["action"] == "click"] == [])
    suite.check("dry run still allows reading", not tools.call("list_windows", {})["isError"])

    # rate limiting
    tools, backend, policy, work = build({"maxActionsPerMinute": 2})
    outcomes = [tools.call("click", {"x": 1, "y": 1})["isError"] for _ in range(3)]
    suite.equal("rate limit lets two actions through", outcomes[:2], [False, False])
    suite.check("the third action is refused", outcomes[2] is True)
    suite.check("inspection is never rate limited",
                not tools.call("list_windows", {})["isError"])

    # no-progress circuit breaker: identical clicks that leave the desktop
    # unchanged are allowed twice and then refused instead of burning tokens.
    tools, backend, policy, work = build()
    first_click = tools.call("click", {"x": 1, "y": 1})
    second_click = tools.call("click", {"x": 1, "y": 1})
    third_click = tools.call("click", {"x": 1, "y": 1})
    suite.check("first no-progress click is allowed", not first_click["isError"], first_click["text"])
    suite.check("second no-progress click is allowed", not second_click["isError"], second_click["text"])
    suite.check("third no-progress click trips the breaker",
                third_click["isError"] and "circuit breaker" in third_click["text"], third_click["text"])
    suite.equal("the blocked click never reaches the backend",
                len([a for a in backend.actions if a["action"] == "click"]), 2)
    breaker_log = [r for r in records(work) if r.get("decision") == "circuit_break"]
    suite.check("the breaker is audited", bool(breaker_log), records(work)[-2:])
    suite.check("a different action still runs after the breaker",
                not tools.call("focus_window", {"title": "Notepad"})["isError"])

    # --- audit trail ------------------------------------------------------
    tools, backend, policy, work = build()
    tools.call("click", {"x": 700, "y": 660})
    tools.call("type_text", {"text": "a-very-secret-value"})
    tools.call("open_app", {"target": "KeePassXC.exe"})
    tools.call("click_element", {"query": "Password"})
    tools.call("type_text", {"text": "should-not-be-typed"})
    log = records(work)
    decisions = {record["decision"] for record in log}
    suite.check("the audit records allow decisions", "allow" in decisions, decisions)
    suite.check("the audit records denials", "deny" in decisions, decisions)
    suite.check("every call is audited", len(log) >= 5, len(log))
    suite.check("audit records carry the mode",
                all(record.get("mode") == "guarded" for record in log))
    suite.check("audit records carry the window owner",
                any(record.get("app") == "notepad.exe" for record in log),
                [record.get("app") for record in log])
    typed_records = [r for r in log if r["tool"] == "type_text" and r["decision"] == "allow"]
    suite.check("typed text is redacted in the audit",
                typed_records and "a-very-secret-value" not in json.dumps(typed_records),
                json.dumps(typed_records)[:200])
    suite.check("redaction keeps a short fingerprint",
                typed_records and typed_records[0]["args"]["text"].startswith("a-very"),
                json.dumps(typed_records)[:200])
    denial = [r for r in log if r["decision"] == "deny"]
    suite.check("a denial records a reason", denial and denial[0].get("reason"), denial)

    # --- audit can be switched off ---------------------------------------
    tools, backend, policy, work = build({"audit": False})
    tools.call("click", {"x": 1, "y": 1})
    suite.equal("audit off writes no file", records(work), [])

    # --- the same journey over the real MCP stdio channel -----------------
    client = MCPClient(env={"CU_BACKEND": "fake", "CU_DATA_DIR": temp_dir()})
    client.initialize()
    flow = [
        ("get_environment", {}),
        ("list_windows", {}),
        ("ui_tree", {}),
        ("find_elements", {"query": "Save"}),
        ("click_element", {"query": "Save"}),
        ("screenshot", {"x": 0, "y": 0, "width": 320, "height": 200}),
        ("clipboard", {"action": "write", "text": "from the agent"}),
        ("clipboard", {"action": "read"}),
    ]
    for name, args in flow:
        response = client.call(name, args)
        suite.check("stdio %s succeeds" % name, not client.is_error(response),
                    client.text(response)[:120])
    images = client.images(client.call("screenshot", {"x": 0, "y": 0, "width": 64, "height": 64}))
    suite.equal("stdio returns an image content item", len(images), 1)
    suite.equal("the content item uses mimeType", images[0].get("mimeType"), "image/png")
    suite.equal("the content item decodes to a png",
                png_size(base64.b64decode(images[0]["data"])), (64, 64))
    suite.check("stdio clipboard round trip",
                "from the agent" in client.text(client.call("clipboard", {"action": "read"})))
    client.close()

    return suite.finish()
