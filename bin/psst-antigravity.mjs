#!/usr/bin/env node
import { readConnectorConfig } from '../src/connector-config.mjs';
import { startConnector } from '../src/connector.mjs';
const usage = 'Usage: psst-antigravity --config /absolute/private/config.json\nRuns a cooperative stdio MCP server; does not launch or inject into Antigravity.\n';
if (process.argv.length === 3 && ['--help','-h'].includes(process.argv[2])) { process.stdout.write(usage); }
else {
  let connector;
  const controller = new AbortController();
  const stop = () => { controller.abort(); void connector?.close(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const path = process.argv.length === 4 && process.argv[2] === '--config' ? process.argv[3] : process.argv.length === 2 ? process.env.PSST_CONFIG_FILE : null;
    if (!path) throw new Error();
    process.stdin.pause();
    const config = readConnectorConfig(path);
    connector = await startConnector({config, signal: controller.signal, onDiagnostic: ({code}) => process.stderr.write(`psst: ${code}\n`)});
    process.stdin.resume();
    await connector.done;
  } catch { process.stderr.write('psst: connector_start_failed; check private configuration, Node 24.19+, credential enrollment and broker availability.\n'); process.exitCode=1; }
  finally { await connector?.close(); process.removeListener('SIGINT',stop); process.removeListener('SIGTERM',stop); }
}
