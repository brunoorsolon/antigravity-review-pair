import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, renameSync, rmSync, chmodSync, existsSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const OUTBOUND_TOOLS = Object.freeze(['broker_list_clients', 'broker_send', 'broker_update_metadata', 'broker_message_status']);
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
const write = (path, value) => { const temporary = `${path}.${randomUUID()}`; writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); };
const unavailable = () => ({ error: { code: 'session_binding_unavailable', effect: 'not_applied', retryable: false,
  message: 'The exact managed CLI session is unavailable; leave its inbox pending.' } });

/** Standard MCP frames only. This local socket bridges to the ONE journal owner. */
export async function createNativeMcp({ reference, adapterRoot, workspaceDirectory, getAdapter, node = process.execPath }) {
  if (process.platform !== 'linux' || typeof reference?.serveStdio !== 'function' || typeof getAdapter !== 'function'
    || ![adapterRoot, workspaceDirectory, node].every(path => typeof path === 'string' && isAbsolute(path) && !/[\u0000-\u001f\u007f-\u009f]/u.test(path))) throw new Error('invalid_native_mcp_configuration');
  if (!lstatSync(workspaceDirectory).isDirectory() || realpathSync(workspaceDirectory) !== workspaceDirectory) throw new Error('canonical_workspace_required');
  // A disposable cwd must not silently omit recognized project-scoped policy.
  if (['.agents', 'AGENTS.md', 'GEMINI.md'].some(name => existsSync(join(workspaceDirectory, name)))) throw new Error('project_policy_requires_native_workspace_review');
  const directory = mkdtempSync(join(tmpdir(), 'agy-broker-mcp-'));
  const workspace = join(directory, 'workspace'), agents = join(workspace, '.agents'), socketPath = join(directory, 'mcp.sock');
  mkdirSync(agents, { recursive: true, mode: 0o700 });
  let alive = true, nativeSessionId, active, connection, bound = false;
  const available = () => {
    const adapter = getAdapter();
    return alive && bound && adapter && adapter.session.state !== 'closed' && adapter.session.nativeSessionId === nativeSessionId;
  };
  const guarded = Object.fromEntries([...OUTBOUND_TOOLS, 'broker_receive'].map(name => [name, async args => {
    if (!available() || name === 'broker_receive') return unavailable();
    return getAdapter().tools[name](args);
  }]));
  const server = createServer(socket => {
    if (!alive || connection) { socket.destroy(); return; }
    connection = socket;
    socket.on('error', () => {});
    active = reference.serveStdio({ input: socket, output: socket, tools: guarded,
      onClose: () => { if (connection === socket) connection = undefined; socket.destroy(); } });
  });
  try {
    if (Buffer.byteLength(socketPath) > 100) throw new Error('private_socket_path_too_long');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    chmodSync(socketPath, 0o600);
    server.on('error', () => { alive = false; connection?.destroy(); });
    write(join(agents, 'mcp_config.json'), { mcpServers: { lan_broker: {
      command: node, args: [join(adapterRoot, 'bin/mcp-proxy.mjs'), socketPath], enabledTools: OUTBOUND_TOOLS,
    } } });
    // Match every native tool: a subagent must not borrow the main conversation's
    // MCP identity. 'allow' here delegates to normal policy, never auto_approve.
    const command = [node, join(adapterRoot, 'bin/native-hook.mjs'), directory].map(quote).join(' ');
    write(join(agents, 'hooks.json'), { 'lan-broker-exact-session': { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 5 }] }] } });
    write(join(directory, 'binding.json'), { alive: false, nativeSessionId: null });
  } catch (error) { server.close(); rmSync(directory, { recursive: true, force: true }); throw error; }
  return {
    directory, workspace, socketPath, args: ['--add-dir', workspaceDirectory],
    bind(id) {
      if (!alive || bound || typeof id !== 'string' || !id || id.length > 256) throw new Error('native_mcp_binding_unavailable');
      nativeSessionId = id; bound = true; write(join(directory, 'binding.json'), { alive: true, nativeSessionId: id });
    },
    async close() {
      if (!alive && !server.listening) return;
      alive = false; bound = false;
      try { write(join(directory, 'binding.json'), { alive: false, nativeSessionId: null }); } catch { /* Missing state also denies. */ }
      await active?.close(); connection?.destroy();
      await new Promise(resolve => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Native hook never reads transcripts or issues a human approval. */
export function evaluateNativeHook(directory, event) {
  const path = join(directory, 'binding.json'), stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 4096 || process.getuid && stat.uid !== process.getuid()) throw new Error('private_binding_required');
  const binding = JSON.parse(readFileSync(path, 'utf8'));
  if (binding.alive !== true || !binding.nativeSessionId || event?.conversationId !== binding.nativeSessionId || !event.toolCall || typeof event.toolCall.name !== 'string') {
    return { decision: 'deny', reason: 'This tool belongs to a different or unavailable managed CLI conversation.' };
  }
  // Official hook contract: allow delegates to subsequent hooks/default policy;
  // it does NOT mean auto_approve or override an Ask/Deny rule.
  return { decision: 'allow' };
}
