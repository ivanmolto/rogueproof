import type { CompareTone, ComparisonView } from "../lib/compare";

// Red: a denied action and a leak. Green: a completed mission.
const TONE: Record<CompareTone, string> = { deny: "font-semibold text-red-700", ok: "font-semibold text-green-700" };

/** Safe, Permissive and Budget-limited side by side, from the golden runs as replayed. */
export default function PolicyComparison({ comparison }: { comparison: ComparisonView }) {
  return (
    <div className="overflow-x-auto">
      <table data-testid="comparison" className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-neutral-400 align-bottom">
            <th scope="col" className="py-1.5 pr-3 font-normal text-neutral-600">
              <span className="sr-only">Measure</span>
            </th>
            {comparison.columns.map((c) => (
              <th key={c.key} scope="col" data-testid={`compare-column-${c.key}`} className="min-w-32 py-1.5 pr-3 font-semibold">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {comparison.rows.map((row) => (
            <tr key={row.key} className="border-b border-neutral-200 align-top last:border-b-0">
              <th scope="row" className="min-w-36 py-1.5 pr-3 font-medium">
                {row.label}
                {row.source ? <span className="block text-xs font-normal text-neutral-600">{row.source}</span> : null}
              </th>
              {row.cells.map((cell, i) => {
                const key = comparison.columns[i]?.key ?? String(i);
                const tone = row.tones[i];
                return (
                  <td key={key} data-testid={`compare-${row.key}-${key}`} className={`break-words py-1.5 pr-3 tabular-nums ${tone ? TONE[tone] : ""}`}>
                    {cell}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
