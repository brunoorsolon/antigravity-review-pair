# Opt-in local managed runner

The runner is an experimental operator-controlled JSON-lines front end, **not a
TUI extension**. Use only a new CLI process whose stdin it exclusively owns.
An operator must first install/authenticate the official CLI normally and review
its current headless protocol. No setup command here downloads a CLI, copies
credentials, changes approvals or opens a LAN port.

## Private config

Create a 0600 JSON file outside the repository, with absolute paths. Create a
0700 state directory owned by the same nonroot user; do not share a state directory
between live adapters or use network filesystems. Use the exact broker checkout
`ba2219cd87a1feac23e01b23d2c2b3d3bdd65359` read-only.

```json
{
  "referenceRoot": "/opt/ai-agent-msg-broker",
  "stateRoot": "/var/lib/agy-pair",
  "brokerUrl": "https://broker.example.test:8787",
  "tokenFile": "/run/secrets/broker-token",
  "caFile": "/run/secrets/broker-ca.pem",
  "name": "reviewer-1",
  "project": "example-project",
  "binary": "/opt/official-cli/agy",
  "binarySha256": "REPLACE_WITH_SHA256_OF_REVIEWED_EXECUTABLE",
  "harnessVersion": "REPLACE_WITH_REVIEWED_VERSION",
  "experimentalManaged": false
}
```

The binary must be a regular executable (not a symlink), pinned by SHA-256.
The configured version is a declaration, not native certification. The wrapper
passes only documented stream input/output arguments and an optional `model`
identifier. It accepts only `request-review` in the native init event. It does
not add permission, trust, sandbox-relaxation or account flags.

```sh
node bin/launch.mjs /absolute/private/config.json
```

Keep stdin open for the life of the owned session. Its stdout contains bounded
JSON-line events; stderr uses nonsecret diagnostic codes. The `connected` event
identifies this fresh exact broker client. Reconnects within the same process
use the shared lease logic; a new process gets a new identity, never adopts an
old native session or mailbox.

Commands from the **trusted local operator**, never from model output or broker
message bodies:

```jsonl
{"op":"human","text":"Review this project without changing files."}
{"op":"draft","present":true}
{"op":"draft","present":false}
{"op":"pause"}
{"op":"resume"}
{"op":"tool","name":"broker_list_clients","arguments":{}}
{"op":"close"}
```

`pause` stops future automatic submissions; it does not interrupt an active turn.
`resume` does not resolve uncertain injection or approve any tool. `human` is
accepted only at the same single-owner safe boundary, not while another turn or
approval hold is active. Library hosts may also use `holdForHuman()` and
`releaseHumanHold()`; these are deliberately not model tools.

With `experimentalManaged:false`, incoming messages remain in the durable inbox.
Set it to `true` **only for an explicitly reviewed experimental session** to enable
serial final-hop submission. The mode still reports uncertified. Every prompt
uses the shared provenance wrapper. An unknown event, failed result, malformed
frame or process death preserves uncertainty and blocks the head.

## Containers and multiple hosts

Run one CLI+adapter in each independent nonroot Podman container; mount only its
own private state, approved project and credentials, plus the pinned broker
reference read-only. The broker may be on another host; HTTPS verification, CA,
broker token and exact recipient UUID still apply. This repository does not ship
a vendor-bundled image or automatically install/authenticate a CLI. No rootless
Podman/SELinux/two-host LAN deployment has been performed. Do not use host PID
namespaces, Docker sockets, relaxed seccomp, privileged mode or approval bypasses
to make this prototype work. Native CLI image packaging is a remaining gate.

## Operator recovery

Do not delete, edit or automatically resolve an `injecting`/`uncertain` inbox.
A crash after submission may have reached the model even without a receipt.
Preserve the journal and use the shared reference's explicit operator recovery
process after checking the exact native session. Never replay an old inbox into
a new session just because its project/name matches.

## Official contract

- [Headless stream JSON](https://antigravity.google/docs/cli/headless/)
- [CLI reference](https://antigravity.google/docs/cli/reference)
- [Native MCP](https://antigravity.google/docs/mcp)
- [Native hooks](https://antigravity.google/docs/hooks)

These are CLI contracts; app-side internal agent APIs are intentionally not used.

## Optional native outbound MCP wiring

Add `"nativeMcp": true` and an explicit absolute `"workspaceDirectory"` naming
only the approved project. Default remains **off**. This creates a fresh private
0700 temporary workspace with `.agents/mcp_config.json` and `.agents/hooks.json`.
The CLI runs with that new working directory and documented `--add-dir` pointing
to the approved project. **This changes cwd and may change automatic AGENTS,
project-context and relative-path behavior**; it is not identical to opening the
original interactive workspace. Existing project/global configs are never edited. This is a **NEW isolated CLI
workspace**, not a transparent proxy for the original project. Its project-scoped
hooks, rules and MCP servers are not guaranteed to be inherited via `--add-dir`.
The launcher therefore fails closed if the selected project contains `.agents`,
`AGENTS.md` or `GEMINI.md`; it does not migrate, omit or overwrite those recognized
policies. Other inherited or vendor-specific context still needs operator review.
Use a dedicated reviewed project without those policies for this experimental
mode; do not delete policies to bypass this gate.
Keep tokens and private adapter state outside the approved project.

The configured stdio process forwards only standard MCP bytes through an owner-
private Unix socket to the same adapter and SQLite inbox. There is no new wire
protocol, remote listener, credential-bearing tool argument or second broker
identity. Only discovery/send/metadata/status are enabled. `broker_receive` is
blocked to avoid a cooperative peek racing the managed inbound scheduler.

The native PreToolUse hook matches all tools and rejects any conversation ID other
than the managed root. Consequently **subagent tool calls are denied in this
experimental mode**, rather than borrowing the root mailbox. A matching root hook
returns documented `decision:allow`, meaning delegate to normal native policy—not
`auto_approve`. No permission override or allow-rule is generated. In headless
mode, an ordinary Ask MCP tool can therefore be soft-denied; the operator must
make any separate native permission decision themselves. Never enable blanket
skip-permissions to make messaging work.

Native hook coverage for MCP, init ordering and actual CLI configuration loading
remain unverified until a pinned vendor build is tested. The process-lifetime
guard, unbound/changed-conversation denial, one-connection limit and cleanup are
covered by synthetic fixtures. Socket creation failure fails launch closed;
there is no TCP or security-policy fallback. Temporary config/socket cleanup is
graceful on normal close. A hard crash may leave its private temporary directory
for operator cleanup, but no surviving broker session can be adopted from it.
