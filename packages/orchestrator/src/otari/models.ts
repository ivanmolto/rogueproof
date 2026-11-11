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

/**
 * Routing policies (task 1.2), created in the dashboard and mirrored in
 * otari-config/routing/*.json. A policy name is sent as `model`; the gateway
 * serves the main entry and falls back through the backups. The models each
 * policy can serve are listed so a rubric run can be checked for open weights.
 */
export const POLICIES = {
  "agent-primary": { models: [MODELS.A, MODELS.A, MODELS.C], profile: "rubric" },
  "report-primary": { models: [MODELS.B, MODELS.C], profile: "rubric" },
  "dev-primary": { models: [MODELS.D, "anthropic/claude-haiku-5.5"], profile: "dev" },
} as const;
export type PolicyName = keyof typeof POLICIES;

/**
 * What a role sends as `model`: a routing policy, or one selector sent directly.
 * The rubric judge is model C sent directly, with no routing policy and so no
 * fallback: model B, first in report-primary, needed 4096 tokens and ~90 s per
 * explanation (docs/decisions/002-judge-model-c.md). If C is unavailable the
 * denial stands unexplained. report-primary still serves the report role.
 */
const RUBRIC: Record<Role, PolicyName | (typeof SELECTORS)[keyof typeof SELECTORS]> = {
  agent: "agent-primary",
  judge: SELECTORS.C,
  report: "report-primary",
  capped: "agent-primary",
  service: "agent-primary",
};

const DEV: Record<Role, PolicyName> = {
  agent: "dev-primary",
  judge: "dev-primary",
  report: "dev-primary",
  capped: "dev-primary",
  service: "dev-primary",
};

/** The policy name or selector a role sends as `model` under a profile. */
export function resolveModel(profile: Profile, role: Role): string {
  return profile === "rubric" ? RUBRIC[role] : DEV[role];
}

export function isPolicyName(s: string): s is PolicyName {
  return Object.hasOwn(POLICIES, s);
}

/** Model ids a request can end up on: the policy's list, or the selector's own id. */
export function modelsServedBy(modelOrPolicy: string): readonly string[] {
  if (isPolicyName(modelOrPolicy)) return POLICIES[modelOrPolicy].models;
  const id = modelOrPolicy.includes(":") ? modelOrPolicy.slice(modelOrPolicy.indexOf(":") + 1) : modelOrPolicy;
  return [id];
}

/** True when everything the selector or policy can serve is an open-weight rubric model. */
export function isOpenWeight(modelOrPolicy: string): boolean {
  return modelsServedBy(modelOrPolicy).every((id) => OPEN_WEIGHT_MODELS.includes(id));
}
