#!/usr/bin/env python3
"""stdio entry point for the computer-use MCP server.

Run by Antigravity as a local MCP server:

    python3 scripts/mcp_server.py

Everything the server prints on stdout is a JSON-RPC message; diagnostics go
to stderr so the protocol stream stays clean.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cu import __version__  # noqa: E402
from cu.backends import get_backend  # noqa: E402
from cu.overlay import OverlayBridge, overlay_available, overlay_enabled  # noqa: E402
from cu.policy import Policy  # noqa: E402
from cu.protocol import StdioMCPServer  # noqa: E402
from cu.tools import DEFAULT_MAX_WIDTH, Toolset  # noqa: E402

INSTRUCTIONS = """\
This server gives you eyes and hands on the user's desktop: window inventory,
the accessibility tree, screenshots, mouse and keyboard synthesis, the
clipboard and application launching.

Working order, cheapest first:
1. If an MCP server, a CLI or a shell command can do the job, use that.
2. For a web page, prefer the browser tools over synthesised input.
3. Use ui_tree or find_elements before a screenshot: element rectangles are
   exact, while screenshots force you to estimate coordinates.
4. Only reach for raw click/type_text when nothing else can express the action.

Rules that keep this safe and predictable:
- Call get_environment first to learn the platform, screen geometry and the
  active policy, and to find out whether the accessibility tree is available.
- Focus the target window before typing; keystrokes go to whatever has focus.
- Act, then verify with a fresh screenshot or ui_tree before the next action.
- Never type into a password field, and never work around a policy refusal.
  If a tool is blocked, tell the user which policy rule blocked it and stop.
- Screen coordinates are absolute desktop coordinates. When a screenshot says
  it was downscaled, convert image coordinates back to screen coordinates
  with the factor it reports.
"""


def _build_overlay(backend, policy):
    """The visible indicator, or None when it would be pointless.

    The virtual desktop (``CU_BACKEND=fake``) touches nothing real, so it must
    not open windows on the user's screen; the same goes for platforms without
    the Win32 layered-window host. A broken overlay is silently skipped: it is
    a courtesy, never a precondition for controlling the machine.
    """
    try:
        if backend.capabilities().get("virtual"):
            return None
        if not overlay_available() or not overlay_enabled(policy):
            return None
        return OverlayBridge(data_dir=policy.data_dir)
    except Exception:  # noqa: BLE001 - never stop the server over a decoration
        return None


def main():
    policy = Policy.from_env()
    policy.ensure_file()
    max_width = int(os.environ.get("CU_MAX_WIDTH") or DEFAULT_MAX_WIDTH)
    backend = get_backend()
    overlay = _build_overlay(backend, policy)
    toolset = Toolset(backend, policy, max_width=max_width, overlay=overlay)

    def call_tool(name, arguments):
        """Adapt a tool result to the MCP tools/call result shape."""
        result = toolset.call(name, arguments)
        content = []
        if result.get("text"):
            content.append({"type": "text", "text": result["text"]})
        for image in result.get("images", []):
            content.append(
                {"type": "image", "data": image["data"], "mimeType": image["mime"]}
            )
        if not content:
            content.append({"type": "text", "text": "(no output)"})
        return {"content": content, "isError": bool(result.get("isError"))}

    server = StdioMCPServer(
        "computer-use",
        __version__,
        toolset.list_tools,
        call_tool,
        INSTRUCTIONS,
    )
    try:
        return server.serve()
    finally:
        # Closing the socket is what removes the overlay: the host fades out
        # and exits as soon as its last client is gone, so a server restarted
        # by the host never leaves a stale banner behind.
        if overlay is not None:
            overlay.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
    except Exception as exc:  # pragma: no cover - last-resort diagnostics
        sys.stderr.write("computer-use server failed: %s\n" % exc)
        sys.exit(1)
