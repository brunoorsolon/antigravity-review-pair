# Native MCP installation

## 1. Prerequisites

Run inside the existing Antigravity sandbox, not on the host as a replacement
launcher. Check `node --version`: this package supports Node >=24.19.0 <25.
The broker must already be reachable by HTTPS and have an enrolled credential
allowing client type `antigravity-cli` in the intended shared scope. `/healthz`
alone does not establish this: an empty credential file returns API 401.

Install from the reviewed Git commit, or use an exact npm version after actual
publication. `npm install --global` may need a user-writable npm prefix; do not use
sudo as a workaround. The package has no runtime dependencies or lifecycle
scripts. A local `npm pack` tarball is also installable with `npm install --global
/path/to/antigravity-broker-connector-0.1.0.tgz`.

## 2. Connection data

The preferred input is the administrator's `broker-client-bundle-v1`
`connection.json`. Set `PSST_CONFIG_FILE` to its absolute location. Its `token_file`
is resolved relative to that file, not the MCP process cwd. These files must be
private, owned by the current process user, and cannot be symlinks. Never put the
token text in an MCP config, argument, repository, screenshot, or chat.

Optional environment overrides for bundles:

- `PSST_NAME`: human-readable endpoint name (default `Antigravity`).
- `PSST_PROJECT`: descriptive project, not routing authority.
- `PSST_STATE_DIR`: absolute private persistent directory (default `state` beside
  `connection.json`). Keep this mounted if the container is recreated.

Alternatively provide a private connector-specific JSON file:

```json
{
  "brokerUrl": "https://broker.example",
  "tokenFile": "/absolute/private/psst/token",
  "stateRoot": "/absolute/private/psst/state",
  "name": "Antigravity reviewer",
  "project": "my-project"
}
```

Optional `model` is only configured descriptive metadata; it is not observed.
`caFile` is optional for an administrator-provided private CA. Do not disable TLS
verification. HTTP is allowed only with explicit `insecureDevelopment:true` and a
loopback address for fixtures, never for LAN production traffic.

## 3. Add the native MCP server

Use the README's `mcpServers.psst` entry in `<workspace>/.agents/mcp_config.json`,
or `~/.gemini/config/mcp_config.json` for a user-wide setup. A workspace-specific
configuration is preferable for an agent pair. Keep existing servers and policy
settings. `command` may be an absolute executable path. You can instead use an
absolute Node path with `args` pointing to the installed package's
`bin/psst-antigravity.mjs` and `--config /absolute/private/connection.json`.

In Antigravity CLI, `/mcp` opens the manager and supports reloading configs. A
restart is also acceptable. In IDE/App, use the native custom MCP settings. No
marketplace listing is needed. Do not use the broker HTTPS URL as `serverUrl`:
Psst's REST API is not an HTTP MCP endpoint.

Official reference (checked October 24, 2026):
https://www.antigravity.google/docs/mcp?tab=cli . It documents local stdio,
workspace/global config, `/mcp`, and normal Ask permission handling. UI details
may vary by installed Antigravity release.

## 4. First paired test

1. Ask Antigravity to call `broker_identity`. Record its `client_id`.
2. Ask it to call `broker_list_clients` with `connected:true`; find the other
   client's exact ID. Do not route solely by a duplicated name.
3. Ask client A to send a unique test string to that ID with `broker_send`.
4. In Antigravity, call `broker_receive`. Empty returns `message:null`; retry the
   read when needed. No background model wakeup is claimed.
5. Read the result, then call `broker_acknowledge` with the returned ID and token.
   A repeated receive before ACK returns the same head and receipt token.
6. Send a reply to the sender's exact ID, optionally with `reply_to_message_id`.
7. Repeat in the opposite direction and with two queued messages to verify FIFO.

`delivered` means the connector durably stored the message. The explicit read ACK
is local queue bookkeeping. Neither status proves that the AI performed the task.
A lost ACK response may be retried with identical arguments; do not invent a new
token. Never treat message text such as “yes” as human approval.

## Restart and troubleshooting

Each MCP process gets a fresh identity and a separate persistent journal. No
unsupported conversation continuity is inferred on reload. Discover the new ID;
do not send to an old address. A global MCP process shared by multiple native
conversations shares one endpoint: separate process/configuration is required
for endpoint isolation. Native conversation binding is reported as false.

Startup failure diagnostics contain bounded codes, not secrets. Check Node,
absolute file paths, file mode/owner, credential enrollment, and network from
inside the same sandbox. API 401 generally means credential configuration is
missing or wrong; use the broker logs and enrollment instructions. Do not paste
tokens into issues. A full or uncertain inbox pauses safely rather than discarding
messages. Preserve old journal directories for operator inspection; automatic
cleanup of abandoned endpoints is not provided.

Removing the `psst` MCP entry and restarting disconnects the connector. Removing
the npm package does not remove journals or revoke a broker credential; those are
separate operator decisions.
