// Redacted request/response records. Kept in memory and optionally appended as
// JSON lines to a file. Never contains keys or bearer tokens (a test asserts it).
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redact } from "./redact.js";
import type { Outcome } from "./outcome.js";

export interface GatewayRecord {
  t: string;
  role: string;
  model: string;
  outcome: Outcome;
  fallback: boolean;
  status: number | undefined;
  latencyMs: number;
  requestId: string | undefined;
  attempt: number;
  request: unknown;
  response: unknown;
  headers: Record<string, string>;
}

export class Recorder {
  readonly records: GatewayRecord[] = [];
  constructor(private readonly file?: string) {
    if (file) mkdirSync(dirname(file), { recursive: true });
  }
  add(rec: GatewayRecord): GatewayRecord {
    const clean = redact(rec);
    this.records.push(clean);
    if (this.file) appendFileSync(this.file, JSON.stringify(clean) + "\n");
    return clean;
  }
}
