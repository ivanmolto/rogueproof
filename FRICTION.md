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
