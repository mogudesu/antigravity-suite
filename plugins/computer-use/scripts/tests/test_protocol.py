"""JSON-RPC / MCP protocol behaviour, in process and over a real stdio pipe."""

import json
import os
import sys

from .helpers import MCPClient, Suite, temp_dir

from cu.protocol import (
    INVALID_PARAMS,
    INVALID_REQUEST,
    INTERNAL_ERROR,
    METHOD_NOT_FOUND,
    PARSE_ERROR,
    StdioMCPServer,
    ToolError,
)

TOOLS = [
    {"name": "ping_tool", "description": "d" * 60,
     "inputSchema": {"type": "object", "properties": {}, "required": []}},
]


def make_server(call_tool=None):
    sent = []

    class Server(StdioMCPServer):
        def _send(self, message):
            sent.append(message)

    def default_call(name, arguments):
        if name == "boom":
            raise RuntimeError("kaboom")
        if name == "bad":
            raise ToolError("bad parameters")
        return {"content": [{"type": "text", "text": "ok:%s" % name}], "isError": False}

    server = Server("computer-use", "9.9.9", lambda: TOOLS, call_tool or default_call, "server instructions")
    return server, sent


def run():
    suite = Suite("protocol")

    # --- in-process request handling -------------------------------------
    server, sent = make_server()
    server._handle({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                    "params": {"protocolVersion": "2025-06-18", "capabilities": {}}})
    init = sent[-1]
    suite.equal("initialize replies on the same id", init["id"], 1)
    suite.equal("initialize sets jsonrpc 2.0", init["jsonrpc"], "2.0")
    suite.equal("initialize echoes the protocol version", init["result"]["protocolVersion"], "2025-06-18")
    suite.equal("initialize names the server", init["result"]["serverInfo"]["name"], "computer-use")
    suite.equal("initialize reports the version", init["result"]["serverInfo"]["version"], "9.9.9")
    suite.check("initialize advertises the tools capability", "tools" in init["result"]["capabilities"])
    suite.equal("initialize passes instructions through", init["result"]["instructions"], "server instructions")
    suite.check("a result reply has no error key", "error" not in init)

    server._handle({"jsonrpc": "2.0", "id": 2, "method": "ping"})
    suite.equal("ping returns an empty result", sent[-1]["result"], {})

    server._handle({"jsonrpc": "2.0", "id": 3, "method": "tools/list"})
    suite.equal("tools/list returns the catalogue", sent[-1]["result"]["tools"], TOOLS)

    server._handle({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                    "params": {"name": "hello", "arguments": {"a": 1}}})
    suite.equal("tools/call returns the handler payload", sent[-1]["result"]["content"][0]["text"], "ok:hello")

    server._handle({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"arguments": {}}})
    suite.equal("tools/call without a name is invalid params", sent[-1]["error"]["code"], INVALID_PARAMS)

    server._handle({"jsonrpc": "2.0", "id": 6, "method": "tools/call",
                    "params": {"name": "hello", "arguments": [1, 2]}})
    suite.equal("tools/call with list arguments is rejected", sent[-1]["error"]["code"], INVALID_PARAMS)

    server._handle({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "bad"}})
    suite.equal("a ToolError becomes invalid params", sent[-1]["error"]["code"], INVALID_PARAMS)
    suite.equal("the ToolError message survives", sent[-1]["error"]["message"], "bad parameters")

    server._handle({"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"name": "boom"}})
    suite.equal("an unexpected exception becomes an internal error", sent[-1]["error"]["code"], INTERNAL_ERROR)
    suite.check("the internal error carries a traceback hint", "data" in sent[-1]["error"])

    server._handle({"jsonrpc": "2.0", "id": 9, "method": "no/such/method"})
    suite.equal("an unknown method is reported", sent[-1]["error"]["code"], METHOD_NOT_FOUND)

    server._handle({"jsonrpc": "2.0", "id": 0, "method": "ping"})
    suite.check("id 0 is treated as a real request", sent[-1].get("id") == 0 and "result" in sent[-1])

    before = len(sent)
    server._handle({"jsonrpc": "2.0", "method": "notifications/initialized"})
    server._handle({"jsonrpc": "2.0", "method": "no/such/notification"})
    suite.equal("notifications produce no reply", len(sent), before)

    server._handle("not a request")
    suite.equal("a non-object message is an invalid request", sent[-1]["error"]["code"], INVALID_REQUEST)

    server._handle({"jsonrpc": "2.0", "id": 11, "method": "resources/list"})
    suite.equal("resources/list is empty but valid", sent[-1]["result"]["resources"], [])
    server._handle({"jsonrpc": "2.0", "id": 12, "method": "prompts/list"})
    suite.equal("prompts/list is empty but valid", sent[-1]["result"]["prompts"], [])

    server._handle({"jsonrpc": "2.0", "id": 13, "method": "tools/call", "params": {"name": "hello"}})
    suite.equal("missing arguments default to an empty object",
                sent[-1]["result"]["content"][0]["text"], "ok:hello")

    # --- over a real stdio pipe ------------------------------------------
    work = temp_dir()
    client = MCPClient(env={"CU_BACKEND": "fake", "CU_DATA_DIR": work})
    client.initialize()
    suite.equal("handshake over stdio", client.send("ping")["result"], {})

    listing = client.send("tools/list")["result"]["tools"]
    suite.equal("the real catalogue has 15 tools", len(listing), 15)
    suite.check("the real catalogue is namespaced for Antigravity",
                all(tool["name"] and " " not in tool["name"] for tool in listing))

    batch = json.dumps([
        {"jsonrpc": "2.0", "id": 101, "method": "ping"},
        {"jsonrpc": "2.0", "id": 102, "method": "tools/list"},
    ])
    client.write_raw(batch)
    first = json.loads(client.read_line())
    second = json.loads(client.read_line())
    suite.check("a batch is answered per request",
                {first.get("id"), second.get("id")} == {101, 102},
                "%s %s" % (first.get("id"), second.get("id")))

    broken = client.send_raw("{not json")
    suite.equal("invalid JSON is a parse error", broken["error"]["code"], PARSE_ERROR)

    # a blank line must be skipped without a reply: prove it by following it
    # with a real request and reading exactly one line back
    client.write_raw("   ")
    client.write_raw(json.dumps({"jsonrpc": "2.0", "id": 201, "method": "ping"}))
    suite.equal("a blank line is ignored rather than answered", json.loads(client.read_line()).get("id"), 201)
    client.write_raw("")
    client.write_raw(json.dumps({"jsonrpc": "2.0", "id": 202, "method": "ping"}))
    suite.equal("an empty line is also ignored", json.loads(client.read_line()).get("id"), 202)

    huge = "x" * 200000
    response = client.call("type_text", {"text": huge})
    suite.check("a 200 KB argument is handled", not client.is_error(response), client.text(response)[:120])

    unicode_response = client.call("open_app", {"target": "https://example.com/\u4e2d\u6587"})
    suite.check("unicode arguments survive the round trip", not client.is_error(unicode_response),
                client.text(unicode_response)[:120])

    env = client.send("tools/call", {"name": "get_environment", "arguments": {}})
    payload = json.loads(client.text(env))
    suite.equal("the server reports the fake backend", payload["capabilities"]["platform"], "fake")
    suite.check("the environment reply is one valid JSON text block",
                isinstance(payload, dict) and "policy" in payload)
    client.close()

    return suite.finish()
