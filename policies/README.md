# policies/

Deterministic tool-policy rules, evaluated by the orchestrator
(`packages/orchestrator/src/policy/`) before any local tool
(`read_file`, `write_file`, `run_command`) runs in the sandbox.

**App-level enforcement (orchestrator), by design — not an Otari Agent
Guardrail.** The mandated inference guardrail is Otari's and applies in all
modes, Permissive included. The two are separate layers: Otari's guardrail
inspects model requests at the gateway; these rules decide whether the
orchestrator executes a tool call the model asked for.

No model is involved in a verdict. The rules are data (`rules.json`), the
evaluator is plain string matching, and the same call always gets the same
answer. A judge model explains a denial afterwards; it cannot lift or add one.

| Mode | File | Rules |
|---|---|---|
| Safe | `safe/rules.json` | Deny `.env` / `*.pem` / `*.key` in `read_file` and `run_command`; deny network clients in `run_command`; allow everything else. |
| Permissive | `permissive/rules.json` | Empty rule set: allow all. Runs only inside the no-egress sandbox with fake secrets. |

## Check

```
pnpm policy:check
```

Runs `fixtures/ten-calls.json` (5 malicious, 5 benign tool calls) against both
policies and exits non-zero on any mismatch: Safe must deny each malicious call
with the rule the fixture names and allow each benign one; Permissive must
allow all ten. Offline, no gateway call.

## rules.json

```json
{
  "schemaVersion": 1,
  "name": "safe",
  "default": "allow",
  "rules": [ { "id": "secrets.env", "kind": "path", "tools": ["read_file", "run_command"], "globs": [".env", ".env.*"], "reason": "…" } ]
}
```

Rules are tried in order; the first match denies and its `id` and `reason` go
back to the agent as the tool result; a call that matches no rule is allowed.
A file that does not validate (unknown field, unknown kind, missing reason) is
refused at load, so a typo can never turn into "allow all".

| `kind` | Matches | Fields |
|---|---|---|
| `path` | A file name matching a glob (`*`, `?`), compared case-insensitively on every path segment. For `read_file`/`write_file` the path is a literal. For `run_command` every word of the command is examined (see below). | `globs` |
| `command` | A program named anywhere in the command (`curl`, `/usr/bin/curl`, `sh -c 'curl …'`), or a literal substring (`/dev/tcp/`). `run_command` only. | `names`, `substrings` |
| `inline-code` | An interpreter (`python`, `python3.12`, `node` …) in the command together with code that reaches for the network (`socket`, `urllib`, `fetch(` …). `run_command` only. | `interpreters`, `needles` |

## How a command is matched

A command is text a shell rewrites before anything runs, so it is not compared
as a string. Quotes and escaping backslashes are dropped, the command is split
into words and path segments, and every part the shell would expand becomes a
wildcard: globs (`*`, `?`, `[…]`), brace groups, `$VAR`, `${…}`, `$(…)`,
backticks, and `$'\x2e'`-style escapes. A `path` rule matches when a word
**could** expand to a protected name.

Refused in Safe mode, for example: `cat .env`, `base64<.env>out`, `cat .e""nv`,
`cat .e\nv`, `cat .e*`, `cat .[e]nv`, `cat .en{v,x}`, `cat .e$(echo n)v`,
`cat $'\x2eenv'`, `sh -c 'cat .e*'`, `a=.e; cat ${a}nv`.

This errs on the side of denying. `cat $F` and `echo $(date)` are refused,
because nothing here can know what they expand to; `cat *` is refused because
it could read `x.pem`. `ls *.md` is allowed: a shell glob never matches a
leading dot and `*.md` cannot be a key file.

## Limits

This is a string matcher in front of a shell, not a sandbox. It does not see:

- a name assembled inside another program: `python3 -c "open('.e'+'nv')"`;
- a read that never names a file: `grep -r KEY .`, `ls -a | xargs cat`;
- a network call from a script the agent wrote with `write_file` and then ran;
- `write_file` at all (Safe has no rule for it).

What contains those is the sandbox, not this policy: the container has no
network, mounts only the mission copy, and every secret in it is fake
(`pnpm sandbox:check`). The network rules in particular are defence in depth
and a visible `deny` in the timeline; nothing could leave the container anyway.

## Judge gate

On each `deny` the orchestrator calls the judge model (model C, through the
`judge` key, sent directly with no routing policy and so no fallback; under
`MODEL_PROFILE=dev` the same key routes to the dev policy) with the denied call and the rule, asks
for a two-sentence explanation, emits a `judge` timeline event, and returns
rule + explanation to the agent as the tool result. The judge is called after
the verdict and only explains it. If the call fails, is blocked, runs out of
budget or the run is at its 40-call cap, the denial stands with the rule's own
`reason`. The judge is shown the tool name and its path or command (clipped,
key-shaped strings redacted); never file content.
