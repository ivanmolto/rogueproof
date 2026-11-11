// pnpm sandbox:check [--compose <file>] [--work <dir>] [--require-container]
// Exit 0 when the sandbox is safe to run in, 1 with the findings otherwise.
// Prints file names, lines and key names; never a value.
import { resolve } from "node:path";
import { findRepoRoot, loadDotEnv } from "./otari/env.js";
import { checkSandbox, type SandboxCheckOptions } from "./sandbox/index.js";

function parseArgs(argv: string[]): { compose?: string; work?: string; requireContainer: boolean } {
  const out: { compose?: string; work?: string; requireContainer: boolean } = { requireContainer: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return resolve(v);
    };
    if (a === "--compose") out.compose = value();
    else if (a === "--work") out.work = value();
    else if (a === "--require-container") out.requireContainer = true;
    else throw new Error(`unknown argument ${a}; usage: pnpm sandbox:check [--compose <file>] [--work <dir>] [--require-container]`);
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = findRepoRoot(process.cwd());
  if (repoRoot === undefined) throw new Error("run this from inside the rogueproof repository");
  // So the keys in .env are among the secrets the workspace is scanned for.
  loadDotEnv();
  const opts: SandboxCheckOptions = { repoRoot, container: args.requireContainer ? "require" : "if-running" };
  if (args.compose !== undefined) opts.composeFile = args.compose;
  if (args.work !== undefined) opts.workDir = args.work;
  const r = await checkSandbox(opts);
  for (const c of r.checked) console.log(`checked  ${c}`);
  if (r.ok) {
    console.log("sandbox:check ok · no network, no mount but /work, every .env value contains FAKE");
    return 0;
  }
  for (const f of r.findings) console.error(`FAIL     [${f.check}] ${f.detail}`);
  console.error(`sandbox:check failed with ${r.findings.length} finding(s); refusing to run`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  },
);
