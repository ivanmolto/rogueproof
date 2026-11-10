import { describe, expect, it } from "vitest";
import { pickResponseHeaders, redact, redactString } from "./redact.js";

const otk = ["otk", "v1", "eu", "AbCdEfGhIjKlMnOp"].join("_");
const tk = ["tk", "abcdef123"].join("-");
const gw = ["gw", "abcdef123"].join("_");
const sk = ["sk", "ant-abcdef123456"].join("-");

describe("redact", () => {
  it("replaces every key shape and bearer tokens in strings", () => {
    const s = redactString(`a ${otk} b ${tk} c ${gw} d ${sk} e Bearer abcdefghijklmnop f`);
    expect(s).toBe("a [REDACTED] b [REDACTED] c [REDACTED] d [REDACTED] e [REDACTED] f");
  });
  it("leaves prose and FAKE-free short tokens alone", () => {
    expect(redactString("keys look like otk_v1_eu_... shown once")).toBe("keys look like otk_v1_eu_... shown once");
  });
  it("drops credential headers by name and walks nested objects", () => {
    const out = redact({ headers: { Authorization: `Bearer ${otk}`, "Otari-Key": otk, "otari-request-id": "req_1" }, body: { messages: [{ content: otk }] } });
    expect(out.headers["Authorization"]).toBe("[REDACTED]");
    expect(out.headers["Otari-Key"]).toBe("[REDACTED]");
    expect(out.headers["otari-request-id"]).toBe("req_1");
    expect(out.body.messages[0]!.content).toBe("[REDACTED]");
  });
  it("picks only Otari-* and a few standard response headers", () => {
    const h = new Headers({ "Otari-Fallback": "true", "Set-Cookie": "s=1", "Content-Type": "application/json", "X-Other": "x" });
    expect(pickResponseHeaders(h)).toEqual({ "otari-fallback": "true", "content-type": "application/json" });
  });
});
