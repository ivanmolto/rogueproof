// Where the collector keeps what it was sent: an in-memory list mirrored to a
// JSON Lines file (one drop per line), so `tail -f drops.jsonl` shows a drop
// the moment it lands and the list survives a restart.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Largest payload `drop` accepts, in UTF-8 bytes. The fake `.env` is a few hundred. */
export const MAX_PAYLOAD_BYTES = 256 * 1024;
/** The collector stops accepting drops here rather than grow without bound. */
export const MAX_DROPS = 1000;

export interface Drop {
  /** 1-based, in arrival order; restarts at 1 after `clear`. */
  readonly id: number;
  /** ISO 8601, UTC. */
  readonly receivedAt: string;
  /** UTF-8 byte length of `payload`. */
  readonly bytes: number;
  /** Hex SHA-256 of `payload`, so a run can prove what arrived without quoting it. */
  readonly sha256: string;
  readonly payload: string;
}

export class DropRefused extends Error {
  override readonly name = "DropRefused";
}

export interface DropStoreOptions {
  /** JSON Lines file to mirror to. Omit for memory only (tests). */
  readonly file?: string;
  readonly now?: () => Date;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One line of `drops.jsonl` back into a Drop. The file is external input: a bad line is skipped, never thrown on. */
export function parseDropLine(line: string): Drop | undefined {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObj(v)) return undefined;
  const { receivedAt, payload } = v;
  if (typeof receivedAt !== "string" || typeof payload !== "string") return undefined;
  const bytes = Buffer.byteLength(payload);
  if (bytes > MAX_PAYLOAD_BYTES) return undefined;
  // id, bytes and sha256 are recomputed: the payload is the record, the rest is derived from it.
  return { id: 0, receivedAt, bytes, sha256: createHash("sha256").update(payload).digest("hex"), payload };
}

export class DropStore {
  readonly #file: string | undefined;
  readonly #now: () => Date;
  #drops: Drop[] = [];

  constructor(options: DropStoreOptions = {}) {
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
      if (line.trim() === "" || this.#drops.length >= MAX_DROPS) continue;
      const drop = parseDropLine(line);
      if (drop !== undefined) this.#drops.push({ ...drop, id: this.#drops.length + 1 });
    }
  }

  /** Stores a payload. Throws DropRefused when it is not a string, too large, or the store is full. */
  add(payload: unknown): Drop {
    if (typeof payload !== "string") throw new DropRefused("payload must be a string");
    const bytes = Buffer.byteLength(payload);
    if (bytes > MAX_PAYLOAD_BYTES) throw new DropRefused(`payload is larger than ${MAX_PAYLOAD_BYTES} bytes`);
    if (this.#drops.length >= MAX_DROPS) throw new DropRefused(`the collector holds ${MAX_DROPS} drops; clear it first`);
    const drop: Drop = {
      id: this.#drops.length + 1,
      receivedAt: this.#now().toISOString(),
      bytes,
      sha256: createHash("sha256").update(payload).digest("hex"),
      payload,
    };
    // File first: a drop that is listed is a drop that is on disk.
    if (this.#file !== undefined) appendFileSync(this.#file, `${JSON.stringify(drop)}\n`);
    this.#drops.push(drop);
    return drop;
  }

  list(): readonly Drop[] {
    return [...this.#drops];
  }

  get size(): number {
    return this.#drops.length;
  }

  /** Empties memory and the file. Returns how many drops were removed. */
  clear(): number {
    const removed = this.#drops.length;
    if (this.#file !== undefined) writeFileSync(this.#file, "");
    this.#drops = [];
    return removed;
  }
}
