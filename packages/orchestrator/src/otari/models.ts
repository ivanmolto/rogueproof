// Model roles and selectors. Mirrors otari-config/models.json (a test asserts it).
// A selector is "provider:org/model"; the response echoes it in `model`, the real
// pick is in the Otari-Provider / Otari-Model headers.
import type { Profile, Role } from "./env.js";

export const MODELS = {
  A: "deepseek/deepseek-v4.1-flash",
  B: "alibaba/qwen-3.5-35b-a3b",
  C: "minimax/minimax-m3.1-flash",
  D: "anthropic/claude-sonnet-4.5",
} as const;

export const SELECTORS = {
  A: "together:deepseek/deepseek-v4.1-flash",
  A_FALLBACK: "fireworks:deepseek/deepseek-v4.1-flash",
  B: "deepinfra:alibaba/qwen-3.5-35b-a3b",
  C: "fireworks:minimax/minimax-m3.1-flash",
  D: "anthropic:anthropic/claude-sonnet-4.5",
} as const;

export const OPEN_WEIGHT_MODELS: readonly string[] = [MODELS.A, MODELS.B, MODELS.C];

/** Routing policy names (task 1.2). Until they exist the direct selectors below are used. */
export const ROUTING_POLICY = { rubric: "agent-primary", dev: "dev-primary" } as const;

const RUBRIC: Record<Role, string> = {
  agent: SELECTORS.A,
  judge: SELECTORS.B,
  report: SELECTORS.B,
  capped: SELECTORS.A,
  service: SELECTORS.A,
};

const DEV: Record<Role, string> = {
  agent: SELECTORS.D,
  judge: SELECTORS.D,
  report: SELECTORS.D,
  capped: SELECTORS.D,
  service: SELECTORS.D,
};

export function resolveModel(profile: Profile, role: Role): string {
  return profile === "rubric" ? RUBRIC[role] : DEV[role];
}

/** True when the selector's model id is one of the open-weight rubric models. */
export function isOpenWeight(selector: string): boolean {
  const id = selector.includes(":") ? selector.slice(selector.indexOf(":") + 1) : selector;
  return OPEN_WEIGHT_MODELS.includes(id);
}
