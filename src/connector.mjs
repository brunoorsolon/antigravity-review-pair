import { join } from 'node:path';
import { Inbox, newSessionIdentity } from '../vendor/psst/reference/inbox.mjs';
import { BrokerClient } from '../vendor/psst/reference/client.mjs';
import { AdapterRuntime } from '../vendor/psst/reference/runtime.mjs';
import { createTools } from '../vendor/psst/reference/tools.mjs';
import { createCooperativeInbox } from './cooperative-inbox.mjs';
import { prepareStateRoot } from './connector-config.mjs';
import { serveStdio } from './mcp-stdio.mjs';

/** A connector process is a distinct MCP endpoint, not proof of a native conversation ID. */
export async function startConnector({ config, input = process.stdin, output = process.stdout, onDiagnostic = () => {}, signal }) {
  prepareStateRoot(config.stateRoot);
  const identity = newSessionIdentity('antigravity-cli');
  const inbox = new Inbox({ directory: join(config.stateRoot, identity.client_id), identity });
  let client;
  try { client = new BrokerClient({ url: config.brokerUrl, tokenFile: config.tokenFile, caFile: config.caFile,
    insecureDevelopment: config.insecureDevelopment === true, inbox }); } catch (error) { inbox.close(); throw error; }
  let active = true, stopping, stdio;
  const runtime = new AdapterRuntime({ client, inbox, verifySession: () => active, isAlive: () => active, onDiagnostic });
  const close = () => stopping ??= (async () => {
    active = false;
    try { await runtime.stop({ closeSession: true }); } finally { inbox.close(); }
  })();
  const departed = () => { void close(); };
  const cancelled = () => { void close(); };
  signal?.addEventListener('abort', cancelled, { once: true });
  input.once('end', departed); input.once('error', departed);
  try {
    if (signal?.aborted) throw new Error('host_departed');
    await runtime.start(config.metadata);
    if (!active || input.readableEnded || input.destroyed) throw new Error('host_departed');
    const tools = { ...createTools({ client, inbox }), ...createCooperativeInbox({ inbox, isActive: () => active }),
      async broker_identity() { return { ...identity, endpoint_scope: 'mcp_process', native_session_binding: false,
        local_mode: 'cooperative_pull', metadata: inbox.getState('metadata') }; } };
    stdio = serveStdio({ input, output, tools, onClose: close, onDiagnostic });
    return { identity, inbox, client, runtime, tools, done: stdio.done,
      async close() { await stdio.close(); await close(); input.off('end', departed); input.off('error', departed); signal?.removeEventListener('abort', cancelled); } };
  } catch (error) { await close(); input.off('end', departed); input.off('error', departed); signal?.removeEventListener('abort', cancelled); throw error; }
}
