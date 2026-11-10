// Loads synthetic Otari fixtures and serves them through a fake fetch.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OUTCOMES, type Outcome } from "@rogueproof/shared";

export const FIXTURE_ROOT = join(import.meta.dirname, "fixtures", "otari");

export interface Fixture {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export function loadFixture(outcome: Outcome, name: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, outcome, `${name}.json`), "utf8")) as Fixture;
}

/** Telemetry (read-side) fixtures live beside the outcome directories, under `telemetry/`. */
export function loadTelemetryFixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, "telemetry", `${name}.json`), "utf8")) as Fixture;
}

export function listFixtures(): Record<Outcome, string[]> {
  const out = {} as Record<Outcome, string[]>;
  for (const o of OUTCOMES) {
    out[o] = readdirSync(join(FIXTURE_ROOT, o)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  }
  return out;
}

export interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that answers each call with the next fixture in `queue` and records what was sent. */
export function fakeFetch(queue: Fixture[]): { fetch: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    let body: unknown = undefined;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    calls.push({ url, method: init?.method ?? "GET", headers, body });
    const fx = queue.shift();
    if (!fx) throw new TypeError("fetch failed: no fixture queued");
    return new Response(JSON.stringify(fx.body), { status: fx.status, headers: fx.headers });
  }) as typeof fetch;
  return { fetch: f, calls };
}

export const FAKE_ENV = {
  baseURL: "https://fake.gateway.test/api/v1",
  profile: "rubric" as const,
  keys: {
    agent: ["otk", "v1", "eu", "FAKEagentkey000000"].join("_"),
    judge: ["otk", "v1", "eu", "FAKEjudgekey000000"].join("_"),
    report: ["otk", "v1", "eu", "FAKEreportkey00000"].join("_"),
    capped: ["otk", "v1", "eu", "FAKEcappedkey00000"].join("_"),
    service: ["otk", "v1", "eu", "FAKEservicekey0000"].join("_"),
  },
};
