import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  COLLECTOR_PORT,
  HONEYPOT_PORT,
  MAX_LINE_BYTES,
  REDACTED,
  TUNNEL_ARGV,
  TunnelConfigError,
  childEnv,
  createLineRedactor,
  isConnectedLine,
  normalizePrefix,
  publicOrigin,
  publicUrls,
  readTunnelConfig,
  redactLine,
} from "./config.js";

// Synthetic, shaped like a tunnel token (base64 JSON starts with eyJ). Not a real one.
const TOKEN = `eyJ${"hIjoiZmFrZS1hY2NvdW50IiwidCI6ImZha2UtdHVubmVsIiwicyI6ImZha2Utc2VjcmV0In0".repeat(2)}`;
const ENV = {
  TUNNEL_TOKEN: TOKEN,
  HONEYPOT_PUBLIC_URL: "https://honeypot.example.dev",
  COLLECTOR_PUBLIC_URL: "https://collector.example.dev/",
  HONEYPOT_PREFIX: "/lumen-notes",
};

describe("tunnel config", () => {
  it("reads the token, both origins and the prefix", () => {
    const c = readTunnelConfig(ENV);
    expect(c).toEqual({
      token: TOKEN,
      honeypotOrigin: "https://honeypot.example.dev",
      collectorOrigin: "https://collector.example.dev",
      prefix: "/lumen-notes",
    });
    expect(publicUrls(c)).toEqual({
      honeypot: "https://honeypot.example.dev/lumen-notes/",
      changelog: "https://honeypot.example.dev/lumen-notes/changelog.html",
      collector: "https://collector.example.dev/",
    });
  });

  it("the two routes point at different local ports", () => {
    expect(HONEYPOT_PORT).toBe(4444);
    expect(COLLECTOR_PORT).toBe(4445);
  });

  it("refuses a missing or malformed token without echoing it", () => {
    expect(() => readTunnelConfig({ ...ENV, TUNNEL_TOKEN: "" })).toThrow(/TUNNEL_TOKEN is not set/);
    const bad = "short-secret-value";
    try {
      readTunnelConfig({ ...ENV, TUNNEL_TOKEN: bad });
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(TunnelConfigError);
      expect((e as Error).message).not.toContain(bad);
    }
  });

  it.each([
    ["http://honeypot.example.dev", /https/],
    ["https://user:pw@honeypot.example.dev", /credentials/],
    ["https://honeypot.example.dev:8443", /port/],
    ["https://honeypot.example.dev/?x=1", /query/],
    ["https://localhost", /public hostname/],
    ["https://127.0.0.1", /public hostname/],
    ["https://[::1]", /public hostname/],
    ["https://intranet", /public hostname/],
    ["not a url", /valid URL/],
    ["", /not set/],
  ])("refuses the public URL %j", (value, reason) => {
    expect(() => publicOrigin(value, "HONEYPOT_PUBLIC_URL")).toThrow(reason);
  });

  it("error messages never contain the offending value", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 8, maxLength: 60 }), (value) => {
        try {
          publicOrigin(value, "HONEYPOT_PUBLIC_URL");
        } catch (e) {
          expect((e as Error).message).not.toContain(value.trim());
        }
      }),
    );
  });

  it("refuses the same hostname for both services", () => {
    expect(() => readTunnelConfig({ ...ENV, COLLECTOR_PUBLIC_URL: ENV.HONEYPOT_PUBLIC_URL })).toThrow(/different hostnames/);
  });

  it("normalises the prefix like the honeypot does and refuses anything else", () => {
    expect(normalizePrefix(undefined)).toBe("/lumen-notes");
    expect(normalizePrefix("a1b2/lumen-notes/")).toBe("/a1b2/lumen-notes");
    expect(() => normalizePrefix("/../etc")).toThrow(TunnelConfigError);
    expect(() => normalizePrefix("/a b")).toThrow(TunnelConfigError);
  });
});

describe("tunnel token never reaches argv or logs", () => {
  it("argv carries no token; the child env carries only PATH, HOME and the token", () => {
    expect(TUNNEL_ARGV.join(" ")).not.toContain("eyJ");
    expect(TUNNEL_ARGV).not.toContain("--token");
    const env = childEnv(readTunnelConfig(ENV), { PATH: "/bin", HOME: "/home/x", OTARI_API_KEY_AGENT: "otk_v1_eu_FAKEFAKEFAKE" });
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH", "TUNNEL_TOKEN"]);
  });

  it("redacts the configured token, token-shaped strings and bearer values", () => {
    expect(redactLine(`INF token=${TOKEN} ok`, [TOKEN])).toBe(`INF token=${REDACTED} ok`);
    expect(redactLine(`other eyJ${"A".repeat(40)} end`, [])).toBe(`other ${REDACTED} end`);
    expect(redactLine("Authorization: Bearer abcdefgh12345678", [])).toBe(`Authorization: ${REDACTED}`);
    expect(redactLine("INF Registered tunnel connection connIndex=0", [TOKEN])).toBe("INF Registered tunnel connection connIndex=0");
  });

  it("a token split across chunks is still redacted", () => {
    const r = createLineRedactor([TOKEN]);
    const half = Math.floor(TOKEN.length / 2);
    const lines = [...r.push(`start ${TOKEN.slice(0, half)}`), ...r.push(`${TOKEN.slice(half)} end\nnext`), ...r.flush()];
    expect(lines).toEqual([`start ${REDACTED} end`, "next"]);
  });

  it("fuzz: no chunking of any output ever prints the token", () => {
    const secret = fc.stringMatching(/^[A-Za-z0-9_-]{32,64}$/);
    fc.assert(
      fc.property(secret, fc.array(fc.string({ maxLength: 40 }), { maxLength: 6 }), fc.array(fc.integer({ min: 1, max: 30 }), { minLength: 1, maxLength: 12 }), (token, parts, cuts) => {
        const text = parts.join(token) + token + "\n" + parts.join("\n");
        const r = createLineRedactor([token]);
        const out: string[] = [];
        let i = 0;
        let c = 0;
        while (i < text.length) {
          const step = cuts[c++ % cuts.length] ?? 1;
          out.push(...r.push(text.slice(i, i + step)));
          i += step;
        }
        out.push(...r.flush());
        expect(out.join("\n")).not.toContain(token);
      }),
    );
  });

  it("drops an over-long line whole instead of printing pieces of it", () => {
    const r = createLineRedactor([TOKEN]);
    const out = [...r.push("x".repeat(MAX_LINE_BYTES + 1)), ...r.push(`${TOKEN}\nafter\n`), ...r.flush()];
    expect(out).toEqual(["[line too long, dropped]", "after"]);
  });

  it("recognises cloudflared's connection line", () => {
    expect(isConnectedLine("2026-11-11T04:31:02Z INF Registered tunnel connection connIndex=0 location=mrs07")).toBe(true);
    expect(isConnectedLine("2026-11-11T04:31:00Z INF Starting tunnel")).toBe(false);
  });
});
