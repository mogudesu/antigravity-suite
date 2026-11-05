"use strict";

const crypto = require("crypto");
const http = require("http");
const { WebSocketServer } = require("ws");

const MARKER = "antigravity-browser-bridge";
const PROTOCOL_VERSION = "1.0";
const HEARTBEAT_MS = 15000;
const MAX_RPC_BODY = 4 * 1024 * 1024;

class BridgeError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    if (extra && typeof extra === "object") Object.assign(this, extra);
  }
}

/**
 * 本地桥接中心：同一个 127.0.0.1:<port> 上同时提供
 *   - WebSocket /bridge：浏览器扩展长连接
 *   - GET  /status：Leader 自述（供 Follower 识别「端口上是自己人」）
 *   - POST /rpc：Follower -> Leader 的本地工具中继（校验 x-ag-token）
 * 这样多开 Antigravity 会话时，只有第一个进程真正监听端口，其余进程走 HTTP 中继。
 */
class Bridge {
  constructor(opts = {}) {
    this.host = opts.host || "127.0.0.1";
    this.port = Number(opts.port || 8765);
    this.token = opts.token || "";
    this.log = opts.log || (() => {});
    this.onChange = opts.onChange || (() => {});
    this.onRecordDone = opts.onRecordDone || (() => {});
    this.onToolCall = opts.onToolCall || null;
    this.clients = new Map(); // ws -> client
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.wss = null;
    this.httpServer = null;
    this.heartbeat = null;
    this.started = false;
    this.startedAt = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      if (this.started) return resolve(this);

      const server = http.createServer((req, res) => this.onHttp(req, res));
      const wss = new WebSocketServer({ noServer: true });
      this.httpServer = server;
      this.wss = wss;
      let settled = false;

      const fail = (err) => {
        if (settled) {
          this.log("HTTP 服务错误：" + err.message);
          return;
        }
        settled = true;
        this.started = false;
        try { wss.close(); } catch (e) { /* ignore */ }
        try { server.close(); } catch (e) { /* ignore */ }
        if (this.httpServer === server) this.httpServer = null;
        if (this.wss === wss) this.wss = null;
        reject(new BridgeError("LISTEN_FAILED", `无法监听 ${this.host}:${this.port}：${err.message}`, { sysCode: err.code }));
      };

      server.on("error", fail);
      server.on("upgrade", (req, socket, head) => {
        let pathname = "";
        try { pathname = new URL(req.url || "/", "http://127.0.0.1").pathname; } catch (e) { pathname = ""; }
        if (pathname !== "/bridge") {
          try {
            socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
          } catch (e) { /* ignore */ }
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      });
      wss.on("connection", (ws) => this.onConnection(ws));

      server.listen(this.port, this.host, () => {
        if (settled) return;
        settled = true;
        this.started = true;
        this.startedAt = Date.now();
        this.heartbeat = setInterval(() => this.tick(), HEARTBEAT_MS);
        if (this.heartbeat.unref) this.heartbeat.unref();
        this.log(`桥接已监听 http://${this.host}:${this.port}（WS /bridge · GET /status · POST /rpc）`);
        resolve(this);
      });
    });
  }

  stop() {
    this.started = false;
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new BridgeError("SHUTDOWN", "服务正在关闭")); }
    this.pending.clear();
    for (const [ws] of this.clients) { try { ws.terminate(); } catch (e) { /* ignore */ } }
    this.clients.clear();
    const wss = this.wss;
    this.wss = null;
    if (wss) { try { wss.close(); } catch (e) { /* ignore */ } }
    const server = this.httpServer;
    this.httpServer = null;
    if (server) {
      try { if (server.closeAllConnections) server.closeAllConnections(); } catch (e) { /* ignore */ }
      try { server.close(); } catch (e) { /* ignore */ }
    }
  }

  /** 供 GET /status 使用：只暴露排障需要的字段，不含令牌。 */
  status() {
    return {
      server: MARKER,
      protocol: PROTOCOL_VERSION,
      role: "leader",
      pid: process.pid,
      host: this.host,
      port: this.port,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      tokenRequired: !!this.token,
      clients: this.list(),
    };
  }

  onHttp(req, res) {
    const remote = req.socket.remoteAddress || "";
    if (!isLoopback(remote)) {
      return this.sendJson(res, 403, { ok: false, code: "FORBIDDEN", error: "只接受本机回环地址的请求" });
    }
    let url;
    try { url = new URL(req.url || "/", "http://127.0.0.1"); } catch (e) {
      return this.sendJson(res, 400, { ok: false, code: "BAD_REQUEST", error: "非法 URL" });
    }
    if (req.method === "GET" && url.pathname === "/status") {
      return this.sendJson(res, 200, this.status());
    }
    if (req.method === "POST" && url.pathname === "/rpc") {
      return this.onRpc(req, res);
    }
    return this.sendJson(res, 404, {
      ok: false,
      code: "NOT_FOUND",
      error: `未知接口：${req.method} ${url.pathname}（可用：GET /status、POST /rpc、WS /bridge）`,
    });
  }

  onRpc(req, res) {
    // 浏览器页面无法伪造这个组合：带 Origin 的跨域请求一律拒绝，且要求 JSON Content-Type（会触发预检）。
    if (req.headers.origin) {
      return this.sendJson(res, 403, { ok: false, code: "FORBIDDEN", error: "不接受带 Origin 的跨域请求" });
    }
    if (this.token && String(req.headers["x-ag-token"] || "") !== this.token) {
      return this.sendJson(res, 401, { ok: false, code: "UNAUTHORIZED", error: "x-ag-token 不匹配" });
    }
    if (String(req.headers["content-type"] || "").toLowerCase().indexOf("application/json") === -1) {
      return this.sendJson(res, 415, { ok: false, code: "UNSUPPORTED_MEDIA_TYPE", error: "POST /rpc 需要 Content-Type: application/json" });
    }

    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_RPC_BODY) {
        aborted = true;
        this.sendJson(res, 413, { ok: false, code: "PAYLOAD_TOO_LARGE", error: "RPC 请求体超过 4MB" });
        try { req.destroy(); } catch (e) { /* ignore */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => { aborted = true; });
    req.on("end", () => {
      if (aborted) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) {
        return this.sendJson(res, 400, { ok: false, code: "BAD_JSON", error: "请求体不是合法 JSON" });
      }
      if (!body || typeof body.tool !== "string" || !body.tool) {
        return this.sendJson(res, 400, { ok: false, code: "BAD_REQUEST", error: "缺少 tool 字段" });
      }
      if (body.tool === "browser_launch") {
        return this.sendJson(res, 400, { ok: false, code: "LOCAL_ONLY", error: "browser_launch 由各 MCP 进程本地执行，不经过 Leader 中继" });
      }
      const args = body.args && typeof body.args === "object" ? body.args : {};
      const timeoutMs = Number(body.timeoutMs);
      const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000;
      const runner = typeof this.onToolCall === "function"
        ? this.onToolCall(body.tool, args, effectiveTimeout)
        : this.call(body.tool, args, effectiveTimeout);
      runner
        .then((result) => this.sendJson(res, 200, { ok: true, result }))
        .catch((e) => this.sendJson(res, 200, {
          ok: false,
          code: (e && e.code) || "ERROR",
          error: (e && e.message) || String(e),
        }));
    });
  }

  sendJson(res, status, obj) {
    if (!res || res.writableEnded) return;
    let payload;
    try { payload = Buffer.from(JSON.stringify(obj)); } catch (e) {
      status = 500;
      payload = Buffer.from(JSON.stringify({ ok: false, code: "SERIALIZE_FAILED", error: e.message }));
    }
    try {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": payload.length,
        "Cache-Control": "no-store",
      });
      res.end(payload);
    } catch (e) { /* ignore */ }
  }

  onConnection(ws) {
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch (e) { return; }

      if (msg.t === "hello") {
        if (this.token && msg.token !== this.token) {
          this.log("拒绝一个扩展连接：令牌不匹配");
          try { ws.send(JSON.stringify({ t: "error", message: "访问令牌不匹配，请把扩展弹窗里的令牌改成与服务一致" })); } catch (e) { /* ignore */ }
          try { ws.close(); } catch (e) { /* ignore */ }
          return;
        }
        const client = {
          ws,
          browser: msg.browser || "unknown",
          version: msg.version || "?",
          ua: msg.ua || "",
          connectedAt: Date.now(),
        };
        this.clients.set(ws, client);
        try { ws.send(JSON.stringify({ t: "welcome", browser: client.browser, server: MARKER })); } catch (e) { /* ignore */ }
        this.log(`扩展已连接：${client.browser} v${client.version}（当前 ${this.clients.size} 个）`);
        this.onChange();
        return;
      }

      if (msg.t === "pong") { ws.isAlive = true; return; }
      if (msg.t === "ping") { try { ws.send(JSON.stringify({ t: "pong", at: Date.now() })); } catch (e) { /* ignore */ } return; }
      if (msg.t === "record_done" && msg.recording) {
        try { this.onRecordDone(msg.recording); } catch (e) { /* ignore */ }
        return;
      }

      if (msg.t === "res") {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new BridgeError("EXTENSION_ERROR", msg.error || "扩展返回失败"));
        return;
      }
    });

    ws.on("close", () => {
      const c = this.clients.get(ws);
      this.clients.delete(ws);
      if (c) this.log(`扩展断开：${c.browser} v${c.version}`);
      this.onChange();
    });

    ws.on("error", () => { /* 断连由 close 统一处理 */ });
  }

  tick() {
    for (const [ws, c] of Array.from(this.clients.entries())) {
      if (ws.isAlive === false) {
        this.clients.delete(ws);
        try { ws.terminate(); } catch (e) { /* ignore */ }
        this.log(`心跳超时，断开 ${c.browser}`);
        this.onChange();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
        ws.send(JSON.stringify({ t: "ping", at: Date.now() }));
      } catch (e) { /* ignore */ }
    }
  }

  list() {
    return Array.from(this.clients.values()).map((c) => ({
      browser: c.browser,
      version: c.version,
      connectedAt: c.connectedAt,
    }));
  }

  pick(browser) {
    const want = String(browser).toLowerCase();
    const hit = Array.from(this.clients.values()).find((c) => c.browser.toLowerCase() === want);
    if (hit) return hit;
    const avail = this.list().map((c) => c.browser).join("、") || "无";
    throw new BridgeError("NO_EXTENSION", `没有名为 ${browser} 的扩展连接（当前已连接：${avail}）`);
  }

  pickAny() {
    const all = Array.from(this.clients.values());
    if (!all.length) {
      throw new BridgeError("NO_EXTENSION", "还没有浏览器扩展连接到本地桥接服务");
    }
    all.sort((a, b) => b.connectedAt - a.connectedAt);
    return all[0];
  }

  call(tool, args, timeoutMs) {
    const a = Object.assign({}, args || {});
    const wantBrowser = a.browser;
    delete a.browser;

    const client = wantBrowser ? this.pick(wantBrowser) : this.pickAny();
    const id = crypto.randomUUID();
    const timeout = Number(timeoutMs || 30000);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError("TIMEOUT", `工具 ${tool} 在 ${timeout} ms 内没有返回（浏览器可能被弹窗、系统对话框或页面脚本阻塞）`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        client.ws.send(JSON.stringify({ t: "req", id, tool, args: a }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new BridgeError("SEND_FAILED", `向扩展发送失败：${e.message}`));
      }
    });
  }
}

function isLoopback(addr) {
  if (!addr) return false;
  if (addr === "::1" || addr === "127.0.0.1") return true;
  if (addr.indexOf("127.") === 0) return true;
  if (addr.indexOf("::ffff:127.") === 0) return true;
  return false;
}

module.exports = { Bridge, BridgeError, MARKER };
