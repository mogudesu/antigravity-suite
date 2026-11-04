"""A minimal, dependency-free Model Context Protocol server core.

Speaks the stdio transport with newline-delimited JSON-RPC 2.0 framing, which
is what MCP clients (including Antigravity) use for local servers.
"""

import json
import sys
import traceback

DEFAULT_PROTOCOL_VERSION = "2025-06-18"

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603


class ToolError(Exception):
    """Raised by tool handlers to report a clean, user-facing failure."""


class StdioMCPServer:
    def __init__(self, name, version, list_tools, call_tool, instructions=""):
        self.name = name
        self.version = version
        self._list_tools = list_tools
        self._call_tool = call_tool
        self.instructions = instructions
        self._client_protocol = DEFAULT_PROTOCOL_VERSION

    # -- transport ---------------------------------------------------------
    def _send(self, message):
        # Bytes on the wire, always UTF-8, always ASCII-escaped JSON: the
        # transport must not depend on the console encoding of whatever host
        # spawned us (a Windows console can default to a legacy code page).
        line = json.dumps(message, ensure_ascii=True) + "\n"
        buffer = getattr(sys.stdout, "buffer", None)
        if buffer is None:  # a test harness may hand us a text stream
            sys.stdout.write(line)
            sys.stdout.flush()
            return
        buffer.write(line.encode("utf-8"))
        buffer.flush()

    def _reply(self, msg_id, result):
        self._send({"jsonrpc": "2.0", "id": msg_id, "result": result})

    def _fail(self, msg_id, code, message, data=None):
        error = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        self._send({"jsonrpc": "2.0", "id": msg_id, "error": error})

    def serve(self):
        """Read requests until EOF, one JSON message per line.

        Decoding is deliberately forgiving: a single invalid byte on the wire
        (a truncated multi-byte character in a path, a stray NUL from a
        half-written pipe) must cost the client one error reply, never the
        session. Reading bytes and decoding with ``errors="replace"`` turns any
        such byte into U+FFFD, which then fails JSON parsing like any other
        malformed payload.
        """
        stream = getattr(sys.stdin, "buffer", None)
        if stream is None:  # a test harness may hand us a text stream
            for line in sys.stdin:
                self._dispatch_line(line)
            return 0
        for raw in stream:
            self._dispatch_line(raw.decode("utf-8", "replace"))
        return 0

    def _dispatch_line(self, line):
        line = line.strip()
        if not line:
            return
        try:
            message = json.loads(line)
        except ValueError:
            self._fail(None, PARSE_ERROR, "Invalid JSON payload")
            return
        if isinstance(message, list):
            for item in message:
                self._handle(item)
        else:
            self._handle(message)

    def _handle(self, message):
        if not isinstance(message, dict):
            self._fail(None, INVALID_REQUEST, "Request must be a JSON object")
            return
        method = message.get("method")
        msg_id = message.get("id")
        params = message.get("params")
        if not isinstance(params, dict):
            params = {}
        if msg_id is None and isinstance(method, str) and method.startswith("notifications/"):
            return
        handler = getattr(self, "_rpc_" + str(method or "").replace("/", "_"), None)
        if handler is None:
            if msg_id is None:
                return
            self._fail(msg_id, METHOD_NOT_FOUND, "Unknown method: %s" % method)
            return
        try:
            result = handler(params)
        except ToolError as exc:
            self._fail(msg_id, INVALID_PARAMS, str(exc))
            return
        except Exception as exc:  # pragma: no cover - defensive
            self._fail(
                msg_id,
                INTERNAL_ERROR,
                "Internal error: %s" % exc,
                traceback.format_exc(limit=3),
            )
            return
        if msg_id is None:
            return
        self._reply(msg_id, result)

    # -- methods -----------------------------------------------------------
    def _rpc_initialize(self, params):
        requested = params.get("protocolVersion") or DEFAULT_PROTOCOL_VERSION
        self._client_protocol = requested
        return {
            "protocolVersion": requested,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": self.name, "version": self.version},
            "instructions": self.instructions,
        }

    def _rpc_ping(self, params):
        return {}

    def _rpc_tools_list(self, params):
        return {"tools": self._list_tools()}

    def _rpc_tools_call(self, params):
        name = params.get("name")
        arguments = params.get("arguments")
        if not name:
            raise ToolError("Missing required parameter: name")
        if arguments is None:
            arguments = {}
        if not isinstance(arguments, dict):
            raise ToolError("Parameter 'arguments' must be an object")
        return self._call_tool(name, arguments)

    def _rpc_resources_list(self, params):
        return {"resources": []}

    def _rpc_prompts_list(self, params):
        return {"prompts": []}
