// docs/otari-feature-map.md (task 5.4): every link resolves, every config file exists,
// no rubric row is a gap, and what a row claims is in the golden run it points at.
// docs/ is ignored until the submission review, so a clone may not have the file.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const MAP = join(ROOT, "docs", "otari-feature-map.md");
const present = existsSync(MAP);
if (!present) console.log("feature-map tests skipped: docs/otari-feature-map.md is absent (docs/ is ignored until the submission review)");

const RUBRIC = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

interface Row {
  cells: string[];
  status: string;
  /** Link targets, resolved to absolute paths. */
  links: string[];
}

const linksIn = (text: string): string[] =>
  [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? "").filter((t) => !/^[a-z]+:/i.test(t) && !t.startsWith("#"));

const abs = (target: string): string => resolve(dirname(MAP), target.split("#")[0] ?? "");

function tableRows(md: string): Row[] {
  return md
    .split("\n")
    .filter((l) => l.startsWith("|") && !/^\|[\s|-]+\|$/.test(l))
    .map((l) => {
      const cells = l.split("|").slice(1, -1).map((c) => c.trim());
      return { cells, status: cells.at(-1) ?? "", links: linksIn(l).map(abs) };
    });
}

const under = (dir: string) => (p: string) => p.startsWith(join(ROOT, dir) + "/");
const read = (p: string): string => readFileSync(p, "utf8");

interface ToolCall { type?: string; status?: string; server?: string; name?: string; id?: string }
interface GoldenRun { golden?: boolean; profile?: string; calls: { turn: string; otariToolCalls?: ToolCall[] }[] }

const golden = (name: string): GoldenRun => JSON.parse(read(join(ROOT, "runs", "golden", name, "run.json"))) as GoldenRun;
/** Completed otari_tool_calls entries of a golden run, with the turn that carried them. */
const entries = (name: string): (ToolCall & { turn: string })[] =>
  golden(name).calls.flatMap((c) => (c.otariToolCalls ?? []).filter((t) => t.status === "completed").map((t) => ({ ...t, turn: c.turn })));

describe.skipIf(!present)("docs/otari-feature-map.md", () => {
  const md = present ? read(MAP) : "";
  const rows = tableRows(md);
  const rubric = rows.filter((r) => RUBRIC.includes(r.cells[0] ?? ""));
  const row = (id: string): Row => {
    const r = rubric.find((x) => x.cells[0] === id);
    if (!r) throw new Error(`no row ${id}`);
    return r;
  };

  it("has exactly one row per rubric feature, R1 to R8", () => {
    expect(rubric.map((r) => r.cells[0])).toEqual(RUBRIC);
  });

  it("names the four items beyond the rubric", () => {
    const first = rows.map((r) => r.cells[0] ?? "");
    for (const item of ["Tool policy", "Traces and the Requests view", "Playground", "Feedback API"]) expect(first).toContain(item);
  });

  it("every link resolves", () => {
    const targets = linksIn(md);
    expect(targets.length).toBeGreaterThan(40);
    expect(targets.filter((t) => !existsSync(abs(t)))).toEqual([]);
  });

  it("every rubric row names a config file under otari-config/, and it exists", () => {
    for (const r of rubric) {
      const configs = r.links.filter(under("otari-config"));
      expect(configs.length, `${r.cells[0]} config`).toBeGreaterThan(0);
      for (const c of configs) expect(existsSync(c), c).toBe(true);
    }
  });

  it("no row is marked gap, and every rubric row is used in a run", () => {
    expect(rows.filter((r) => /\bgap\b/i.test(r.status)).map((r) => r.cells[0])).toEqual([]);
    for (const r of rubric) expect(r.status, r.cells[0]).toMatch(/^used in a run\b/);
  });

  it("every rubric row points at a golden run or the tracked Trust Report", () => {
    const trustReport = join(ROOT, "runs", "trust-report.json");
    for (const r of rubric) {
      expect(r.links.some((l) => under("runs/golden")(l) || l === trustReport), r.cells[0]).toBe(true);
    }
  });

  it("every request id and budget id a row quotes is in a run or config file that row links", () => {
    for (const r of rows) {
      const sources = [...new Set(r.links.filter((l) => /\.(json|jsonl)$/.test(l) && (under("runs")(l) || under("otari-config")(l))))].map(read);
      for (const id of new Set(r.cells.join(" ").match(UUID) ?? [])) {
        expect(sources.some((s) => s.includes(id)), `${r.cells[0]} ${id}`).toBe(true);
      }
    }
    expect((md.match(UUID) ?? []).length).toBeGreaterThan(8);
  });

  it("the golden runs it leans on are golden rubric runs", () => {
    for (const name of ["safe", "permissive", "budget", "safe-fallback"]) {
      expect(golden(name), name).toMatchObject({ golden: true, profile: "rubric" });
    }
  });

  it("R2: an mcp entry for registry.submit_report sits on an act turn of a golden run the row links", () => {
    expect(row("R2").links).toContain(join(ROOT, "runs", "golden", "permissive", "run.json"));
    const mcp = entries("permissive").filter((e) => e.type === "mcp");
    expect(mcp).toHaveLength(1);
    expect(mcp[0]).toMatchObject({ server: "registry", name: "submit_report", turn: "act" });
    // The row says no golden run holds a drop; if one ever does, the row is out of date.
    expect(row("R2").cells.join(" ")).toContain("in no golden run");
    for (const name of ["safe", "permissive", "budget", "safe-fallback"]) {
      expect(entries(name).filter((e) => e.type === "mcp" && e.name === "drop"), name).toEqual([]);
    }
  });

  it("R3: web_fetch and web_search entries sit on a research turn of the golden Safe run", () => {
    expect(row("R3").links).toContain(join(ROOT, "runs", "golden", "safe", "run.json"));
    const web = entries("safe").filter((e) => e.type === "web_fetch" || e.type === "web_search");
    expect(web.map((e) => e.type).sort()).toEqual(["web_fetch", "web_fetch", "web_search"]);
    expect(new Set(web.map((e) => e.turn))).toEqual(new Set(["research"]));
  });

  it("R4: the code_execution entry the row quotes is the Trust Report's", () => {
    const report = JSON.parse(read(join(ROOT, "runs", "trust-report.json"))) as Record<string, unknown>;
    const cells = row("R4").cells.join(" ");
    expect(report["verifiedLocally"]).toBe(true);
    expect(String(report["codeExecutionToolCallId"])).toMatch(/^otari_ci_/);
    expect(cells).toContain(String(report["codeExecutionToolCallId"]));
    expect(cells).toContain(String(report["codeExecutionRequestId"]));
  });
});
