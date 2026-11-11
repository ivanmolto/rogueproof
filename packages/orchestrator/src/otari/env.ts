// Environment for the Otari gateway: base URL, one key per role, the model profile.
// Keys are read from process.env (loaded from the repo's .env when present) and
// are never logged, printed or placed in a prompt.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export const ROLES = ["agent", "judge", "report", "capped", "service"] as const;
/**
 * The key of the `rogueproof-fallback-test` workspace (otari-config/routing/fallback-test.md).
 * Optional: only `run:safe --fallback-demo` (task 4.5) uses it, so it is not in ROLES and
 * nothing that walks ROLES (smoke, usage) ever sends on it.
 */
export const FALLBACK_ROLE = "fallback" as const;
export type Role = (typeof ROLES)[number] | typeof FALLBACK_ROLE;

/** Key name as it appears in the otari.ai dashboard (otari-config/keys.json). */
export const ROLE_KEY_NAME: Record<Role, string> = {
  agent: "agent",
  judge: "judge",
  report: "report",
  capped: "agent-capped",
  service: "agent-service",
  fallback: "fallback-test",
};

export const ROLE_ENV: Record<Role, string> = {
  agent: "OTARI_API_KEY_AGENT",
  judge: "OTARI_API_KEY_JUDGE",
  report: "OTARI_API_KEY_REPORT",
  capped: "OTARI_API_KEY_CAPPED",
  service: "OTARI_API_KEY_SERVICE",
  fallback: "OTARI_API_KEY_FALLBACK_TEST",
};

export const PROFILES = ["dev", "rubric"] as const;
export type Profile = (typeof PROFILES)[number];

export interface OtariEnv {
  baseURL: string;
  profile: Profile;
  keys: Record<(typeof ROLES)[number], string> & { [FALLBACK_ROLE]?: string };
}

/** Walk up from `from` to the directory holding pnpm-workspace.yaml. */
export function findRepoRoot(from: string): string | undefined {
  let dir = from;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** Load `<repo>/.env` into process.env once, without overriding values already set. */
export function loadDotEnv(from = process.cwd()): void {
  const root = findRepoRoot(from);
  if (!root) return;
  const file = join(root, ".env");
  if (!existsSync(file)) return;
  const before = { ...process.env };
  process.loadEnvFile(file);
  // loadEnvFile overrides; restore anything the caller had set explicitly.
  for (const [k, v] of Object.entries(before)) if (v !== undefined) process.env[k] = v;
}

export function readOtariEnv(env: NodeJS.ProcessEnv = process.env): OtariEnv {
  const baseURL = env["OTARI_BASE_URL"];
  if (!baseURL) throw new Error("OTARI_BASE_URL is not set");
  const profileRaw = env["MODEL_PROFILE"] ?? "dev";
  if (!(PROFILES as readonly string[]).includes(profileRaw)) {
    throw new Error(`MODEL_PROFILE must be one of ${PROFILES.join("|")}, got "${profileRaw}"`);
  }
  const keys = {} as OtariEnv["keys"];
  for (const role of ROLES) {
    const v = env[ROLE_ENV[role]];
    if (!v) throw new Error(`${ROLE_ENV[role]} is not set (role "${role}")`);
    keys[role] = v;
  }
  const fallback = env[ROLE_ENV[FALLBACK_ROLE]];
  if (fallback) keys[FALLBACK_ROLE] = fallback;
  return { baseURL, profile: profileRaw as Profile, keys };
}
