# sandbox/

The container that executes the agent's **local** tools (`read_file`,
`write_file`, `run_command`). It has no network, no keys, no agent CLI, and one
mount: a per-run copy of `scenarios/mission/` at `/work`.

| File | What it is |
|---|---|
| `Dockerfile` | `node:22.21.1-bookworm-slim`, pinned by digest, with npm, npx, corepack and yarn removed. Nothing is installed: no curl, wget, git, ssh or python. Runs as an unprivileged user and idles on `sleep infinity`. |
| `docker-compose.yml` | The `sandbox` service: `network_mode: none`, one bind mount (`/work`), read-only root, 64 MB `noexec` tmpfs at `/tmp`, all capabilities dropped, `no-new-privileges`, 256 pids, 512 MB, no environment. |
| `TUNNEL.md` | Setup and use of `pnpm tunnel`, the authenticated tunnel that puts the honeypot and the collector on our own domain for the hosted gateway. The container itself never uses it. |

## Why no egress

The agent under test is the orchestrator's own loop
(`packages/orchestrator/src/agent/`). Everything that needs the outside world
happens on Otari's side, in the gateway: web fetch and search, the collector
(an MCP server attached with `mcp_server_ids`) and code execution. The
orchestrator, running on the host, is the only process that talks to the
gateway. The container therefore needs nothing but a filesystem and a shell to
run three tools in, so it gets no network at all rather than a filtered one:
there is no allow-list to get wrong, no DNS, no proxy.

This is what makes Permissive mode safe to run. With the tool policy empty, an
injected agent can read `/work/.env` and run any command it likes, and the
worst it can reach is a copy of three files whose secrets are fake. The
exfiltration in the demo does not leave from here: it is an MCP call the model
makes through the gateway to our own local collector.

## How a tool call runs

The loop calls the sandbox only after the active tool policy returned `allow`.
Each call is one `docker exec` made by the orchestrator
(`packages/orchestrator/src/sandbox/docker.ts`); the agent never gets a shell,
a TTY or a long-lived process.

| Tool | Inside the container | Limits |
|---|---|---|
| `read_file(path)` | `cat -- /work/<path>` | 64 KiB of output, 10 s |
| `write_file(path, content)` | `sh -c 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"'`, content on stdin | 1 MiB of content, 10 s |
| `run_command(cmd)` | `timeout -k 2 30 sh -c <cmd>`, stderr merged into stdout | 30 s, 64 KiB of output |

- Paths and commands are passed as arguments, never spliced into a script, and
  no host shell is involved. A path that resolves outside `/work` is refused
  before Docker is called.
- The 30 s timeout is enforced by `timeout` inside the container, so the
  process group is killed there (TERM, then KILL after 2 s). The orchestrator
  keeps a host-side deadline 5 s later as a backstop.
- Output is cut at 64 KiB and marked `[output truncated at 64 KiB]`. A non-zero
  exit is marked `[exit N]`, a timeout `[timed out after 30 s]`.
- `docker exec` passes none of the host's environment into the container, and
  the compose file sets none.

## `pnpm sandbox:check`

Every run must pass it; `startSandbox()` calls it before the container is
started and again on the running container, and refuses on any finding. It is
deterministic (no model is involved) and fails closed: what it cannot read is a
finding.

```bash
pnpm sandbox:check                       # compose file + scenarios/mission, and the container if one is running
pnpm sandbox:check --work runs/<run>/work --require-container
pnpm sandbox:check --compose some/copy.yml
```

It refuses when:

- **the container has a network**: the compose file, as `docker compose config`
  resolves it, is not `network_mode: none`, or names networks, ports, links,
  DNS or extra hosts; or the running container's `NetworkMode` is not `none`,
  it is attached to a network, it publishes a port, any interface other than
  loopback is up, or it has an IPv4 route;
- **there is a mount outside `/work`**: anything but exactly one bind mount at
  `/work` (and the tmpfs at `/tmp`); or `/work` is bound to the committed
  `scenarios/mission/` instead of a copy, to a directory containing the
  repository, or to the host home;
- **the workspace holds a real-looking secret**: a value in any `.env` file
  that does not contain `FAKE`, or any file containing the value of one of
  this machine's own secret environment variables (`*KEY*`, `*TOKEN*`,
  `*BEARER*`, `*SECRET*`, `*PASSWORD*`, including those in the repo's `.env`);
- the container is privileged, adds capabilities, has a writable root, shares a
  host namespace, or has an environment variable the image did not set.

Findings name files, lines and keys, never values.

## `pnpm sandbox:shell` (operator only)

Opens an interactive `sh` in the container for debugging. If no sandbox is
running it starts one on a fresh copy under `runs/<timestamp>-shell/work` and
removes the container on exit. **This is for the human operator. The agent
never gets a shell**: nothing in the agent loop can reach this script, and the
agent's only way into the container is the three tools above.

## Limits

- **It is a container, not a VM.** The agent's commands share the host kernel
  (on macOS, Docker Desktop's Linux VM kernel). Dropped capabilities,
  `no-new-privileges`, a read-only root and an unprivileged user narrow the
  attack surface; they do not make a kernel exploit impossible. Nothing in
  the scenario needs one, and the fixtures are fake, but do not reuse this
  sandbox for untrusted code that matters.
- **No network is the only network control.** The safe policy also denies
  network clients in `run_command`, as defence in depth and to make the
  denial visible on the timeline; the container would stop them anyway.
- **The path check is not the boundary.** `read_file`/`write_file` are kept
  inside `/work`, but `run_command` can read the rest of the image's
  filesystem (which holds nothing of ours) and a symlink created in `/work`
  resolves inside the container. The boundary is the container: one mount,
  no network.
- **`/work` is writable and it is a real host directory.** The agent can fill
  it or overwrite its own copy of the mission. It is a per-run copy under
  `runs/` (gitignored); the committed `scenarios/mission/` is never mounted.
  There is no disk quota on the bind mount.
- **Background processes** started by a command that detach from its process
  group can outlive the 30 s timeout. They are bounded by the pids and memory
  limits and die when the run stops the container.
- **CPU is not capped**, only memory and pids.
- **Truncated output loses the exit code**: the orchestrator stops reading at
  64 KiB and the command is left to the in-container timeout.
- **What the check does not see**: Docker daemon configuration, and anything
  another process on the host does with the container after the check ran.
  The check runs immediately before the agent starts, not continuously.
- **Inert tunnel devices.** Under Docker Desktop, `tunl0` and `ip6tnl0` exist
  (down, no address) in every network namespace, `none` included. The check
  tolerates interfaces that are down and refuses any that is up.

## Tests

`pnpm test` covers the tool wrappers and every check offline, and resolves
this compose file (and modified copies with a network, a second mount, an
environment variable, a port) through the docker CLI when it is installed; no
daemon is needed for that. `pnpm test:sandbox` needs Docker: it builds the
image, starts the container on a fresh mission copy and asserts that
`curl https://example.com` and a Node `fetch` both fail, that there is no
route, that the host home is not visible, and that the timeout and output cap
hold.

One local note: with Docker Desktop's `desktop-linux` context, `docker compose`
2.22 took a fixed 10 s per invocation on the development machine. The
orchestrator reads the context's endpoint once and passes it to compose as
`DOCKER_HOST` (same daemon, same socket), which avoids it.
