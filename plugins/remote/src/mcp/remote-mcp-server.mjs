#!/usr/bin/env node
/**
 * ag-remote-mcp：让 Agent 在远程 IM 会话里主动把文件 / 消息发回聊天。
 *
 * 传输：stdio 上的 MCP（JSON-RPC 2.0），工具调用转成对守护进程 HTTP API 的请求。
 * 环境变量：AG_REMOTE_API（默认 http://127.0.0.1:8791）
 */
import readline from 'node:readline';

const API = process.env.AG_REMOTE_API || 'http://127.0.0.1:8791';
const SERVER_INFO = { name: 'antigravity-remote-mogu', version: '2.0.0' };

const TOOLS = [
  {
    name: 'remote_send_file',
    description: '把本地文件发回远程 IM 聊天（图片按图片气泡发送）。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '绑定 ID、平台:chat_id，或 last（最近一条远程消息来源）' },
        path: { type: 'string', description: '本地文件绝对路径' },
        caption: { type: 'string', description: '可选说明文字' },
      },
      required: ['path'],
    },
  },
  {
    name: 'remote_send_message',
    description: '给远程 IM 聊天发一条文本消息。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '绑定 ID、平台:chat_id，或 last' },
        text: { type: 'string', description: '要发送的文本' },
      },
      required: ['text'],
    },
  },
  {
    name: 'remote_list_targets',
    description: '列出当前可用的远程聊天目标（绑定关系）。',
    inputSchema: { type: 'object', properties: {} },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, message) {
  send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
}

async function callApi(path, options = {}) {
  const res = await fetch(API + path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function handleToolCall(name, args) {
  if (name === 'remote_list_targets') {
    const data = await callApi('/api/state');
    const lines = (data.bindings || []).map((item) => `${item.key} → ${item.title || item.conversationId}`);
    return { content: [{ type: 'text', text: lines.length ? lines.join('\n') : '还没有绑定任何远程聊天。' }] };
  }
  if (name === 'remote_send_message') {
    const data = await callApi('/api/send', { method: 'POST', body: { target: args.target || 'last', text: args.text } });
    return { content: [{ type: 'text', text: `已发送到 ${data.chatId || args.target || 'last'}` }] };
  }
  if (name === 'remote_send_file') {
    const data = await callApi('/api/send', {
      method: 'POST',
      body: { target: args.target || 'last', file: args.path, text: args.caption || '' },
    });
    return { content: [{ type: 'text', text: data.delivered ? `已发送文件：${args.path}` : `文件已登记，但当前渠道暂不支持直传：${args.path}` }] };
  }
  throw new Error(`未知工具：${name}`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  const { id, method, params } = message;

  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'tools/list') return ok(id, { tools: TOOLS });
  if (method === 'notifications/initialized') return undefined;
  if (method === 'tools/call') {
    try {
      const result = await handleToolCall(params?.name, params?.arguments || {});
      return ok(id, result);
    } catch (error) {
      return fail(id, error?.message || String(error));
    }
  }
  if (method === 'ping') return ok(id, {});
  return fail(id, `不支持的方法：${method}`);
});

process.on('SIGINT', () => process.exit(0));
