# Friction log

One entry per snag, written the moment it happens. Public; it becomes the
feedback video script and the written answers (`docs/feedback.md`).

Feedback questions: **Q1** tempted to skip Otari · **Q2** built myself what
Otari should do · **Q3** would keep using Otari.

## Template

```
## YYYY-MM-DD HH:MM — <short title>
- What I tried:
- What happened:
- Repro steps:
- Time lost:
- Workaround:
- Issue/PR: <link or "to open">
- Feedback question it answers: Q1 / Q2 / Q3
```

---

## 2026-11-07 (time not recorded) — Guardrails inert until mandated
- What I tried: configuring an organization inference guardrail for prompt injection.
- What happened: the guardrail had no effect on workspace requests until it was mandated for the workspace.
- Repro steps: to fill in
- Time lost: to fill in
- Workaround: to fill in
- Issue/PR: to open
- Feedback question it answers: Q2 (provisional)

## 2026-11-07 (time not recorded) — `request_limit` not in the dashboard
- What I tried: limiting a budget by request count for Budget-limited mode.
- What happened: `request_limit` is not settable from the hosted dashboard; it is set via `PATCH /api/v1/organizations/me/budgets/<id>` (as org owner) and cleared with `{"request_limit": null}`.
- Repro steps: to fill in
- Time lost: to fill in
- Workaround: to fill in
- Issue/PR: to open
- Feedback question it answers: Q2 (provisional)

## 2026-11-07 (time not recorded) — Web search off by default per workspace
- What I tried: using Otari's web tools from the `rogueproof` workspace.
- What happened: web search is off by default per workspace and must be allowed under Tools → Web search.
- Repro steps: to fill in
- Time lost: to fill in
- Workaround: to fill in
- Issue/PR: to open
- Feedback question it answers: Q1 (provisional)

## 2026-11-10 · `temperature` rejected for Anthropic models on chat/completions

- **Tried:** `temperature: 0` on every call, as the plan asks ("temperature 0 where configurable").
- **Happened:** 400 `temperature: Extra inputs are not permitted` for `anthropic:…` models only; open-weight providers accept it. No `code` in the body, no `Otari-Error-Code` header, so the client could not tell "unsupported parameter" from any other 400.
- **Repro:** POST /api/v1/chat/completions with `{"model":"anthropic:anthropic/claude-sonnet-4.5","messages":[…],"max_tokens":16,"temperature":0}`.
- **Time lost:** ~10 min. **Workaround:** send temperature only when set; never on Anthropic.
- **Feedback:** Q2 (built a per-provider parameter rule myself; the gateway could strip or translate unsupported params, or return `unsupported_parameter` as documented).

## 2026-11-10 · Service key vs normal key is not visible at creation

- **Tried:** created `agent-service` from Access → API keys like the other four, then sent `user: "smoke-user-1"`.
- **Happened:** 403 `'user' field does not match the authenticated API key's user`. The docs say only a service key may name end users; nothing in the key list marks which kind a key is.
- **Repro:** any key created with the default options + a `user` value.
- **Time lost:** ~5 min so far; key must be recreated. **Workaround:** pending (recreate as a service key).
- **Feedback:** Q2 (per-user budgets are a rubric feature; the key-creation form should ask "service key?" and the list should show it).
