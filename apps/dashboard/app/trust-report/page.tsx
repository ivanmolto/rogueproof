// Task 5.3: the Trust Report, one column per run, from runs/trust-report.json
// as `pnpm report` wrote it. The numbers were computed in Otari's code sandbox
// and checked locally by the orchestrator; this page formats the file's fields
// and computes nothing of its own.
import Link from "next/link";
import type { ReactNode } from "react";
import { loadTrustReport } from "../../lib/runs";
import { trustReportView, type ColumnView, type ModelBadge, type RowTone } from "../../lib/trustReport";

export const dynamic = "force-dynamic";

const TONE: Record<RowTone, string> = { deny: "font-semibold text-red-700", rescue: "font-semibold text-green-700" };

function Badge({ badge }: { badge: ModelBadge }) {
  // A rubric model that is not open-weight is a broken report: say it in bold, not in colour (red is for denials and drops).
  const cls = badge === "not open-weight" ? "border-neutral-900 font-semibold" : "border-neutral-400 text-neutral-700";
  return (
    <span data-testid="model-badge" className={`ml-1 inline-block whitespace-nowrap rounded border px-1.5 text-xs ${cls}`}>
      {badge}
    </span>
  );
}

function Findings({ column }: { column: ColumnView }) {
  return (
    <div data-testid={`findings-${column.key}`} className="mt-4">
      <h3 className="text-sm font-semibold">
        {column.label} · {column.judgeFindings.length}
      </h3>
      {column.judgeFindings.length === 0 ? (
        <p className="mt-1 text-sm text-neutral-600">No denial to explain in this run.</p>
      ) : (
        column.judgeFindings.map((f, i) => (
          <blockquote key={i} data-testid="judge-finding" className="mt-2 border-l-2 border-neutral-400 pl-3 text-sm">
            “{f}”
          </blockquote>
        ))
      )}
    </div>
  );
}

function Missing({ children }: { children: ReactNode }) {
  return (
    <p data-testid="trust-report-missing" className="mt-4 rounded border border-dashed border-neutral-400 p-3 text-sm text-neutral-600">
      {children}
    </p>
  );
}

export default async function TrustReportPage() {
  const loaded = await loadTrustReport();
  const view = loaded.status === "ok" ? trustReportView(loaded.report) : null;
  return (
    <main>
      <h1 className="text-xl font-bold">Trust Report</h1>
      <p className="mt-1 text-sm">
        <Link href="/" className="underline">
          Back to Agent Zero
        </Link>
      </p>
      {loaded.status === "missing" ? (
        <Missing>
          No Trust Report has been generated on this machine yet. Run <code>pnpm report</code> to compute it from the golden runs.
        </Missing>
      ) : null}
      {loaded.status === "invalid" ? (
        <Missing>
          runs/trust-report.json is not a valid Trust Report ({loaded.problems.slice(0, 3).join("; ")}). Run <code>pnpm report</code> again.
        </Missing>
      ) : null}
      {view ? (
        <div data-testid="trust-report">
          <p className="mt-3 text-sm text-neutral-600">
            Generated <span data-testid="generated-at">{view.generatedAt}</span>. Numbers computed in Otari’s code sandbox (<code>otari_code_execution</code>, <code>report</code> key), read
            from the code-execution entry in <code>otari_tool_calls</code>, and checked against a local computation over the same <code>run.json</code> files.
          </p>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-400 align-bottom">
                  <th scope="col" className="py-1.5 pr-3 font-normal text-neutral-600">
                    <span className="sr-only">Measure</span>
                  </th>
                  {view.columns.map((c) => (
                    <th key={c.key} scope="col" data-testid={`column-${c.key}`} className="min-w-36 py-1.5 pr-3 font-semibold">
                      {c.label}
                      {c.control ? <span className="block text-xs font-normal text-neutral-600">frontier model, not a rubric run</span> : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {view.rows.map((row) => (
                  <tr key={row.key} className="border-b border-neutral-200 align-top">
                    <th scope="row" className="min-w-36 py-1.5 pr-3 font-medium">
                      {row.label}
                      {row.source ? <span className="block text-xs font-normal text-neutral-600">{row.source}</span> : null}
                    </th>
                    {row.cells.map((cell, i) => {
                      const key = view.columns[i]?.key ?? String(i);
                      const tone = row.tones[i];
                      return (
                        <td key={key} data-testid={`cell-${row.key}-${key}`} className={`break-words py-1.5 pr-3 tabular-nums ${tone ? TONE[tone] : ""}`}>
                          {cell}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr className="border-b border-neutral-200 align-top">
                  <th scope="row" className="min-w-36 py-1.5 pr-3 font-medium">
                    Models
                  </th>
                  {view.columns.map((c) => (
                    <td key={c.key} data-testid={`cell-models-${c.key}`} className="py-1.5 pr-3">
                      {c.models.map((m) => (
                        <div key={m.role} data-testid="model" className="mb-1 break-words">
                          <span className="text-neutral-600">{m.role}:</span> {m.model}
                          <Badge badge={m.badge} />
                        </div>
                      ))}
                    </td>
                  ))}
                </tr>
                <tr className="align-top">
                  <th scope="row" className="min-w-36 py-1.5 pr-3 font-medium">
                    Trace links
                  </th>
                  {view.columns.map((c) => (
                    <td key={c.key} data-testid={`cell-traces-${c.key}`} className="py-1.5 pr-3">
                      {c.traceLinks.length === 0 ? (
                        <span className="text-neutral-600">none recorded</span>
                      ) : (
                        c.traceLinks.map((href, i) => (
                          <a key={href} href={href} rel="noreferrer" className="mr-2 underline">
                            trace {i + 1}
                          </a>
                        ))
                      )}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>

          <ul className="mt-4 list-disc space-y-1 pl-5 text-sm">
            <li data-testid="rubric-models-only">
              Every golden run used only the open-weight models A/B/C: <strong>{view.rubricModelsOnly && view.rubricViolations.length === 0 ? "yes" : "NO"}</strong> (the control column never
              counts){view.rubricViolations.length > 0 ? `. Not open-weight: ${view.rubricViolations.join("; ")}` : ""}.
            </li>
            <li data-testid="verified-locally">
              Verified against the local computation: <strong>{view.verifiedLocally ? "yes" : "NO"}</strong>.
            </li>
            <li data-testid="report-call">
              Report call: request <code className="break-all">{view.reportCall.requestId ?? "?"}</code>, code-execution entry <code className="break-all">{view.reportCall.toolCallId ?? "?"}</code>,
              model {view.reportCall.model ?? "?"} on {view.reportCall.provider ?? "?"}
              {view.reportCall.fallback ? " (rescued by fallback)" : ""}, cost {view.reportCall.costUsd}.
            </li>
            <li>
              Blocked actions are the orchestrator’s own tool policy (app-level, by design); guardrail hits are Otari’s inference guardrail. No model decided either: the judge only explains a
              denial after the policy made it.
            </li>
            <li>
              Trace links: a hosted workspace key has no trace API, so the report records no link; the runs’ requests and traces are in the Otari dashboard.
            </li>
          </ul>

          <section aria-label="Judge findings" className="mt-6">
            <h2 className="text-lg font-semibold">Judge findings</h2>
            <p className="mt-0.5 text-sm text-neutral-600">The judge model’s explanation of each denied action, quoted as recorded.</p>
            {view.columns.map((c) => (
              <Findings key={c.key} column={c} />
            ))}
          </section>

          <p data-testid="closing-line" className="mt-8 border-t border-neutral-300 pt-4 text-base font-semibold">
            {view.closingLine}
          </p>
        </div>
      ) : null}
    </main>
  );
}
