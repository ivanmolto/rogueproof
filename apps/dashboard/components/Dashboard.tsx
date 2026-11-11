"use client";

import type { TimelineEvent, TimelineEventType } from "@rogueproof/shared";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { MODES, cardsAt, collectorNote, formatT, formatUsd, runKeyFor, statusText, stepDelay, type ModeKey, type ReplayView } from "../lib/view";

// Who produced each kind of event. Otari's own decisions and the orchestrator's
// app-level tool policy are never given the same label.
const SOURCE: Record<TimelineEventType, string> = {
  search: "Otari web search",
  fetch: "Otari web fetch",
  mcp: "Otari MCP",
  post: "Otari MCP · collector",
  guardrail: "Otari inference guardrail",
  budget: "Otari budget",
  fallback: "Otari routing",
  read: "sandbox",
  tool: "sandbox",
  deny: "tool policy · app-level, in the orchestrator",
  judge: "judge model",
  step_cap: "orchestrator",
  done: "orchestrator",
};

// Red: a denied action and the exfiltration. Green: a rescued fallback and a completed mission.
function badgeClass(type: TimelineEventType): string {
  if (type === "deny" || type === "post") return "border-red-600 bg-red-600 text-white";
  if (type === "fallback" || type === "done") return "border-green-700 bg-green-700 text-white";
  return "border-neutral-300 bg-neutral-100 text-neutral-800";
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="mt-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      {hint ? <p className="mt-0.5 text-sm text-neutral-600">{hint}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Card({ id, label, value, note, flashKey }: { id: string; label: string; value: string; note?: string | undefined; flashKey?: number }) {
  return (
    <div data-testid={`card-${id}`} className="min-w-0 rounded border border-neutral-300 p-3">
      <div className="text-xs uppercase tracking-wide text-neutral-600">{label}</div>
      {/* Remounting on a new denial restarts the 600 ms flash. */}
      <div key={flashKey ?? 0} data-testid={`card-${id}-value`} className={`mt-1 truncate rounded px-1 text-lg font-semibold tabular-nums ${flashKey ? "deny-flash" : ""}`}>
        {value}
      </div>
      {note ? <div className="mt-1 break-words text-xs text-neutral-600">{note}</div> : null}
    </div>
  );
}

/** A guardrail verdict on a request Otari served anyway: kept in the timeline, on one quiet line. */
function QuietRow({ event }: { event: TimelineEvent }) {
  return (
    <li data-testid="event" data-type={event.type} data-quiet="true" className="flex flex-wrap items-baseline gap-x-2 px-2 py-0.5 text-xs text-neutral-500">
      <span className="w-12 shrink-0 tabular-nums">{formatT(event.t)}</span>
      <span className="rounded border border-neutral-200 px-1.5">{event.type}</span>
      <span className="min-w-0 break-words">{event.summary}</span>
      {event.requestId !== undefined ? <span className="break-all font-mono text-[11px]">Otari request {event.requestId}</span> : null}
    </li>
  );
}

function EventRow({ event }: { event: TimelineEvent }) {
  return (
    <li data-testid="event" data-type={event.type} className={`rounded px-2 py-1.5 ${event.type === "deny" ? "deny-flash" : ""}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="w-12 shrink-0 text-xs tabular-nums text-neutral-500">{formatT(event.t)}</span>
        <span className={`rounded border px-1.5 text-xs font-medium ${badgeClass(event.type)}`}>{event.type}</span>
        <span className="text-xs text-neutral-500">{SOURCE[event.type]}</span>
        {event.cost !== undefined ? <span className="text-xs tabular-nums text-neutral-500">{formatUsd(event.cost)}</span> : null}
      </div>
      <div className="mt-0.5 break-words text-sm">{event.summary}</div>
      {event.requestId !== undefined ? <div className="break-all font-mono text-[11px] text-neutral-500">Otari request {event.requestId}</div> : null}
    </li>
  );
}

export default function Dashboard() {
  const [mode, setMode] = useState<ModeKey>("safe");
  const [fallbackDemo, setFallbackDemo] = useState(false);
  const [view, setView] = useState<ReplayView | null>(null);
  const [shown, setShown] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const total = view?.events.length ?? 0;
  useEffect(() => {
    if (!view || shown >= total) return;
    const timer = setTimeout(() => setShown((n) => n + 1), stepDelay(view.events, shown));
    return () => clearTimeout(timer);
  }, [view, shown, total]);

  // Keep the newest event in view: the list scrolls inside its own box, and the
  // page moves only as far as it takes to show that box's last row.
  const timeline = useRef<HTMLOListElement>(null);
  useEffect(() => {
    timeline.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [shown]);

  function reset(): void {
    request.current++;
    setView(null);
    setShown(0);
    setError(null);
    setLoading(false);
  }

  async function replay(): Promise<void> {
    const mine = ++request.current;
    setLoading(true);
    setError(null);
    setView(null);
    setShown(0);
    try {
      const res = await fetch(`/api/replay/${runKeyFor(mode, fallbackDemo)}`, { cache: "no-store" });
      const body = (await res.json()) as ReplayView | { error: string };
      if (mine !== request.current) return;
      if (!res.ok || "error" in body) setError("error" in body ? body.error : `replay failed (${res.status})`);
      else setView(body);
    } catch (e) {
      if (mine === request.current) setError(e instanceof Error ? e.message : "replay failed");
    } finally {
      if (mine === request.current) setLoading(false);
    }
  }

  const cards = view ? cardsAt(view, shown) : null;
  const playing = view !== null && shown < total;
  const blocked = cards ? cards.denied + cards.guardrailBlocked : 0;
  const note = view && cards ? collectorNote(view, cards) : null;

  return (
    <main>
      <header className="flex items-center gap-3 border-b border-neutral-300 pb-3">
        <img src="/brand/flat-mark/mark-light.svg" alt="" width={36} height={36} />
        <div className="min-w-0">
          <h1 className="text-xl font-bold leading-tight">RogueProof — Scenario 1: Agent Zero</h1>
          <p className="text-sm text-neutral-600">Break your AI agents before the real world does.</p>
        </div>
      </header>

      <Section title="Defense Control" hint="Same agent, same attack. Pick the policy it runs under.">
        <div role="radiogroup" aria-label="Mode" className="flex flex-wrap gap-2">
          {MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              role="radio"
              aria-checked={mode === m.key}
              onClick={() => {
                setMode(m.key);
                reset();
              }}
              className={`rounded border px-3 py-1.5 text-sm font-medium ${mode === m.key ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-400 bg-white"}`}
            >
              {m.label}
            </button>
          ))}
        </div>
        {mode === "safe" ? (
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={fallbackDemo}
              onChange={(e) => {
                setFallbackDemo(e.target.checked);
                reset();
              }}
            />
            Replay the fallback run (primary provider failing, recorded with <code>run:safe --fallback-demo</code>)
          </label>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void replay()} disabled={loading} className="rounded border border-neutral-900 bg-[#FFC83D] px-3 py-1.5 text-sm font-semibold text-neutral-900 disabled:opacity-60">
            Replay golden
          </button>
          <button type="button" disabled title="Live runs are not wired into the dashboard yet" className="rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-500">
            Run live
          </button>
          {playing ? (
            <button type="button" onClick={() => setShown(total)} className="rounded border border-neutral-400 px-3 py-1.5 text-sm">
              Skip to end
            </button>
          ) : null}
        </div>
        <p className="mt-2 text-xs text-neutral-600">
          A replay rebuilds a recorded golden run from its run.json and log.txt: no model call, no network. Live runs are not wired into the dashboard yet; use <code>pnpm run:{mode}</code>.
        </p>
      </Section>

      <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Card id="cost" label="Cost" value={cards ? formatUsd(cards.costUsd) : "—"} note={cards ? (cards.costIsFinal ? "run total, from Otari usage" : "events so far") : undefined} />
        <Card
          id="blocked"
          label="Blocked"
          value={cards ? String(blocked) : "—"}
          flashKey={cards?.denied ?? 0}
          note={cards ? `${cards.denied} by the tool policy (app-level, in the orchestrator) · ${cards.guardrailBlocked} by Otari's guardrail · ${cards.guardrailFlagged} flagged by it and served` : undefined}
        />
        <Card
          id="end-user"
          label="End user"
          value={view ? (view.endUser ?? "none") : "—"}
          note={view ? (view.endUser === null ? `plain key, names no end user · run label ${view.runLabel}` : view.endUserSpendUsd !== null ? `spend ${formatUsd(view.endUserSpendUsd)}` : undefined) : undefined}
        />
        <Card id="status" label="Status" value={cards ? statusText(cards.status) : loading ? "Loading…" : "Ready"} note={view ? `${shown}/${total} events · ${view.agentModel}` : undefined} />
      </div>

      <Section title="Attack Arena" hint="What the agent did, in order. Gateway-run tools are shown only when Otari reported them in otari_tool_calls.">
        {error ? (
          <p role="alert" className="rounded border border-neutral-400 p-3 text-sm">
            Replay failed: {error}
          </p>
        ) : null}
        {view && view.problems.length > 0 ? (
          <ul data-testid="problems" className="mb-2 rounded border border-neutral-400 p-3 text-sm">
            {view.problems.map((p) => (
              <li key={p}>Replay problem: {p}</li>
            ))}
          </ul>
        ) : null}

        {cards && cards.fallbacks > 0 ? (
          <p className="mb-2">
            <span data-testid="fallback-chip" className="inline-block rounded-full border border-green-700 bg-green-700 px-3 py-0.5 text-sm font-medium text-white">
              Rescued by fallback{cards.fallbacks > 1 ? ` ×${cards.fallbacks}` : ""}
            </span>
          </p>
        ) : null}

        {cards?.budgetMessage ? (
          <div data-testid="budget-message" className="mb-2 rounded border border-neutral-900 p-3 text-sm">
            <div className="text-xs uppercase tracking-wide text-neutral-600">Otari gateway</div>
            <div className="mt-0.5 font-medium">{cards.budgetMessage}</div>
          </div>
        ) : null}

        {note ? (
          <p data-testid="collector-note" className="mb-2 rounded border border-neutral-900 p-3 text-sm font-medium">
            {note}
          </p>
        ) : null}

        {view && cards?.exfiltrated ? (
          <div data-testid="exfil-panel" className="mb-2 rounded border border-red-600 bg-red-600 p-3 text-sm text-white">
            <div className="font-semibold">Exfiltrated (fake data)</div>
            <ul className="mt-1 list-disc pl-5">
              {cards.posts.map((p, i) => (
                <li key={i} className="break-words">
                  {p.summary}
                  {p.requestId !== undefined ? <span className="break-all font-mono text-[11px]"> · Otari request {p.requestId}</span> : null}
                </li>
              ))}
            </ul>
            <p className="mt-1">
              The collector holds {view.collector?.drops ?? 0} payload{view.collector?.drops === 1 ? "" : "s"}
              {view.collector && view.collector.fakeSecrets.length > 0 ? `, containing the fake values of ${view.collector.fakeSecrets.join(", ")}` : ""}. Every secret in the mission is fake; the run record keeps key names, never values.
            </p>
          </div>
        ) : null}

        {view ? (
          <ol ref={timeline} data-testid="timeline" className="max-h-[50vh] divide-y divide-neutral-200 overflow-y-auto rounded border border-neutral-300">
            {view.events.slice(0, shown).map((e, i) =>
              e.type === "guardrail" && !(e.requestId !== undefined && view.guardrailBlockedRequestIds.includes(e.requestId)) ? <QuietRow key={i} event={e} /> : <EventRow key={i} event={e} />,
            )}
            {shown === 0 ? <li className="px-2 py-1.5 text-sm text-neutral-500">Starting…</li> : null}
          </ol>
        ) : null}
        {view ? null : (
          <p className="rounded border border-dashed border-neutral-400 p-3 text-sm text-neutral-600">{loading ? "Loading the golden run…" : "Pick a mode and press Replay golden."}</p>
        )}
      </Section>

      <Section title="Trust Report">
        <Link href="/trust-report" className="text-sm font-medium underline">
          Open the Trust Report
        </Link>
      </Section>

      <footer className="mt-8 border-t border-neutral-300 pt-3 text-xs text-neutral-600">
        <p>AI decisions are real; harmful actions are simulated. The inference guardrail is Otari&apos;s; tool-policy enforcement is app-level, in the orchestrator.</p>
        <p className="mt-1">Built on Otari by Mozilla.ai · hackathon build</p>
      </footer>
    </main>
  );
}
