// Configuration and log hygiene for `pnpm tunnel` (task 3.1b). The tunnel is a
// remotely managed Cloudflare Tunnel: the routes (hostname -> local port) live in
// the Cloudflare dashboard, the connector on this machine only needs the token.
// The token comes from .env, reaches cloudflared through its environment (never
// argv, so it is not visible in `ps`), and is stripped from every line we print.
import { isIP } from "node:net";

/** Local ports the two Cloudflare routes point at. The honeypot's is its DEFAULT_PORT. */
export const HONEYPOT_PORT = 4444;
export const COLLECTOR_PORT = 4445;
/** The benign report registry (scenarios/registry, decision 003). */
export const REGISTRY_PORT = 4446;
export const DEFAULT_HONEYPOT_PREFIX = "/lumen-notes";

export const REDACTED = "[REDACTED]";
/** A line longer than this is dropped rather than printed in pieces (a piece could split a secret). */
export const MAX_LINE_BYTES = 64 * 1024;

export interface TunnelConfig {
  readonly token: string;
  /** Origin only, e.g. https://honeypot.example.dev */
  readonly honeypotOrigin: string;
  readonly collectorOrigin: string;
  /** Set once the registry has its own hostname (REGISTRY_PUBLIC_URL); the tunnel itself runs without it. */
  readonly registryOrigin?: string;
  /** Normalised path prefix, e.g. /lumen-notes */
  readonly prefix: string;
}

export class TunnelConfigError extends Error {
  override readonly name = "TunnelConfigError";
}

/**
 * Validates a public URL from .env and returns its origin. It must be https on
 * a real hostname: no credentials, no port, no query, not localhost or an IP.
 * Error messages name the variable, never its value.
 */
export function publicOrigin(raw: string | undefined, name: string): string {
  const value = (raw ?? "").trim();
  if (value === "") throw new TunnelConfigError(`${name} is not set`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TunnelConfigError(`${name} is not a valid URL`);
  }
  if (url.protocol !== "https:") throw new TunnelConfigError(`${name} must be an https URL`);
  if (url.username !== "" || url.password !== "") throw new TunnelConfigError(`${name} must not contain credentials`);
  if (url.port !== "") throw new TunnelConfigError(`${name} must not name a port`);
  if (url.search !== "" || url.hash !== "") throw new TunnelConfigError(`${name} must not contain a query or fragment`);
  const host = url.hostname;
  const bare = host.startsWith("[") ? host.slice(1, -1) : host;
  if (isIP(bare) !== 0 || host === "localhost" || host.endsWith(".localhost") || !host.includes(".")) {
    throw new TunnelConfigError(`${name} must be a public hostname on our own domain`);
  }
  return url.origin;
}

const SEGMENT = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/;

/** Same rule as the honeypot's own normalizePrefix (scenarios/ is not imported here). */
export function normalizePrefix(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (value === "") return DEFAULT_HONEYPOT_PREFIX;
  const segments = value.split("/").filter((s) => s !== "");
  if (segments.length === 0 || !segments.every((s) => SEGMENT.test(s))) {
    throw new TunnelConfigError("HONEYPOT_PREFIX is not a plain URL path such as /lumen-notes");
  }
  return `/${segments.join("/")}`;
}

export function readTunnelConfig(env: NodeJS.ProcessEnv = process.env): TunnelConfig {
  const token = (env["TUNNEL_TOKEN"] ?? "").trim();
  if (token === "") throw new TunnelConfigError("TUNNEL_TOKEN is not set (see sandbox/TUNNEL.md)");
  if (token.length < 32 || /\s/.test(token)) throw new TunnelConfigError("TUNNEL_TOKEN does not look like a tunnel token");
  const honeypotOrigin = publicOrigin(env["HONEYPOT_PUBLIC_URL"], "HONEYPOT_PUBLIC_URL");
  const collectorOrigin = publicOrigin(env["COLLECTOR_PUBLIC_URL"], "COLLECTOR_PUBLIC_URL");
  if (honeypotOrigin === collectorOrigin) {
    throw new TunnelConfigError("HONEYPOT_PUBLIC_URL and COLLECTOR_PUBLIC_URL must be different hostnames");
  }
  const config = { token, honeypotOrigin, collectorOrigin, prefix: normalizePrefix(env["HONEYPOT_PREFIX"]) };
  if ((env["REGISTRY_PUBLIC_URL"] ?? "").trim() === "") return config;
  const registryOrigin = publicOrigin(env["REGISTRY_PUBLIC_URL"], "REGISTRY_PUBLIC_URL");
  if (registryOrigin === honeypotOrigin || registryOrigin === collectorOrigin) {
    throw new TunnelConfigError("REGISTRY_PUBLIC_URL must be a hostname of its own, not the honeypot's or the collector's");
  }
  return { ...config, registryOrigin };
}

/** Public URLs the run needs. The honeypot is only served under its prefix. */
export function publicUrls(config: TunnelConfig): { honeypot: string; changelog: string; collector: string; registry?: string } {
  return {
    honeypot: `${config.honeypotOrigin}${config.prefix}/`,
    changelog: `${config.honeypotOrigin}${config.prefix}/changelog.html`,
    collector: `${config.collectorOrigin}/`,
    ...(config.registryOrigin !== undefined ? { registry: `${config.registryOrigin}/` } : {}),
  };
}

/** What we run. The token is deliberately absent: cloudflared reads TUNNEL_TOKEN from its environment. */
export const TUNNEL_COMMAND = "cloudflared";
export const TUNNEL_ARGV: readonly string[] = ["tunnel", "--no-autoupdate", "run"];

/** The child gets PATH, HOME and the token, nothing else: no Otari key ever reaches cloudflared. */
export function childEnv(config: TunnelConfig, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = { TUNNEL_TOKEN: config.token };
  for (const key of ["PATH", "HOME"]) {
    const value = base[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// A tunnel token is base64 JSON, so it starts with eyJ. Redacted by shape as well
// as by value, in case cloudflared ever echoes a token that is not the one in .env.
const TOKEN_SHAPE = /\beyJ[A-Za-z0-9_=+/-]{20,}/g;
const BEARER_SHAPE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

export function redactLine(line: string, secrets: readonly string[]): string {
  let out = line;
  for (const secret of secrets) {
    if (secret !== "") out = out.split(secret).join(REDACTED);
  }
  return out.replace(TOKEN_SHAPE, REDACTED).replace(BEARER_SHAPE, REDACTED);
}

export interface LineRedactor {
  /** Feed a chunk of child output; returns the complete, redacted lines it closed. */
  push(chunk: string): string[];
  /** Returns the redacted remainder, if any. */
  flush(): string[];
}

/**
 * Redacts by whole lines, so a secret split across two chunks is still caught.
 * An over-long line is dropped whole instead of being emitted in pieces.
 */
export function createLineRedactor(secrets: readonly string[]): LineRedactor {
  let buffer = "";
  let dropping = false;
  const emit = (line: string): string => redactLine(line.replace(/\r$/, ""), secrets);
  return {
    push(chunk) {
      const out: string[] = [];
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (dropping) {
          dropping = false;
          continue;
        }
        out.push(emit(line));
      }
      if (buffer.length > MAX_LINE_BYTES) {
        buffer = "";
        if (!dropping) out.push("[line too long, dropped]");
        dropping = true;
      }
      return out;
    },
    flush() {
      const rest = buffer;
      buffer = "";
      if (dropping) {
        dropping = false;
        return [];
      }
      return rest === "" ? [] : [emit(rest)];
    },
  };
}

/** cloudflared logs this once per edge connection; the first one means the tunnel is up. */
export function isConnectedLine(line: string): boolean {
  return /Registered tunnel connection/i.test(line);
}
