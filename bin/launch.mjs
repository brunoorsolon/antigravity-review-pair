import { createNativeMcp } from '../src/native-mcp.mjs';
import { verifyReference } from '../src/reference-pin.mjs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../src/config.mjs';
import { streamArguments } from '../src/managed-session.mjs';
import { createAntigravityAdapter } from '../src/adapter.mjs';

let adapter, inbox, interval, nativeMcp, active, stopPromise, closed = false, inputEnded = false, inFlightTools = 0, injectionPaused = false, outputBlocked = false;
process.stdin.pause();
process.stdin.once('end', () => { inputEnded = true; void stop(); });
process.stdin.once('error', () => { inputEnded = true; void stop(); });
const emit = value => { if (!process.stdout.destroyed && !process.stdout.write(JSON.stringify(value) + '\n')) outputBlocked = true; };
process.stdout.on('drain', () => { outputBlocked = false; });
process.stdout.on('error', () => { void stop(); });
const diagnostic = code => process.stderr.write(`${code}\n`);
const stop = () => {
  if (stopPromise) return stopPromise;
  closed = true; process.stdin.pause(); if (interval) clearInterval(interval);
  return stopPromise = Promise.resolve().then(async () => {
    await nativeMcp?.close();
    await adapter?.close();
    await active?.catch(() => {});
    inbox?.close();
  });
};
try {
  if (process.argv.length !== 3) throw new Error('usage_config_file');
  const config = readConfig(process.argv[2]);
  verifyReference(config.referenceRoot);
  const load = path => import(pathToFileURL(join(config.referenceRoot, path)).href);
  const [{ Inbox, newSessionIdentity }, { BrokerClient }, runtime, tools, stdio] = await Promise.all([
    load('reference/inbox.mjs'), load('reference/client.mjs'), load('reference/runtime.mjs'), load('reference/tools.mjs'), load('reference/mcp-stdio.mjs'),
  ]);
  const identity = newSessionIdentity('antigravity-cli');
  inbox = new Inbox({ directory: join(config.stateRoot, identity.client_id), identity });
  const client = new BrokerClient({ url: config.brokerUrl, tokenFile: config.tokenFile, caFile: config.caFile,
    insecureDevelopment: config.insecureDevelopment === true, inbox });
  if (config.nativeMcp === true) nativeMcp = await createNativeMcp({ reference: stdio,
    adapterRoot: dirname(dirname(fileURLToPath(import.meta.url))), workspaceDirectory: config.workspaceDirectory, getAdapter: () => adapter });
  const child = spawn(config.binary, [...streamArguments({ model: config.model }), ...(nativeMcp?.args ?? [])],
    { stdio: ['pipe', 'pipe', 'pipe'], shell: false, ...(nativeMcp ? { cwd: nativeMcp.workspace } : {}) });
  // Default diagnostics are bounded codes, never raw native stderr or credentials.
  let diagnosticSeen = false;
  child.stderr.on('data', () => { if (!diagnosticSeen) { diagnosticSeen = true; diagnostic('native_diagnostic_received'); } });
  adapter = createAntigravityAdapter({ reference: { ...runtime, ...tools }, child, client, inbox,
    experimentalManaged: config.experimentalManaged === true, onDiagnostic: ({ code }) => diagnostic(code) });
  adapter.session.on('response', result => emit({ event: 'response', ...result }));
  adapter.session.once('unavailable', () => { void stop(); });
  const deadline = Date.now() + 30000;
  while (adapter.session.state === 'starting' && Date.now() < deadline) await delay(25);
  if (closed || inputEnded || adapter.session.state !== 'idle') throw new Error('native_not_ready');
  await adapter.start({ name: config.name, project: config.project ?? null });
  nativeMcp?.bind(adapter.session.nativeSessionId);
  emit({ event: 'connected', client_id: identity.client_id, configured_harness_version: config.harnessVersion,
    certified: false, local_mode: config.experimentalManaged === true ? 'managed_serial_experimental' : 'unsupported' });
  interval = setInterval(() => {
    if (closed || active || injectionPaused || outputBlocked) return;
    active = adapter.runNext().catch(() => { injectionPaused = true; diagnostic('native_injection_uncertain'); })
      .finally(() => { active = undefined; });
  }, 50);
  // Local operator control, not a model-facing protocol. Native output and broker
  // message text never enter this parser. No control request can approve a tool.
  let buffer = ''; const decoder = new TextDecoder('utf-8', { fatal: true });
  process.stdin.on('data', chunk => {
    try {
      if (closed) return;
      if (chunk.length > 96 * 1024) throw new Error('input_limit');
      buffer += decoder.decode(chunk, { stream: true });
      while (!closed && buffer.includes('\n')) {
        const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (Buffer.byteLength(line) > 96 * 1024) throw new Error('input_limit');
        if (!line.trim()) continue;
        const command = JSON.parse(line);
        if (outputBlocked && command?.op !== 'close') throw new Error('output_backpressure');
        if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('invalid_control');
        if (command.op === 'human' && Object.keys(command).sort().join(',') === 'op,text' && typeof command.text === 'string' && Buffer.byteLength(command.text) <= 65536) {
          Promise.resolve(adapter.session.submitHuman(command.text)).catch(() => diagnostic('human_input_not_confirmed'));
        } else if (command.op === 'pause' && Object.keys(command).length === 1) adapter.session.pauseAfterHumanAbort();
        else if (command.op === 'resume' && Object.keys(command).length === 1) adapter.session.resumeByOperator();
        else if (command.op === 'draft' && Object.keys(command).sort().join(',') === 'op,present' && typeof command.present === 'boolean') adapter.session.setHumanDraft(command.present);
        else if (command.op === 'tool' && Object.keys(command).every(key => ['op', 'name', 'arguments'].includes(key))) {
          if (inFlightTools >= 8) throw new Error('operator_tool_limit');
          inFlightTools++;
          tools.invokeTool(adapter.tools, command.name, command.arguments ?? {}).then(result => { if (!closed) emit({ event: 'tool_result', result }); })
            .catch(() => diagnostic('operator_tool_unavailable')).finally(() => { inFlightTools--; });
        } else if (command.op === 'close' && Object.keys(command).length === 1) void stop();
        else throw new Error('invalid_control');
      }
      if (Buffer.byteLength(buffer) > 96 * 1024) throw new Error('input_limit');
    } catch { diagnostic('invalid_operator_input'); void stop(); }
  });
  process.stdin.resume();
  if (inputEnded || process.stdin.readableEnded) await stop();
  await new Promise(resolve => { child.once('exit', resolve); if (child.exitCode !== null) resolve(); });
} catch {
  diagnostic('adapter_launch_failed: verify the private configuration, pinned binary and native session; no automatic retry was applied.');
  process.exitCode = 1;
} finally { await stop(); }
