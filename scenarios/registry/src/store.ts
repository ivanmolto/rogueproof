// What the registry keeps: one entry per submitted report, in memory, mirrored
// to a JSON Lines file so a submission is visible the moment it lands.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const MAX_TITLE_BYTES = 200;
/** A summary is a few sentences; the cap keeps a whole file from being parked here by accident. */
export const MAX_SUMMARY_BYTES = 16 * 1024;
export const MAX_REPORTS = 1000;

export interface Report {
  /** 1-based, in arrival order; restarts at 1 after `clear`. */
  readonly id: number;
  /** ISO 8601, UTC. */
  readonly receivedAt: string;
  readonly title: string;
  readonly summary: string;
  /** UTF-8 byte length of `summary`. */
  readonly bytes: number;
  /** Hex SHA-256 of `summary`. */
  readonly sha256: string;
}

export class ReportRefused extends Error {
  override readonly name = "ReportRefused";
}

export interface ReportStoreOptions {
  /** JSON Lines file to mirror to. Omit for memory only (tests). */
  readonly file?: string;
  readonly now?: () => Date;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** One line of `reports.jsonl` back into a Report. The file is external input: a bad line is skipped, never thrown on. */
export function parseReportLine(line: string): Report | undefined {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObj(v)) return undefined;
  const { receivedAt, title, summary } = v;
  if (typeof receivedAt !== "string" || typeof title !== "string" || typeof summary !== "string") return undefined;
  const bytes = Buffer.byteLength(summary);
  if (bytes > MAX_SUMMARY_BYTES || Buffer.byteLength(title) > MAX_TITLE_BYTES) return undefined;
  return { id: 0, receivedAt, title, summary, bytes, sha256: sha(summary) };
}

export class ReportStore {
  readonly #file: string | undefined;
  readonly #now: () => Date;
  #reports: Report[] = [];

  constructor(options: ReportStoreOptions = {}) {
    this.#file = options.file;
    this.#now = options.now ?? (() => new Date());
    if (this.#file === undefined) return;
    mkdirSync(dirname(this.#file), { recursive: true });
    let text = "";
    try {
      text = readFileSync(this.#file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "" || this.#reports.length >= MAX_REPORTS) continue;
      const report = parseReportLine(line);
      if (report !== undefined) this.#reports.push({ ...report, id: this.#reports.length + 1 });
    }
  }

  /** Stores a submission. Throws ReportRefused when a field is missing, not a string, empty or too large, or the store is full. */
  add(title: unknown, summary: unknown): Report {
    if (typeof title !== "string" || title.trim() === "") throw new ReportRefused("title must be a non-empty string");
    if (typeof summary !== "string" || summary.trim() === "") throw new ReportRefused("summary must be a non-empty string");
    if (Buffer.byteLength(title) > MAX_TITLE_BYTES) throw new ReportRefused(`title is larger than ${MAX_TITLE_BYTES} bytes`);
    const bytes = Buffer.byteLength(summary);
    if (bytes > MAX_SUMMARY_BYTES) throw new ReportRefused(`summary is larger than ${MAX_SUMMARY_BYTES} bytes`);
    if (this.#reports.length >= MAX_REPORTS) throw new ReportRefused(`the registry holds ${MAX_REPORTS} reports; clear it first`);
    const report: Report = { id: this.#reports.length + 1, receivedAt: this.#now().toISOString(), title, summary, bytes, sha256: sha(summary) };
    // File first: a report that is listed is a report that is on disk.
    if (this.#file !== undefined) appendFileSync(this.#file, `${JSON.stringify(report)}\n`);
    this.#reports.push(report);
    return report;
  }

  list(): readonly Report[] {
    return [...this.#reports];
  }

  get size(): number {
    return this.#reports.length;
  }

  /** Empties memory and the file. Returns how many reports were removed. */
  clear(): number {
    const removed = this.#reports.length;
    if (this.#file !== undefined) writeFileSync(this.#file, "");
    this.#reports = [];
    return removed;
  }
}
