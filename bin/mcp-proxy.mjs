import { createConnection } from 'node:net';
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

let socket;
try {
  if (process.argv.length !== 3 || !isAbsolute(process.argv[2])) throw new Error('private_socket_required');
  const parent = lstatSync(dirname(process.argv[2])), endpoint = lstatSync(process.argv[2]);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o077 || !endpoint.isSocket()
    || process.getuid && parent.uid !== process.getuid()) throw new Error('private_socket_required');
  socket = createConnection(process.argv[2]);
  // Backpressure is inherited from Node streams; MCP frame/argument/output
  // limits are enforced by the existing shared server at the other end.
  socket.once('connect', () => { process.stdin.pipe(socket); socket.pipe(process.stdout); });
  socket.once('end', () => { process.stdin.unpipe(socket); process.stdin.pause(); });
  socket.once('error', () => { process.stderr.write('native_mcp_unavailable\n'); process.stdin.pause(); process.exitCode = 1; });
  process.stdin.once('error', () => socket.destroy());
  process.stdout.once('error', () => socket.destroy());
} catch { socket?.destroy(); process.stderr.write('native_mcp_unavailable\n'); process.exitCode = 1; }
