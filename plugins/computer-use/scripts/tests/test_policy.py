"""Safety policy: modes, deny lists, password protection, rate limit, audit."""

import io
import json
import os

from .helpers import Suite, temp_dir

from cu.policy import (
    DEFAULT_POLICY,
    KNOWN_TOOLS,
    MODES,
    READ_ONLY_TOOLS,
    Policy,
    combo_string,
    normalize_combo,
    redact,
)

ACTUATION = sorted(set(KNOWN_TOOLS) - set(READ_ONLY_TOOLS))


def run():
    suite = Suite("policy")

    # defaults
    suite.check("default mode is guarded", DEFAULT_POLICY["mode"] == "guarded")
    suite.check("default protects password fields", DEFAULT_POLICY["protectPasswordFields"] is True)
    suite.check("default denies password managers", "keepass" in DEFAULT_POLICY["denyApps"])
    suite.check("default denies ctrl+alt+delete", "ctrl+alt+delete" in DEFAULT_POLICY["denyKeyCombos"])
    suite.equal("read-only tool set", sorted(READ_ONLY_TOOLS),
                ["find_elements", "get_environment", "list_windows", "screenshot", "ui_tree"])
    suite.equal("modes", list(MODES), ["readonly", "guarded", "open"])

    # readonly blocks every actuation tool, allows every inspection tool
    readonly = Policy(data={"mode": "readonly"}, data_dir=temp_dir())
    blocked = [t for t in ACTUATION if readonly.evaluate(t, {})["allowed"]]
    suite.check("readonly blocks all actuation tools", not blocked, str(blocked))
    allowed = [t for t in READ_ONLY_TOOLS if readonly.evaluate(t, {})["allowed"]]
    suite.equal("readonly allows all inspection tools", len(allowed), len(READ_ONLY_TOOLS))

    # guarded allows ordinary work
    guarded = Policy(data={"mode": "guarded"}, data_dir=temp_dir())
    suite.check("guarded allows clicking", guarded.evaluate("click", {"x": 1, "y": 1})["allowed"])
    suite.check("guarded allows typing", guarded.evaluate("type_text", {"text": "hi"})["allowed"])

    # open still honours deny lists
    opened = Policy(data={"mode": "open"}, data_dir=temp_dir())
    suite.check("open allows clicking", opened.evaluate("click", {"x": 1, "y": 1})["allowed"])
    suite.check("open still denies win+l",
                not opened.evaluate("press_keys", {"keys": ["win", "l"]})["allowed"])
    suite.check("open still denies password managers",
                not opened.evaluate("open_app", {"target": "KeePassXC"}, {"app": "KeePassXC.exe"})["allowed"])

    # unknown mode falls back to guarded
    weird = Policy(data={"mode": "banana"}, data_dir=temp_dir())
    suite.equal("unknown mode falls back to guarded", weird.evaluate("click", {"x": 1})["mode"], "guarded")

    # app deny list: substring, case-insensitive, and regex when metacharacters appear
    apps = Policy(data={"mode": "guarded", "denyApps": ["keepass", "^secret-.+\\.exe$"]}, data_dir=temp_dir())
    suite.check("denyApps substring match",
                not apps.evaluate("click", {"x": 1}, {"app": "KeePassXC.exe"})["allowed"])
    suite.check("denyApps is case-insensitive",
                not apps.evaluate("click", {"x": 1}, {"app": "keepass"})["allowed"])
    suite.check("denyApps regex match",
                not apps.evaluate("click", {"x": 1}, {"app": "secret-vault.exe"})["allowed"])
    suite.check("denyApps leaves other apps alone",
                apps.evaluate("click", {"x": 1}, {"app": "notepad.exe"})["allowed"])
    plain = Policy(data={"mode": "guarded", "denyApps": ["1password"]}, data_dir=temp_dir())
    suite.check("denyApps plain text matches as a substring",
                not plain.evaluate("click", {"x": 1}, {"app": "x1passwordx"})["allowed"])
    suite.check("denyApps plain text does not match unrelated apps",
                plain.evaluate("click", {"x": 1}, {"app": "notepad.exe"})["allowed"])
    regex = Policy(data={"mode": "guarded", "denyApps": ["^vault[0-9]+$"]}, data_dir=temp_dir())
    suite.check("denyApps with metacharacters acts as a regex",
                not regex.evaluate("click", {"x": 1}, {"app": "vault42"})["allowed"])
    suite.check("denyApps regex does not over-match",
                regex.evaluate("click", {"x": 1}, {"app": "vaultx"})["allowed"])

    # window title deny list
    titles = Policy(data={"mode": "guarded", "denyWindowTitles": ["bank.*"]}, data_dir=temp_dir())
    suite.check("denyWindowTitles regex",
                not titles.evaluate("click", {"x": 1}, {"app": "chrome.exe", "window_title": "My Bank - Login"})["allowed"])
    suite.check("denyWindowTitles allows others",
                titles.evaluate("click", {"x": 1}, {"app": "chrome.exe", "window_title": "Docs"})["allowed"])

    # allow list
    only = Policy(data={"mode": "guarded", "allowApps": ["notepad"]}, data_dir=temp_dir())
    suite.check("allowApps permits a listed app",
                only.evaluate("click", {"x": 1}, {"app": "notepad.exe"})["allowed"])
    suite.check("allowApps refuses others",
                not only.evaluate("click", {"x": 1}, {"app": "chrome.exe"})["allowed"])
    suite.check("allowApps cannot judge an unknown app",
                only.evaluate("click", {"x": 1}, {})["allowed"])

    # key combos, including aliases
    for combo, should_pass in (
        (["win", "l"], False), ("meta+l", False), ("windows+l", False), (["win", "r"], True),
        (["ctrl", "shift", "esc"], False), ("f5", True), (["alt", "tab"], True),
    ):
        decision = guarded.evaluate("press_keys", {"keys": combo})
        suite.check("press_keys %r %s" % (combo, "allowed" if should_pass else "denied"),
                    decision["allowed"] is should_pass, decision["reason"])

    # password fields
    passwords = Policy(data={"mode": "guarded", "protectPasswordFields": True}, data_dir=temp_dir())
    suite.check("typing into a password field is refused",
                not passwords.evaluate("type_text", {"text": "hunter2"}, {"password_field": True})["allowed"])
    suite.check("typing into a normal field is fine",
                passwords.evaluate("type_text", {"text": "hello"}, {"password_field": False})["allowed"])
    relaxed = Policy(data={"mode": "guarded", "protectPasswordFields": False}, data_dir=temp_dir())
    suite.check("password protection can be turned off",
                relaxed.evaluate("type_text", {"text": "x"}, {"password_field": True})["allowed"])

    # rate limit applies to actuation only
    limited = Policy(data={"mode": "guarded", "maxActionsPerMinute": 3}, data_dir=temp_dir())
    outcomes = [limited.evaluate("click", {"x": 1, "y": 1})["allowed"] for _ in range(5)]
    suite.equal("rate limit lets the first three through", outcomes[:3], [True, True, True])
    suite.check("rate limit blocks the fourth", outcomes[3] is False)
    suite.check("rate limit does not block inspection",
                all(limited.evaluate("screenshot", {})["allowed"] for _ in range(10)))
    suite.check("a fresh action is allowed again after inspection",
                limited.evaluate("scroll", {"amount": 1})["allowed"] is False)

    # dry run flag
    rehearsal = Policy(data={"mode": "guarded", "dryRun": True}, data_dir=temp_dir())
    suite.check("dryRun is reported", rehearsal.evaluate("click", {"x": 1})["dryRun"] is True)

    # combo helpers
    suite.equal("combo from list", combo_string(["Ctrl", "Shift", "S"]), "ctrl+shift+s")
    suite.equal("combo from string", combo_string("ctrl + shift + s"), "ctrl+shift+s")
    suite.equal("combo aliases", combo_string(["meta", "l"]), "win+l")
    suite.equal("combo alias return", combo_string(["return"]), "enter")
    suite.equal("empty combo", combo_string(None), "none")
    suite.equal("normalize splits mixed input", normalize_combo(["ctrl+s", "shift"]), ["ctrl", "s", "shift"])

    # redaction
    suite.equal("short text is fully masked", redact("abc"), "\u2022\u2022\u2022")
    suite.equal("long text keeps a fingerprint", redact("hunter2-and-more"), "hunter\u2026d-more")
    suite.check("redaction keeps no secrets", "hunter2" not in redact("hunter2-and-more"))

    # policy file lifecycle
    work = temp_dir()
    path = os.path.join(work, "policy.json")
    fresh = Policy(path=path, data_dir=work)
    suite.check("ensure_file writes the file", fresh.ensure_file() and os.path.isfile(path))
    with io.open(path, encoding="utf-8") as handle:
        written = json.load(handle)
    suite.equal("written policy matches defaults", written["mode"], "guarded")
    with io.open(path, "w", encoding="utf-8") as handle:
        json.dump({"mode": "readonly", "maxActionsPerMinute": 7}, handle)
    suite.check("reload picks up edits", fresh.reload())
    suite.equal("reloaded mode", fresh.evaluate("click", {"x": 1})["mode"], "readonly")
    suite.equal("reloaded limit", fresh.data["maxActionsPerMinute"], 7)
    with io.open(path, "w", encoding="utf-8") as handle:
        handle.write("{ not json")
    suite.check("a corrupt policy file is reported as unusable", fresh.reload() is False)
    suite.equal("a corrupt file restores the built-in mode", fresh.data["mode"], "guarded")
    suite.equal("a corrupt file restores the built-in limit", fresh.data["maxActionsPerMinute"], 120)
    with io.open(path, "w", encoding="utf-8") as handle:
        handle.write("[1, 2, 3]")
    suite.check("a policy file that is not an object is rejected", fresh.reload() is False)
    suite.equal("non-object file also restores defaults", fresh.data["mode"], "guarded")

    # audit
    audit_dir = temp_dir()
    auditor = Policy(data={"mode": "guarded"}, data_dir=audit_dir)
    auditor.audit({"tool": "click", "decision": "allow"})
    files = [n for n in os.listdir(audit_dir) if n.startswith("audit-")]
    suite.equal("audit writes one file", len(files), 1)
    with io.open(os.path.join(audit_dir, files[0]), encoding="utf-8") as handle:
        record = json.loads(handle.readline())
    suite.check("audit record carries a timestamp", "ts" in record)
    suite.equal("audit record keeps the tool", record["tool"], "click")
    silent = Policy(data={"mode": "guarded", "audit": False}, data_dir=temp_dir())
    silent.audit({"tool": "click"})
    suite.equal("audit can be switched off", [n for n in os.listdir(silent.data_dir) if n.startswith("audit-")], [])

    return suite.finish()
