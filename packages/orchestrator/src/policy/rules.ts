// policies/<mode>/rules.json → a ToolPolicy. The file is data; this module is the
// only thing that gives it meaning. A file that does not validate throws: a
// malformed policy must never load as "allow everything".
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_TOOL_NAMES, type LocalToolCall, type LocalToolName, type PolicyVerdict, type ToolPolicy } from "../agent/types.js";
import { anySegmentMatches, literal, parseGlob, pathSegments, stripVersion, viewCommand, type CommandView } from "./match.js";

export const RULES_FILE = "rules.json";

interface RuleBase {
  id: string;
  tools: LocalToolName[];
  /** Returned to the agent with the denial, and given to the judge. */
  reason: string;
}
/** A file whose name matches a glob: the path of read_file/write_file, or any word of a command. */
export interface PathRule extends RuleBase {
  kind: "path";
  globs: string[];
}
/** A program named anywhere in a command, or a literal substring of it. */
export interface CommandRule extends RuleBase {
  kind: "command";
  names: string[];
  substrings: string[];
}
/** An interpreter in the command together with code that reaches for the network. */
export interface InlineCodeRule extends RuleBase {
  kind: "inline-code";
  interpreters: string[];
  needles: string[];
}
export type Rule = PathRule | CommandRule | InlineCodeRule;

export interface PolicyFile {
  schemaVersion: 1;
  name: string;
  description?: string;
  default: "allow";
  rules: Rule[];
}

export class PolicyFileError extends Error {
  override name = "PolicyFileError";
}

const fail = (where: string, what: string): never => {
  throw new PolicyFileError(`${where}: ${what}`);
};

function obj(v: unknown, where: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return fail(where, "must be an object");
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(where, `unknown field "${k}"`);
  return o;
}

function str(v: unknown, where: string): string {
  return typeof v === "string" && v.length > 0 ? v : fail(where, "must be a non-empty string");
}

function strings(v: unknown, where: string, opts: { min: number } = { min: 1 }): string[] {
  if (!Array.isArray(v) || v.length < opts.min) return fail(where, `must be an array of at least ${opts.min} string(s)`);
  return v.map((x, i) => str(x, `${where}[${i}]`));
}

const BASE = ["id", "kind", "tools", "reason"] as const;

function parseRule(v: unknown, where: string): Rule {
  const kind = (typeof v === "object" && v !== null ? (v as Record<string, unknown>)["kind"] : undefined) as unknown;
  const fields: Record<Rule["kind"], readonly string[]> = {
    path: [...BASE, "globs"],
    command: [...BASE, "names", "substrings"],
    "inline-code": [...BASE, "interpreters", "needles"],
  };
  if (kind !== "path" && kind !== "command" && kind !== "inline-code") return fail(where, `unknown rule kind ${JSON.stringify(kind)}`);
  const o = obj(v, where, fields[kind]);
  const id = str(o["id"], `${where}.id`);
  if (!/^[a-z][a-z0-9.-]*$/.test(id)) fail(`${where}.id`, "must be lower-case letters, digits, dots and dashes");
  const tools = strings(o["tools"], `${where}.tools`).map((t, i) =>
    (LOCAL_TOOL_NAMES as readonly string[]).includes(t) ? (t as LocalToolName) : fail(`${where}.tools[${i}]`, `unknown tool "${t}"`),
  );
  const base = { id, tools, reason: str(o["reason"], `${where}.reason`) };
  if (kind === "path") {
    const globs = strings(o["globs"], `${where}.globs`);
    for (const g of globs) {
      if (g.includes("/")) fail(`${where}.globs`, `"${g}" must be a file-name glob, without "/"`);
      if (/^\*+$/.test(g)) fail(`${where}.globs`, `"${g}" would match every file`);
    }
    return { ...base, kind, globs };
  }
  // The other kinds read a command line; they mean nothing for a file tool.
  if (tools.some((t) => t !== "run_command")) fail(`${where}.tools`, `a ${kind} rule applies to run_command only`);
  if (kind === "command") {
    return {
      ...base, kind,
      names: strings(o["names"], `${where}.names`),
      substrings: o["substrings"] === undefined ? [] : strings(o["substrings"], `${where}.substrings`, { min: 0 }),
    };
  }
  return { ...base, kind, interpreters: strings(o["interpreters"], `${where}.interpreters`), needles: strings(o["needles"], `${where}.needles`) };
}

/** Validate the content of a rules.json. Throws PolicyFileError; never returns a partial policy. */
export function parsePolicyFile(raw: unknown): PolicyFile {
  const o = obj(raw, "policy", ["schemaVersion", "name", "description", "default", "rules"]);
  if (o["schemaVersion"] !== 1) fail("policy.schemaVersion", "must be 1");
  const name = str(o["name"], "policy.name");
  if (!/^[a-z][a-z0-9-]*$/.test(name)) fail("policy.name", "must be lower-case letters, digits and dashes");
  if (o["default"] !== "allow") fail("policy.default", 'must be "allow"');
  if (!Array.isArray(o["rules"])) fail("policy.rules", "must be an array");
  const rules = (o["rules"] as unknown[]).map((r, i) => parseRule(r, `policy.rules[${i}]`));
  const seen = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.id)) fail("policy.rules", `duplicate rule id "${r.id}"`);
    seen.add(r.id);
  }
  const out: PolicyFile = { schemaVersion: 1, name, default: "allow", rules };
  if (o["description"] !== undefined) out.description = str(o["description"], "policy.description");
  return out;
}

type Matcher = (call: LocalToolCall, view: () => CommandView) => boolean;

function compileRule(rule: Rule): Matcher {
  switch (rule.kind) {
    case "path": {
      const globs = rule.globs.map(parseGlob);
      return (call, view) => anySegmentMatches(call.tool === "run_command" ? view().segments : pathSegments(call.path), globs);
    }
    case "command": {
      const names = rule.names.map(literal);
      const substrings = rule.substrings.map((s) => s.toLowerCase());
      return (call, view) => {
        if (call.tool !== "run_command") return false;
        const v = view();
        return anySegmentMatches(v.segments, names) || substrings.some((s) => v.flat.includes(s));
      };
    }
    case "inline-code": {
      const interpreters = rule.interpreters.map(literal);
      const needles = rule.needles.map((s) => s.toLowerCase());
      return (call, view) => {
        if (call.tool !== "run_command") return false;
        const v = view();
        return needles.some((s) => v.flat.includes(s)) && anySegmentMatches(v.segments.map(stripVersion), interpreters);
      };
    }
  }
}

/** Rules are tried in file order; the first match denies; no match allows. No model, no I/O, no clock. */
export function compilePolicy(file: PolicyFile): ToolPolicy & { readonly rules: readonly Rule[] } {
  const compiled: { rule: Rule; matches: Matcher }[] = file.rules.map((rule) => ({ rule, matches: compileRule(rule) }));
  return {
    name: file.name,
    rules: file.rules,
    evaluate(call: LocalToolCall): PolicyVerdict {
      let cached: CommandView | undefined;
      const view = (): CommandView => (cached ??= viewCommand(call.tool === "run_command" ? call.cmd : ""));
      for (const { rule, matches } of compiled) {
        if (!rule.tools.includes(call.tool)) continue;
        if (matches(call, view)) return { decision: "deny", rule: rule.id, reason: rule.reason };
      }
      return { decision: "allow" };
    },
  };
}

/** Load `<dir>/rules.json` (e.g. policies/safe). */
export function loadPolicy(dir: string): ToolPolicy & { readonly rules: readonly Rule[] } {
  const file = join(dir, RULES_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new PolicyFileError(`${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return compilePolicy(parsePolicyFile(raw));
  } catch (e) {
    throw e instanceof PolicyFileError ? new PolicyFileError(`${file}: ${e.message}`) : e;
  }
}
