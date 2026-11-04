#!/usr/bin/env python3
"""Point an installed copy of the plugin at a concrete interpreter and data dir.

An installed copy must work on a machine whose interpreter is not ``python3``
(most Windows installs) and must let the MCP server and the PreToolUse hook
agree on one policy file. This script rewrites ``mcp.json`` and ``hooks.json``
accordingly. Both install scripts call it, so the rewriting is tested once.
"""

import argparse
import io
import json
import os
import sys

SERVER = "desktop"
ENTRY = "${PLUGIN_ROOT}/scripts/mcp_server.py"


def load(path):
    with io.open(path, encoding="utf-8") as handle:
        return json.load(handle)


def save(path, data):
    with io.open(path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def build_command(interpreter, pre_args, policy):
    tail = ' --policy "%s"' % policy if policy else ""
    primary = " ".join([interpreter] + list(pre_args) + ["./scripts/hook_guard.py" + tail])
    if interpreter == "python":
        return primary
    return primary + " || " + " ".join(["python", "./scripts/hook_guard.py" + tail])


def main(argv=None):
    parser = argparse.ArgumentParser(description="configure an installed plugin copy")
    parser.add_argument("--plugin-dir", required=True)
    parser.add_argument("--command", default="python3", help="interpreter for mcp.json")
    parser.add_argument("--pre-args", default="", help="extra interpreter args, e.g. '-3' for py")
    parser.add_argument("--data-dir", default="", help="pin the data dir to this path")
    parser.add_argument("--use-plugin-data", action="store_true",
                        help="keep ${PLUGIN_DATA} instead of pinning a concrete path")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    plugin_dir = os.path.abspath(args.plugin_dir)
    mcp_path = os.path.join(plugin_dir, "mcp.json")
    hooks_path = os.path.join(plugin_dir, "hooks.json")
    for path in (mcp_path, hooks_path):
        if not os.path.isfile(path):
            sys.stderr.write("missing %s\n" % path)
            return 1

    pre_args = [part for part in args.pre_args.split() if part]
    pinned = not args.use_plugin_data
    data_dir = args.data_dir or ""
    if pinned and not data_dir:
        data_dir = os.path.join(os.path.expanduser("~"), ".local", "share", "computer-use")
    policy = os.path.join(data_dir, "policy.json") if pinned else ""

    mcp = load(mcp_path)
    server = mcp.setdefault("mcpServers", {}).setdefault(SERVER, {})
    server["command"] = args.command
    server["args"] = pre_args + [ENTRY]
    env = server.setdefault("env", {})
    if pinned:
        env["CU_DATA_DIR"] = data_dir
        env["CU_POLICY_FILE"] = policy
        env["CU_AUDIT_DIR"] = os.path.join(data_dir, "audit")
    else:
        env["CU_DATA_DIR"] = "${PLUGIN_DATA}"
        env["CU_POLICY_FILE"] = "${PLUGIN_DATA}/policy.json"
        env["CU_AUDIT_DIR"] = "${PLUGIN_DATA}/audit"
    env.setdefault("PYTHONUTF8", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    # keep the installed plugin directory free of __pycache__ artefacts
    env.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    server.setdefault("cwd", "${PLUGIN_ROOT}")
    server.setdefault("timeoutSeconds", 120)

    hooks = load(hooks_path)
    command = build_command(args.command, pre_args, policy)
    for group in hooks.values():
        if not isinstance(group, dict):
            continue
        for entry in group.get("PreToolUse", []) or []:
            for handler in entry.get("hooks", []) or []:
                handler["command"] = command

    print("plugin dir : %s" % plugin_dir)
    print("interpreter: %s %s" % (args.command, " ".join(pre_args)))
    print("data dir   : %s" % (data_dir if pinned else "${PLUGIN_DATA}"))
    print("hook cmd   : %s" % command)
    if args.dry_run:
        print("(dry run: nothing written)")
        return 0
    save(mcp_path, mcp)
    save(hooks_path, hooks)
    print("wrote mcp.json and hooks.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
