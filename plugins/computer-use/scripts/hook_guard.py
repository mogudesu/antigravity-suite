#!/usr/bin/env python3
"""Antigravity PreToolUse gate for the computer-use MCP server.

The MCP server already refuses anything its policy forbids. This hook is a
second, independent layer: it runs *before* the tool executes, so it also
covers the case where the user granted blanket permission to the server in
Antigravity's permission system.

Contract (Antigravity lifecycle hooks):
    stdin  -> JSON containing toolCall.name, toolCall.args and session metadata
    stdout -> JSON containing a decision; the process must exit 0

Any internal error fails open (allow) so a broken hook can never wedge a
session, exactly as the Antigravity documentation requires.
"""

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from cu.policy import KNOWN_TOOLS, Policy  # noqa: E402

SERVER_HINTS = ("computer-use", "computer_use")


def looks_like_ours(name):
    lowered = str(name or "").lower()
    return any(hint in lowered for hint in SERVER_HINTS)


def bare_tool_name(name):
    """Resolve a namespaced MCP tool name back to its own tool name.

    Antigravity exposes MCP tools as ``<plugin>_<server>_<tool>``, so
    ``computer-use_desktop_press_keys`` has to become ``press_keys`` before the
    policy can recognise it. Matching on the known tool names rather than on a
    fixed number of prefixes keeps this working when the server is renamed.
    """
    text = str(name or "")
    if text in KNOWN_TOOLS:
        return text
    for tool in sorted(KNOWN_TOOLS, key=len, reverse=True):
        for separator in ("_", ":", ".", "/", "-"):
            if text.endswith(separator + tool):
                return tool
    return text.rsplit("_", 1)[-1]


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main(argv=None):
    parser = argparse.ArgumentParser(description="computer-use PreToolUse gate")
    parser.add_argument("--policy", default="", help="Path to a policy.json override.")
    parser.add_argument(
        "--data-dir",
        default="",
        help="Directory for the hook audit trail (defaults to CU_DATA_DIR).",
    )
    args = parser.parse_args(argv)

    try:
        raw = sys.stdin.read()
    except Exception:
        raw = ""
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    try:
        tool_call = payload.get("toolCall")
        if not isinstance(tool_call, dict):
            tool_call = {}
        name = tool_call.get("name") or ""
        tool_args = tool_call.get("args")
        if not isinstance(tool_args, dict):
            tool_args = {}
        if not looks_like_ours(name):
            emit({})
            return 0

        tool = bare_tool_name(name)
        policy = (
            Policy(path=args.policy, data_dir=args.data_dir or None)
            if args.policy
            else Policy.from_env()
        )
        context = {}
        if tool == "open_app":
            context["app"] = str(tool_args.get("target") or "")
        decision = policy.evaluate(tool, tool_args, context)
        base = {"tool": tool, "raw_tool": str(name), "source": "hook"}

        if not decision["allowed"]:
            record = dict(base)
            record.update({"decision": "deny", "reason": decision["reason"]})
            policy.audit(record)
            emit(
                {
                    "decision": "deny",
                    "reason": "computer-use policy blocked %s: %s"
                    % (tool, decision["reason"]),
                }
            )
            return 0

        if tool in (policy.data.get("confirmTools") or []):
            record = dict(base)
            record["decision"] = "force_ask"
            policy.audit(record)
            emit(
                {
                    "decision": "force_ask",
                    "reason": "computer-use policy asks for confirmation before %s" % tool,
                }
            )
            return 0

        emit({})
        return 0
    except Exception as exc:  # fail open, but leave a trace on stderr
        sys.stderr.write("computer-use hook_guard failed open: %s\n" % exc)
        emit({})
        return 0


if __name__ == "__main__":
    sys.exit(main())
