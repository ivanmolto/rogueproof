# sandbox/

The container that executes the agent's **local** tools (`read_file`,
`write_file`, `run_command`) via `docker exec`, after the active policy allowed
them. `network_mode: none`, no host mounts beyond the per-run copy of
`scenarios/mission/`. Web fetch, MCP and code execution happen on Otari's side,
so the container needs no egress. Dockerfile and compose arrive in task 3.4;
`TUNNEL.md` in task 3.1b.
