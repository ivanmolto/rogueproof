// pnpm replay <runDir>... [--json]
//
// Rebuilds each run's timeline (shared/timeline.schema.json) from its run.json
// and log.txt. No model call, no network, no key: it reads two files per run.
// `--json` prints the Timeline objects (an array, one per run) instead of the
// readable listing. Exit 0: every run replayed with no problem. 1: a log line
// and run.json disagree somewhere. 2: a run could not be read or is invalid.
import { ReplayError, renderReplay, replayDir } from "./run/replay.js";

function main(argv: readonly string[]): number {
  const json = argv.includes("--json");
  const dirs = argv.filter((a) => !a.startsWith("--"));
  if (dirs.length === 0) {
    console.error("usage: pnpm replay <runDir>... [--json]   e.g. pnpm replay runs/golden/*");
    return 2;
  }
  let code = 0;
  const timelines = [];
  for (const dir of dirs) {
    const r = replayDir(dir);
    timelines.push(r.timeline);
    if (r.problems.length > 0) code = 1;
    for (const line of json ? r.problems.map((p) => `${dir}: ${p}`) : renderReplay(dir, r)) (json ? console.error : console.log)(line);
  }
  if (json) console.log(JSON.stringify(timelines, null, 2));
  return code;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (e) {
  console.error(e instanceof ReplayError ? e.message : e);
  process.exit(2);
}
