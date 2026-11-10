// Environment for the Otari gateway: base URL, one key per role, the model profile.
// Keys are read from process.env (loaded from the repo's .env when present) and
// are never logged, printed or placed in a prompt.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export const ROLES = ["agent", "judge", "report", "capped", "service"] as const;
export type Role = (typeof ROLES)[number];

/** Key name as it appears in the otari.ai dashboard (otari-config/keys.json). */
export const ROLE_KEY_NAME: Record<Role, string> = {
  agent: "agent",
  judge: "judge",
  report: "report",
  capped: "agent-capped",
  service: "agent-service",
};

export const ROLE_ENV: Record<Role, string> = {
  agent: "OTARI_API_KEY_AGENT",
  judge: "OTARI_API_KEY_JUDGE",
  report: "OTARI_API_KEY_REPORT",
  capped: "OTARI_API_KEY_CAPPED",
  service: "OTARI_API_KEY_SERVICE",
};

export const PROFILES = ["dev", "rubric"] as const;
export type Profile = (typeof PROFILES)[number];

export interface OtariEnv {
  baseURL: string;
  profile: Profile;
  keys: Record<Role, string>;
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
  const keys = {} as Record<Role, string>;
  for (const role of ROLES) {
    const v = env[ROLE_ENV[role]];
    if (!v) throw new Error(`${ROLE_ENV[role]} is not set (role "${role}")`);
    keys[role] = v;
  }
  return { baseURL, profile: profileRaw as Profile, keys };
}
