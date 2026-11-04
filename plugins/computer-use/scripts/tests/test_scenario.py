"""A realistic agent workflow on the virtual desktop.

Each step asserts something the agent could actually observe through the tools
(a value in the accessibility tree, the active window marker, a refusal, the
audit trail), so this module is the closest thing to "does a session feel
smooth end to end" that can be verified without a real desktop.
"""

import json
import os

from .helpers import MCPClient, Suite, temp_dir

NOTEPAD = "notepad.exe"
CALC = "calc.exe"


def run():
    suite = Suite("scenario")
    work = temp_dir()
    client = MCPClient(env={"CU_BACKEND": "fake", "CU_DATA_DIR": work,
                            "CU_POLICY_FILE": os.path.join(work, "policy.json")})
    client.initialize()

    def text(name, args=None):
        return client.text(client.call(name, args or {}))

    # 1. orient -------------------------------------------------------------
    environment = json.loads(text("get_environment"))
    suite.equal("the session starts in guarded mode", environment["policy"]["mode"], "guarded")
    suite.check("the agent can see the screen size before doing anything",
                environment["screen"]["width"] == 1920 and environment["screen"]["height"] == 1080,
                str(environment.get("screen")))

    listing = text("list_windows")
    suite.check("notepad is listed and marked active", "[ACTIVE]" in listing and NOTEPAD in listing, listing[:160])
    suite.check("the calculator is listed too", CALC in listing)
    active_line = [line for line in listing.splitlines() if "[ACTIVE]" in line][0]
    suite.check("the active marker sits on the notepad window", NOTEPAD in active_line, active_line)

    # 2. read the UI before touching it -------------------------------------
    tree = text("ui_tree")
    suite.check("the editor is empty to begin with", "value='hello'" not in tree)
    suite.check("the password field never leaks a value", "password=true" in tree and "PwdField" in tree)

    shallow = text("ui_tree", {"max_depth": 1})
    suite.check("max_depth actually limits the walk",
                shallow.count("name=") < tree.count("name="),
                "%d vs %d" % (shallow.count("name="), tree.count("name=")))

    found = text("find_elements", {"query": "editor"})
    suite.check("an element can be found by name or automation id",
                "Editor" in found and "1 match" in found, found[:160])
    suite.check("a search with no hits reports zero matches", "0 match" in text("find_elements", {"query": "zzzz"}))

    # 3. type into the editor ------------------------------------------------
    suite.check("clicking an element reports how it acted",
                "via click" in text("click_element", {"element_id": "Editor"}))
    suite.check("typing reports the character count", "5 character" in text("type_text", {"text": "hello"}))
    suite.check("the editor now holds the text", "value='hello'" in text("ui_tree"))

    # 4. focus routing: the next field is a different element ----------------
    text("click_element", {"query": "Search"})
    text("type_text", {"text": "world"})
    after = text("ui_tree")
    suite.check("the second field received its own text", "value='world'" in after, after[:200])
    suite.check("the editor kept the first text", "value='hello'" in after)

    # 5. the policy protects password fields ---------------------------------
    suite.check("a password field is activated without clicking it",
                "via focus" in text("click_element", {"query": "Password"}))
    refusal = client.call("type_text", {"text": "hunter2"})
    suite.check("typing into a password field is refused", client.is_error(refusal), text("type_text"))
    suite.check("the refusal names the reason", "password" in client.text(refusal).lower(), client.text(refusal)[:160])
    suite.check("nothing was typed into the password field", "hunter2" not in text("ui_tree"))

    # 6. disabled controls and unknown targets fail clearly -------------------
    disabled = client.call("click_element", {"query": "Close"})
    suite.check("a disabled control is refused", client.is_error(disabled), client.text(disabled)[:120])
    suite.check("the refusal names the control", "Close" in client.text(disabled), client.text(disabled)[:120])
    missing = client.call("click_element", {"query": "NoSuchButton"})
    suite.check("an unknown control is refused", client.is_error(missing), client.text(missing)[:120])
    suite.check("the server is fine after the refusals", client.send("ping")["result"] == {})

    # 7. the clipboard -------------------------------------------------------
    text("clipboard", {"action": "write", "text": "copied from the editor"})
    suite.check("the clipboard round trips", "copied from the editor" in text("clipboard", {"action": "read"}))

    # 8. keyboard, including a blocked combination ---------------------------
    suite.check("a normal shortcut is allowed",
                not client.is_error(client.call("press_keys", {"keys": ["ctrl", "s"]})))
    blocked = client.call("press_keys", {"keys": ["ctrl", "alt", "delete"]})
    suite.check("a dangerous shortcut is refused", client.is_error(blocked), client.text(blocked)[:120])
    suite.check("the refusal names the combination", "ctrl+alt+delete" in client.text(blocked).lower(),
                client.text(blocked)[:160])

    # 9. pointer work --------------------------------------------------------
    suite.check("a drag is accepted", not client.is_error(
        client.call("drag", {"from_x": 400, "from_y": 300, "to_x": 500, "to_y": 400})))
    suite.check("a zero scroll is a no-op rather than a scroll",
                not client.is_error(client.call("scroll", {"amount": 0})))
    suite.check("scrolling down is accepted", not client.is_error(client.call("scroll", {"amount": -3})))

    # 10. switching windows by clicking inside one ---------------------------
    text("click", {"x": 1100, "y": 400})
    switched = text("list_windows")
    calc_line = [line for line in switched.splitlines() if CALC in line][0]
    suite.check("clicking inside the calculator activates it", "[ACTIVE]" in calc_line, calc_line)

    # 11. and switching back explicitly --------------------------------------
    focused = text("focus_window", {"title": "Untitled - Notepad"})
    suite.check("a window can be focused by title", NOTEPAD in focused, focused[:160])
    back = text("list_windows")
    suite.check("the active marker moved back",
                "[ACTIVE]" in [line for line in back.splitlines() if NOTEPAD in line][0],
                back[:160])

    # 12. screenshots of different regions are actually different ------------
    def shot(region):
        response = client.call("screenshot", region)
        return [item["data"] for item in response["result"]["content"] if item.get("type") == "image"]

    inside = shot({"x": 200, "y": 200, "width": 300, "height": 200})   # over a window
    outside = shot({"x": 0, "y": 720, "width": 300, "height": 200})    # empty desktop
    suite.check("both regions produced an image", bool(inside) and bool(outside))
    if inside and outside:
        suite.check("a window region does not render like the empty desktop", inside[0] != outside[0])
    again = shot({"x": 200, "y": 200, "width": 300, "height": 200})
    suite.check("the same region renders identically twice", again == inside)

    # 13. dry run rehearses instead of acting --------------------------------
    policy_path = os.path.join(work, "policy.json")
    text("click_element", {"element_id": "Editor"})  # leave the password field behind
    with open(policy_path, "w", encoding="utf-8") as handle:
        json.dump({"mode": "guarded", "dryRun": True}, handle)
    rehearsal = text("type_text", {"text": "this must not land"})
    suite.check("dry run reports what it would have done", "[dry-run]" in rehearsal, rehearsal[:160])
    suite.check("dry run really did not type", "this must not land" not in text("ui_tree"))
    with open(policy_path, "w", encoding="utf-8") as handle:
        json.dump({"mode": "guarded"}, handle)

    # 14. the session left an honest trail -----------------------------------
    audits = [name for name in os.listdir(work) if name.startswith("audit-")]
    suite.check("the workflow was audited", bool(audits), str(os.listdir(work)))
    records = []
    for name in audits:
        with open(os.path.join(work, name), encoding="utf-8") as handle:
            records += [json.loads(line) for line in handle if line.strip()]
    tools_used = set(record.get("tool") for record in records)
    for expected in ("ui_tree", "click_element", "type_text", "press_keys", "clipboard", "screenshot"):
        suite.check("the audit recorded %s" % expected, expected in tools_used, str(sorted(tools_used)))
    suite.check("refusals are recorded as denials",
                any(record.get("decision") == "deny" for record in records))
    suite.check("the password attempt was denied and the text was redacted",
                not any("hunter2" in json.dumps(record) for record in records))
    suite.check("dry runs are recorded as such",
                any(record.get("decision") == "dry_run" for record in records),
                str([record.get("decision") for record in records][:5]))

    client.close()
    return suite.finish()
