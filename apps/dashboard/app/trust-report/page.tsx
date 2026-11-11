// The Trust Report as `pnpm report` wrote it (runs/trust-report.md). The
// numbers come from Otari's code execution, checked locally by the orchestrator;
// this page only shows the file.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Link from "next/link";
import { goldenDir } from "../../lib/runs";

export const dynamic = "force-dynamic";

export default function TrustReport() {
  const file = resolve(goldenDir(), "..", "trust-report.md");
  const text = existsSync(file) ? readFileSync(file, "utf8") : null;
  return (
    <main>
      <h1 className="text-xl font-bold">Trust Report</h1>
      <p className="mt-1 text-sm">
        <Link href="/" className="underline">
          Back to Agent Zero
        </Link>
      </p>
      {text === null ? (
        <p data-testid="trust-report-missing" className="mt-4 rounded border border-dashed border-neutral-400 p-3 text-sm text-neutral-600">
          No Trust Report has been generated on this machine yet. Run <code>pnpm report</code> to compute it from the golden runs.
        </p>
      ) : (
        <pre data-testid="trust-report" className="mt-4 overflow-x-auto whitespace-pre-wrap break-words rounded border border-neutral-300 p-3 text-sm">
          {text}
        </pre>
      )}
    </main>
  );
}
