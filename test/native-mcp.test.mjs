import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, lstatSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { serveStdio } from '../../ai-agent-msg-broker/reference/mcp-stdio.mjs';
import { createNativeMcp, evaluateNativeHook, OUTBOUND_TOOLS } from '../src/native-mcp.mjs';

async function fixture(t) {
  const calls = [], adapter = { session: { state: 'idle', nativeSessionId: 'root-native-uuid' }, tools: Object.fromEntries(OUTBOUND_TOOLS.map(name => [name, async args => { calls.push({ name, args }); return { ok: true }; }])) };
  const bridge = await createNativeMcp({ reference: { serveStdio }, adapterRoot: resolve('.'), workspaceDirectory: resolve('.'), getAdapter: () => adapter });
  t.after(() => bridge.close()); return { bridge, adapter, calls };
}
async function connect(t, bridge) {
  const child = spawn(process.execPath, ['bin/mcp-proxy.mjs', bridge.socketPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.stdin.end(); if (child.exitCode === null) child.kill('SIGTERM'); });
  let buffer = '', sequence = 1; const pending = new Map();
  child.stdout.on('data', chunk => { buffer += chunk; while (buffer.includes('\n')) { const index = buffer.indexOf('\n'), frame = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); pending.get(frame.id)?.(frame); pending.delete(frame.id); } });
  child.stderr.resume();
  const ask = (method, params) => new Promise(resolve => { const id = sequence++; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  await ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic-agy', version: '0.0.0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return { child, ask, tool: async name => JSON.parse((await ask('tools/call', { name, arguments: {} })).result.content[0].text) };
}

test('private disposable workspace uses documented MCP/hook config without permission changes', async t => {
  const { bridge } = await fixture(t);
  assert.equal(lstatSync(bridge.directory).mode & 0o077, 0); assert(Buffer.byteLength(bridge.socketPath) < 104);
  const mcp = JSON.parse(readFileSync(join(bridge.workspace, '.agents/mcp_config.json')));
  assert.deepEqual(mcp.mcpServers.lan_broker.enabledTools, OUTBOUND_TOOLS);
  assert.deepEqual(bridge.args, ['--add-dir', resolve('.')]);
  const hooks = JSON.parse(readFileSync(join(bridge.workspace, '.agents/hooks.json')));
  const command = hooks['lan-broker-exact-session'].PreToolUse[0].hooks[0].command;
  assert.equal(command.includes('auto_approve'), false); assert.equal(command.includes('permissionOverrides'), false);
  assert.deepEqual(evaluateNativeHook(bridge.directory, { conversationId: 'root-native-uuid', toolCall: { name: 'broker_send' } }).decision, 'deny');
  bridge.bind('root-native-uuid');
  assert.deepEqual(evaluateNativeHook(bridge.directory, { conversationId: 'root-native-uuid', toolCall: { name: 'broker_send' } }), { decision: 'allow' });
  assert.equal(evaluateNativeHook(bridge.directory, { conversationId: 'subagent', toolCall: { name: 'broker_send' } }).decision, 'deny');
  // The generated shell command contains only quoted trusted executable/paths.
  const hook = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; hook.stdout.on('data', chunk => { output += chunk; }); hook.stdin.end(JSON.stringify({ conversationId: 'subagent', toolCall: { name: 'broker_send' } }));
  await new Promise(resolve => hook.once('exit', resolve)); assert.equal(JSON.parse(output).decision, 'deny');
  await bridge.close(); assert.equal(existsSync(bridge.directory), false);
});

test('actual stdio proxy routes outbound tools to one owner, rejects unbound/receive/stale session', { timeout: 10000 }, async t => {
  const f = await fixture(t), peer = await connect(t, f.bridge);
  assert.equal((await peer.tool('broker_list_clients')).error.code, 'session_binding_unavailable');
  f.bridge.bind('root-native-uuid'); assert.equal((await peer.tool('broker_list_clients')).ok, true); assert.equal(f.calls.length, 1);
  assert.equal((await peer.tool('broker_receive')).error.code, 'session_binding_unavailable');
  const second = createConnection(f.bridge.socketPath); const closed = new Promise(resolve => second.once('close', resolve)); second.on('error', () => {}); await closed;
  f.adapter.session.nativeSessionId = 'replacement'; assert.equal((await peer.tool('broker_list_clients')).error.code, 'session_binding_unavailable'); assert.equal(f.calls.length, 1);
  const ended = new Promise(resolve => peer.child.once('exit', resolve)); await f.bridge.close(); await ended;
  assert.equal(existsSync(f.bridge.directory), false);
});


test('existing project policy fails closed instead of being silently omitted by changed cwd', async t => {
  for (const name of ['.agents', 'AGENTS.md', 'GEMINI.md']) {
    const project = mkdtempSync(join(tmpdir(), 'agy-existing-policy-'));
    t.after(() => rmSync(project, { recursive: true, force: true }));
    if (name === '.agents') mkdirSync(join(project, name)); else writeFileSync(join(project, name), 'Keep existing project rules');
    await assert.rejects(createNativeMcp({ reference: { serveStdio }, adapterRoot: resolve('.'), workspaceDirectory: project,
      getAdapter: () => null }), /project_policy_requires_native_workspace_review/);
  }
});
