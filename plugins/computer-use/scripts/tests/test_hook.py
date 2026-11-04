"""The PreToolUse gate: it must deny what the policy denies, stay out of the
way for everything else, and never fail a session."""

import json
import os
import subprocess
import sys

from .helpers import Suite, temp_dir

HOOK = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hook_guard.py")


def invoke(payload, policy=None, raw=None, work=None, data_dir=None):
    command = [sys.executable, HOOK]
    if policy:
        command += ["--policy", policy]
    if data_dir:
        command += ["--data-dir", data_dir]
    environment = dict(os.environ)
    environment["CU_DATA_DIR"] = work or temp_dir()
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    body = raw if raw is not None else json.dumps(payload)
    proc = subprocess.run(
        command, input=body, capture_output=True, text=True, encoding="utf-8",
        env=environment, timeout=60,
    )
    decision = None
    if proc.stdout.strip():
        try:
            decision = json.loads(proc.stdout)
        except ValueError:
            decision = "unparseable: %r" % proc.stdout
    return proc.returncode, decision, proc.stdout, proc.stderr


def call(name, args=None, **extra):
    payload = {"toolCall": {"name": name, "args": args or {}}}
    payload.update(extra)
    return payload


def run():
    suite = Suite("hook")
    work = temp_dir()

    code, decision, out, err = invoke(call("computer-use_desktop_press_keys", {"keys": ["win", "l"]}), work=work)
    suite.equal("the hook always exits 0", code, 0)
    suite.equal("win+l is denied", (decision or {}).get("decision"), "deny")
    suite.check("the denial explains itself", "policy" in (decision or {}).get("reason", ""), decision)
    suite.equal("the output is a single line", len(out.strip().splitlines()), 1)

    code, decision, _, _ = invoke(call("computer-use_desktop_click", {"x": 1, "y": 2}), work=work)
    suite.equal("an ordinary click passes", decision, {})
    suite.equal("passing still exits 0", code, 0)

    code, decision, _, _ = invoke(call("computer-use_desktop_screenshot", {}), work=work)
    suite.equal("a screenshot passes", decision, {})

    code, decision, _, _ = invoke(call("computer-use_desktop_open_app", {"target": "KeePassXC.exe"}), work=work)
    suite.equal("a denied application is blocked", (decision or {}).get("decision"), "deny")

    code, decision, _, _ = invoke(call("computer-use_desktop_open_app", {"target": "notepad.exe"}), work=work)
    suite.equal("an allowed application passes", decision, {})

    # unrelated tools must never be touched, whatever the matcher is
    for name in ("Read", "Bash", "myplugin_other_run_command", "mcp__filesystem__read_file",
                 "desktop_click_thing"):
        code, decision, _, _ = invoke(call(name), work=work)
        suite.equal("%s is left alone" % name, decision, {})
        suite.equal("%s still exits 0" % name, code, 0)

    # malformed input must fail open
    for label, raw in (("empty input", ""), ("whitespace", "   \n"),
                       ("invalid json", "{not json"), ("a list", "[1, 2]"),
                       ("a string", '"hello"'), ("null", "null"),
                       ("a number", "42")):
        code, decision, _, _ = invoke(None, raw=raw, work=work)
        suite.equal("%s fails open" % label, decision, {})
        suite.equal("%s exits 0" % label, code, 0)

    code, decision, _, _ = invoke({"toolCall": "not a dict"}, work=work)
    suite.equal("a malformed toolCall fails open", decision, {})
    code, decision, _, _ = invoke({"toolCall": {"name": "computer-use_desktop_click", "args": "nope"}}, work=work)
    suite.equal("non-object arguments fail open", decision, {})
    code, decision, _, _ = invoke(call("computer-use_desktop_click", {"x": 1}), work=work)
    suite.equal("a malformed click is left to the server", decision, {})

    # namespacing variants
    for name in ("computer-use_desktop_press_keys", "computer_use_desktop_press_keys",
                 "computer-use.desktop.press_keys", "mcp:computer-use:press_keys"):
        code, decision, _, _ = invoke(call(name, {"keys": ["win", "l"]}), work=work)
        suite.equal("%s is recognised and denied" % name, (decision or {}).get("decision"), "deny")

    # a policy file can tighten or relax the gate
    strict = os.path.join(work, "strict.json")
    with open(strict, "w", encoding="utf-8") as handle:
        json.dump({"mode": "readonly"}, handle)
    code, decision, _, _ = invoke(call("computer-use_desktop_click", {"x": 1, "y": 1}), policy=strict, work=work)
    suite.equal("a readonly policy blocks clicking", (decision or {}).get("decision"), "deny")

    confirming = os.path.join(work, "confirm.json")
    with open(confirming, "w", encoding="utf-8") as handle:
        json.dump({"mode": "guarded", "confirmTools": ["click"]}, handle)
    code, decision, _, _ = invoke(call("computer-use_desktop_click", {"x": 1, "y": 1}), policy=confirming, work=work)
    suite.equal("a confirm-listed tool asks first", (decision or {}).get("decision"), "force_ask")
    code, decision, _, _ = invoke(call("computer-use_desktop_screenshot", {}), policy=confirming, work=work)
    suite.equal("tools outside the confirm list pass", decision, {})

    broken = os.path.join(work, "broken.json")
    with open(broken, "w", encoding="utf-8") as handle:
        handle.write("{ not json")
    code, decision, _, _ = invoke(call("computer-use_desktop_click", {"x": 1, "y": 1}), policy=broken, work=work)
    suite.equal("a corrupt policy fails open", decision, {})

    # an explicit data dir keeps policy and hook audit together
    pinned = os.path.join(work, "pinned-audit")
    code, decision, _, _ = invoke(call("computer-use_desktop_press_keys", {"keys": ["win", "l"]}),
                                  policy=strict, work=work, data_dir=pinned)
    suite.equal("the pinned audit dir still enforces the policy", (decision or {}).get("decision"), "deny")
    suite.check("the hook audits into --data-dir",
                any(name.startswith("audit-") for name in os.listdir(pinned)) if os.path.isdir(pinned) else False,
                os.listdir(pinned) if os.path.isdir(pinned) else "missing")

    # the gate writes its own audit trail
    audits = [name for name in os.listdir(work) if name.startswith("audit-")]
    suite.check("the gate records its decisions", audits, os.listdir(work))
    if audits:
        with open(os.path.join(work, audits[0]), encoding="utf-8") as handle:
            records = [json.loads(line) for line in handle if line.strip()]
        suite.check("the audit marks the hook as the source",
                    all(record.get("source") == "hook" for record in records), records[:1])
        suite.check("the audit records the namespaced name",
                    any("computer-use_desktop" in record.get("raw_tool", "") for record in records))
        suite.check("denials are audited",
                    any(record.get("decision") == "deny" for record in records))

    return suite.finish()
