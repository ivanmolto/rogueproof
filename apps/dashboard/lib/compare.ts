// The three policies side by side, from the golden runs as replayed. Pure: no
// I/O, no React. Every cell is a count of recorded events or a field of
// run.json; a run that could not be loaded says so and shows no number.
import { ENFORCER_GUARDRAIL, ENFORCER_TOOL_POLICY, MODES, cardsAt, formatUsd, statusText, type ModeKey, type ReplayView } from "./view";

export { ENFORCER_GUARDRAIL, ENFORCER_TOOL_POLICY };

/** Red for a denied action or a leak, green for a completed mission; only where the count or outcome says so. */
export type CompareTone = "deny" | "ok";

export interface CompareColumn {
  key: ModeKey;
  label: string;
  /** False when runs/golden has no readable run for this mode. */
  recorded: boolean;
}

export interface CompareRow {
  key: string;
  label: string;
  /** Who produced the number. */
  source?: string;
  /** One cell per column, in column order. */
  cells: string[];
  tones: (CompareTone | null)[];
}

export interface ComparisonView {
  columns: CompareColumn[];
  rows: CompareRow[];
}

const NOT_RECORDED = "not recorded";
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What the collector held after the run: its own count, and the names (never values) of the fake keys found. */
export function leakCell(view: ReplayView): { text: string; tone: CompareTone | null } {
  const c = view.collector;
  if (c === null) return { text: NOT_RECORDED, tone: null };
  if (c.crossCheck === "mismatch") return { text: `${c.drops} (does not match the drop calls Otari reported)`, tone: null };
  if (c.drops === 0) return { text: "0", tone: null };
  const names = c.fakeSecrets.length > 0 ? ` · fake values of ${c.fakeSecrets.join(", ")}` : "";
  return { text: `${plural(c.drops, "drop")}${names}`, tone: "deny" };
}

export function comparisonView(runs: Partial<Record<ModeKey, ReplayView | null>>): ComparisonView {
  const views = MODES.map((m) => runs[m.key] ?? null);
  const ends = views.map((v) => (v ? cardsAt(v, v.events.length) : null));
  type Cell = { text: string; tone?: CompareTone | null };
  const row = (key: string, label: string, cell: (v: ReplayView, i: number) => Cell, source?: string): CompareRow => {
    const cells = views.map((v, i): Cell => (v ? cell(v, i) : { text: NOT_RECORDED }));
    return { key, label, ...(source !== undefined ? { source } : {}), cells: cells.map((c) => c.text), tones: cells.map((c) => c.tone ?? null) };
  };
  return {
    columns: MODES.map((m, i) => ({ key: m.key, label: m.label, recorded: views[i] !== null })),
    rows: [
      row("run", "Run", (v) => ({ text: v.runId })),
      row("outcome", "Outcome", (v) => ({ text: `${statusText(v.outcome)} (${v.outcome})`, tone: v.outcome === "ok" || v.outcome === "fallback" ? "ok" : null })),
      row(
        "blocked",
        "Blocked actions",
        (_, i) => {
          const n = ends[i]?.denied ?? 0;
          return { text: String(n), tone: n > 0 ? "deny" : null };
        },
        ENFORCER_TOOL_POLICY,
      ),
      row(
        "guardrail",
        "Guardrail hits",
        (_, i) => {
          const refused = ends[i]?.guardrailBlocked ?? 0;
          const flagged = ends[i]?.guardrailFlagged ?? 0;
          return { text: `${refused + flagged} (${refused} refused · ${flagged} flagged and served)` };
        },
        ENFORCER_GUARDRAIL,
      ),
      row("leaked", "Secrets leaked (collector drops)", leakCell, "the collector's own count; every secret is fake"),
      row("spend", "Spend, run", (v) => ({ text: v.costUsd === null ? NOT_RECORDED : formatUsd(v.costUsd) }), "Otari usage"),
      row("model", "Agent model", (v) => ({ text: v.agentModel })),
    ],
  };
}
