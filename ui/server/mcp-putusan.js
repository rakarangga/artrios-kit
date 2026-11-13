#!/usr/bin/env node
// MCP server (stdio) for the Putusan queue, started by chat-service for each chat (PRD Cognition T9-T10, §11).
// Tools: putusan_list (what is open or decided for this workspace) and putusan_ask (one case per key; reasked, old
// answer, or a new item). The queue file is written through inbox-service, the same single writer the UI uses.
// Usage: node mcp-putusan.js --inbox <file> --workspace <key> [--session <id>]
import { parseArgs } from 'node:util';
import { createInboxService } from './inbox-service.js';
import { createPutusanTools, PUTUSAN_TOOLS as TOOLS } from './putusan-tools.js';

const { values } = parseArgs({ options: { inbox: { type: 'string' }, workspace: { type: 'string' }, session: { type: 'string' } } });
if (!values.inbox || !values.workspace) { process.stderr.write('usage: mcp-putusan.js --inbox FILE --workspace KEY [--session ID]\n'); process.exit(2); }
const tools = createPutusanTools({ inbox: createInboxService({ file: values.inbox }), workspace: values.workspace, session: values.session ?? null });
const call = (name, args) => tools.call(name, args);

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (initialized, cancelled) need no answer
  try {
    if (method === 'initialize') return out({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'artrios-putusan', version: '0.1.0' } } });
    if (method === 'ping') return out({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return out({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      try {
        const r = call(params?.name, params?.arguments ?? {});
        return out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] } });
      } catch (e) {
        return out({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: e.message }] } });
      }
    }
    return out({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (e) {
    return out({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
