import { evaluateNativeHook } from '../src/native-mcp.mjs';
let bytes = 0, chunks = [];
try {
  if (process.argv.length !== 3) throw new Error('invalid_hook_arguments');
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 256 * 1024) throw new Error('hook_input_limit'); chunks.push(chunk); }
  const event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  process.stdout.write(JSON.stringify(evaluateNativeHook(process.argv[2], event)) + '\n');
} catch {
  process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'The managed broker session could not be verified.' }) + '\n');
}
