/**
 * Deterministic tool-policy evaluation of policies/safe/ and
 * policies/permissive/, plus the judge gate that explains a denial.
 * App-level enforcement (orchestrator), by design — not an Otari Agent
 * Guardrail. No model is involved in a verdict. See ../../../../policies/README.md.
 */
export const MODULE = "policy" as const;
export { compilePolicy, loadPolicy, parsePolicyFile, PolicyFileError, RULES_FILE } from "./rules.js";
export type { CommandRule, InlineCodeRule, PathRule, PolicyFile, Rule } from "./rules.js";
export { anySegmentMatches, intersects, literal, parseGlob, pathSegments, viewCommand } from "./match.js";
export type { CommandView, Tok } from "./match.js";
export { createJudgeGate, tidyExplanation, JUDGE_MAX_TOKENS, JUDGE_SYSTEM } from "./judge.js";
export type { JudgeGateOptions } from "./judge.js";
export { checkPolicies, loadFixtureCalls, FIXTURE_FILE, POLICY_MODES } from "./check.js";
export type { CheckRow, FixtureCall, PolicyCheckResult, PolicyMode } from "./check.js";
