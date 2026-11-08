import { describe } from "vitest";

/** Name prefix for suites that need the live otari.ai gateway. */
export const OTARI_TAG = "[otari]";
/** Name prefix for suites that need Docker (the sandbox container). */
export const SANDBOX_TAG = "[sandbox]";

/** True when live-gateway suites should run (`RUN_OTARI=1`). Off in CI by default. */
export const otariEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => Boolean(env.RUN_OTARI);
/** True when Docker suites should run (`RUN_SANDBOX=1`). */
export const sandboxEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => Boolean(env.RUN_SANDBOX);

type SuiteFn = () => void;

/**
 * A suite that talks to the live gateway. Skipped unless RUN_OTARI is set.
 * Usage: `describeOtari("smoke", () => { it(...) })` → suite "[otari] smoke".
 */
export function describeOtari(name: string, fn: SuiteFn): void {
  describe.skipIf(!otariEnabled())(`${OTARI_TAG} ${name}`, fn);
}

/** A suite that needs Docker. Skipped unless RUN_SANDBOX is set. → "[sandbox] name". */
export function describeSandbox(name: string, fn: SuiteFn): void {
  describe.skipIf(!sandboxEnabled())(`${SANDBOX_TAG} ${name}`, fn);
}
