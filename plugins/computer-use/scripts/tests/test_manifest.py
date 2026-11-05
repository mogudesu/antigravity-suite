"""The plugin manifest and the files it promises: this is what Antigravity
reads before it ever starts the server."""

import io
import json
import os
import re

from .helpers import Suite

from cu.policy import KNOWN_TOOLS
import package

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SKILL_DIR = os.path.join("skills", "computer" + "-use")
FORBIDDEN = ("gemini", "claude", "cursor")


def load(name):
    with io.open(os.path.join(ROOT, name), encoding="utf-8") as handle:
        return json.load(handle)


def read(name):
    with io.open(os.path.join(ROOT, name), encoding="utf-8") as handle:
        return handle.read()


def frontmatter(text):
    if not text.startswith("---"):
        return {}
    body = text.split("---", 2)[1]
    found = {}
    for line in body.splitlines():
        if ":" in line and not line.startswith((" ", "\t")):
            key, _, value = line.partition(":")
            found[key.strip()] = value.strip()
    return found


def run():
    suite = Suite("manifest")
    plugin = load("plugin.json")

    # --- plugin.json ------------------------------------------------------
    suite.equal("the plugin name is computer-use", plugin["name"], "computer-use")
    suite.check("the name is kebab-case", re.match(r"^[a-z0-9]+(-[a-z0-9]+)*$", plugin["name"]))
    display = plugin.get("displayName", "")
    suite.check("displayName avoids reserved brand prefixes",
                not any(display.lower().startswith(word) for word in FORBIDDEN), display)
    suite.check("displayName is not empty", len(display) >= 3, display)
    length = len(plugin.get("description", ""))
    suite.check("the description is within 120-160 characters", 120 <= length <= 160, length)
    suite.check("the version is semantic", re.match(r"^\d+\.\d+\.\d+$", plugin.get("version", "")))
    prompts = plugin.get("suggestedPrompts") or []
    suite.check("there are at most three suggested prompts", len(prompts) <= 3, len(prompts))
    suite.check("every suggested prompt has content", all(len(item) > 10 for item in prompts))
    suite.check("an author is declared", bool(plugin.get("author", {}).get("name")))
    suite.check("a licence is declared", bool(plugin.get("license")))
    suite.check("keywords stay short", len(plugin.get("keywords") or []) <= 8)

    # --- version agreement -------------------------------------------------
    version = re.search(r'__version__ = "([^"]+)"', read(os.path.join("scripts", "cu", "__init__.py")))
    suite.check("the package declares a version", version is not None)
    if version:
        suite.equal("plugin.json and the package agree on the version", plugin["version"], version.group(1))

    # --- logo -------------------------------------------------------------
    logo = plugin.get("logo")
    suite.check("the logo is declared", bool(logo))
    suite.check("the logo exists", os.path.isfile(os.path.join(ROOT, logo or "")))
    if logo and os.path.isfile(os.path.join(ROOT, logo)):
        if logo.lower().endswith(".svg"):
            svg = read(logo)
            suite.check("the logo is an svg", svg.lstrip().startswith("<svg"))
            box = re.search(r'viewBox="([\d.\s-]+)"', svg)
            if box:
                parts = [float(value) for value in box.group(1).split()]
                suite.equal("the logo viewBox is square", parts[2], parts[3])
            suite.check("the logo carries a title for screen readers", "<title" in svg)
        else:
            # A raster logo must not be decoded as text; only its signature is checkable.
            with io.open(os.path.join(ROOT, logo), "rb") as handle:
                signature = handle.read(8)
            suite.check("the logo is a png", signature.startswith(b"\x89PNG"))

    # --- mcp.json ---------------------------------------------------------
    mcp = load("mcp.json")
    servers = mcp.get("mcpServers") or {}
    suite.check("at least one MCP server is declared", servers)
    for name, server in servers.items():
        suite.check("%s declares a command" % name, bool(server.get("command")))
        args = server.get("args") or []
        suite.check("%s points at the server script" % name,
                    any("mcp_server.py" in str(arg) for arg in args), args)
        suite.check("%s resolves the script from the plugin root" % name,
                    any("${PLUGIN_ROOT}" in str(arg) for arg in args), args)
        env = server.get("env") or {}
        suite.check("%s stores data under PLUGIN_DATA" % name,
                    any("${PLUGIN_DATA}" in str(value) for value in env.values()), env)
        suite.check("%s does not redefine the host placeholders" % name,
                    not ({"PLUGIN_ROOT", "PLUGIN_DATA"} & set(env)))
        suite.check("%s forces utf-8 output" % name,
                    env.get("PYTHONIOENCODING") == "utf-8", env)
    suite.check("mcp.json carries no absolute paths",
                not re.search(r'"(/[^"$]*)"', json.dumps(mcp)), json.dumps(mcp)[:200])

    # --- mcp_config.json (installed Windows copy) -------------------------
    if os.name == "nt" and os.path.isfile(os.path.join(ROOT, "mcp_config.json")):
        config = load("mcp_config.json")
        servers = config.get("mcpServers") or {}
        suite.check("mcp_config declares the computer-use server", "computer-use" in servers,
                    sorted(servers))
        server = servers.get("computer-use") or {}
        command = str(server.get("command") or "")
        args = [str(arg) for arg in server.get("args") or []]
        env = server.get("env") or {}
        suite.check("mcp_config pins an absolute python.exe",
                    os.path.isabs(command) and command.lower().endswith("python.exe"), command)
        suite.check("mcp_config pins the absolute server script",
                    any(os.path.isabs(arg) and arg.endswith("mcp_server.py") for arg in args), args)
        suite.check("mcp_config stores policy under the memory dir",
                    str(env.get("CU_POLICY_PATH") or "").lower().endswith("policy.json"), env)
        suite.check("mcp_config forces utf-8", env.get("PYTHONIOENCODING") == "utf-8", env)

    # --- hooks.json -------------------------------------------------------
    hooks = load("hooks.json")
    suite.check("hooks.json declares named groups", hooks)
    for group, body in hooks.items():
        suite.check("%s is an object" % group, isinstance(body, dict))
        events = [key for key in body if key.endswith("ToolUse")]
        suite.check("%s declares a tool-use event" % group, events, list(body))
        for event in events:
            entries = body[event]
            suite.check("%s.%s is a list" % (group, event), isinstance(entries, list))
            for entry in entries:
                suite.check("the entry has a matcher", isinstance(entry.get("matcher"), str), entry)
                handlers = entry.get("hooks") or []
                suite.check("the entry has handlers", bool(handlers), entry)
                for handler in handlers:
                    suite.equal("the handler is a command", handler.get("type"), "command")
                    command = handler.get("command", "")
                    # An installed Windows copy must pin the interpreter and
                    # the hook script absolutely (the caller's directory is
                    # not guaranteed); the portable source tree keeps the
                    # relative form. Both are accepted, nothing else is.
                    normalized = command.replace("\\", "/")
                    absolute = re.match(
                        r'^"?([A-Za-z]:/[^"]+?\.exe)"?\s+(?:-X\s+\S+\s+)?"?([A-Za-z]:/[^"]+?\.py)"?',
                        normalized,
                    )
                    suite.check("the command is self-contained",
                                "./scripts/" in normalized or absolute, command)
                    suite.check("the command avoids host placeholders", "${PLUGIN_ROOT}" not in command, command)
                    suite.check("the command does not depend on the caller's directory",
                                "./scripts/" in normalized or absolute, command)
                    suite.check("a timeout is set", isinstance(handler.get("timeout"), int) and handler["timeout"] > 0,
                                handler.get("timeout"))
                    if absolute:
                        suite.check("the absolute interpreter exists", os.path.isfile(absolute.group(1)),
                                    absolute.group(1))
                        suite.check("the absolute hook script exists", os.path.isfile(absolute.group(2)),
                                    absolute.group(2))
                        rel = os.path.relpath(absolute.group(2), ROOT.replace("\\", "/"))
                        suite.check("the hook script lives inside the plugin",
                                    not rel.startswith(".."), rel)
                    else:
                        script = re.search(r"\./scripts/([\w./-]+\.py)", normalized)
                        if script:
                            suite.check("the hook script exists",
                                        os.path.isfile(os.path.join(ROOT, "scripts", script.group(1))),
                                        script.group(1))

    # --- skill and agent --------------------------------------------------
    skill = frontmatter(read(os.path.join(SKILL_DIR, "SKILL.md")))
    suite.equal("the skill is named after its directory", skill.get("name"), os.path.basename(SKILL_DIR))
    suite.check("the skill describes when to use it", len(skill.get("description", "")) >= 120,
                len(skill.get("description", "")))
    agent = frontmatter(read(os.path.join("agents", "desktop-operator.md")))
    suite.check("the agent has a name", bool(agent.get("name")))
    suite.check("the agent describes itself", len(agent.get("description", "")) >= 80)
    suite.equal("the agent is a subagent", agent.get("subagent"), "true")
    suite.equal("the agent is not the main agent", agent.get("mainAgent"), "false")
    suite.check("the project rules are non-empty", len(read(os.path.join("rules", "AGENTS.md")).strip()) > 200)

    # --- every promised file exists ---------------------------------------
    for name in ("README.md", "LICENSE", "plugin.json", "mcp.json", "hooks.json",
                 os.path.join("scripts", "mcp_server.py"), os.path.join("scripts", "hook_guard.py"),
                 os.path.join("scripts", "configure.py"), os.path.join("scripts", "selftest.py"),
                 os.path.join("scripts", "install.sh"), os.path.join("scripts", "install.ps1"),
                 os.path.join("scripts", "win_uia.ps1"),
                 os.path.join("scripts", "cu", "policy.py"), os.path.join("scripts", "cu", "protocol.py"),
                 os.path.join("scripts", "cu", "tools.py"), os.path.join("scripts", "cu", "imaging.py"),
                 os.path.join("scripts", "cu", "backends", "base.py"),
                 os.path.join("scripts", "cu", "backends", "windows.py"),
                 os.path.join("scripts", "cu", "backends", "macos.py"),
                 os.path.join("scripts", "cu", "backends", "linux.py"),
                 os.path.join("scripts", "cu", "backends", "fake.py")):
        suite.check("%s is present" % name, os.path.isfile(os.path.join(ROOT, name)))
    suite.check("the licence is not a placeholder", len(read("LICENSE").strip()) > 400)

    # --- what would actually be shipped -----------------------------------
    # Asserting on the package contents rather than on the working tree: the
    # suite itself imports the plugin, and a bytecode cache must never be able
    # to reach a release regardless of what the tree looks like.
    shipped = package.collect(ROOT)
    suite.check("the package includes the test suite",
                any(name.startswith(os.path.join("scripts", "tests")) for name in shipped))
    suite.check("the package includes the self test and the packager",
                all(name in shipped for name in
                    (os.path.join("scripts", "selftest.py"), os.path.join("scripts", "package.py"))))
    suite.check("the package includes the backends",
                all(any(name.endswith(backend) for name in shipped) for backend in
                    ("windows.py", "macos.py", "linux.py", "fake.py")))
    suite.check("no bytecode is packaged",
                not [name for name in shipped if "__pycache__" in name or name.endswith((".pyc", ".pyo"))],
                [name for name in shipped if "__pycache__" in name][:3])
    suite.check("no editor leftovers are packaged",
                not [name for name in shipped if name.endswith((".swp", ".orig", ".rej", ".DS_Store"))])
    suite.check("every packaged path is relative",
                all(not os.path.isabs(name) and ".." not in name.split(os.sep) for name in shipped),
                [name for name in shipped if os.path.isabs(name)][:3])
    suite.check("the packaging rules mark scripts executable",
                package.mode_for("scripts/mcp_server.py") == 0o755
                and package.mode_for("scripts/cu/policy.py") == 0o755
                and package.mode_for("scripts/install.sh") == 0o755
                and package.mode_for("plugin.json") == 0o644
                and package.mode_for("README.md") == 0o644)
    suite.check("packaging is deterministic",
                package.collect(ROOT) == sorted(package.collect(ROOT), key=lambda name: (name.count(os.sep), name))
                or len(set(package.collect(ROOT))) == len(package.collect(ROOT)))
    suite.check("the packaged set has no duplicates", len(set(shipped)) == len(shipped))

    broken = []
    for base, dirs, files in os.walk(os.path.join(ROOT, "scripts")):
        if "__pycache__" in base:
            continue
        for name in files:
            if not name.endswith(".py"):
                continue
            path = os.path.join(base, name)
            try:
                compile(read(os.path.relpath(path, ROOT)), path, "exec")
            except SyntaxError as exc:
                broken.append("%s: %s" % (name, exc))
    suite.check("every script compiles", not broken, broken)

    # --- the readme documents what exists ---------------------------------
    readme = read("README.md")
    missing = [tool for tool in sorted(KNOWN_TOOLS) if tool not in readme]
    suite.check("the readme documents every tool", not missing, missing)
    suite.check("the readme explains the virtual desktop mode", "CU_BACKEND" in readme)
    suite.check("the readme explains how to run the tests", "tests" in readme)
    suite.check("the readme mentions the policy file", "policy.json" in readme)
    suite.check("the readme states the interpreter requirement", "python" in readme.lower())

    return suite.finish()
