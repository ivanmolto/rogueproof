#!/usr/bin/env node
// Generates shared/src/generated/*.ts from shared/*.schema.json.
//   node scripts/gen-schemas.mjs          write the files
//   node scripts/gen-schemas.mjs --check  exit 1 if any generated file drifted (CI)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src", "generated");
export const SCHEMAS = [
  { file: "timeline.schema.json", out: "timeline.ts" },
  { file: "run.schema.json", out: "run.ts" },
  { file: "trust-report.schema.json", out: "trust-report.ts" },
];

const BANNER = `/* eslint-disable */
/**
 * GENERATED FILE — do not edit by hand.
 * Source: shared/{{file}} · regenerate with \`pnpm gen:schemas\`.
 * CI fails if this file drifts from the schema.
 */`;

async function render({ file }) {
  const schema = JSON.parse(await readFile(join(root, file), "utf8"));
  return compile(schema, schema.title, {
    bannerComment: BANNER.replace("{{file}}", file),
    additionalProperties: false,
    cwd: root,
    strictIndexSignatures: true,
    unreachableDefinitions: true,
    format: true,
    style: { semi: true, singleQuote: false, printWidth: 100, trailingComma: "all" },
  });
}

const check = process.argv.includes("--check");
let drifted = 0;
await mkdir(outDir, { recursive: true });
for (const s of SCHEMAS) {
  const expected = await render(s);
  const target = join(outDir, s.out);
  if (check) {
    const actual = await readFile(target, "utf8").catch(() => "");
    if (actual !== expected) {
      drifted++;
      console.error(`drift: src/generated/${s.out} does not match ${s.file} — run pnpm gen:schemas`);
    }
  } else {
    await writeFile(target, expected);
    console.log(`wrote src/generated/${s.out}`);
  }
}
if (check) {
  if (drifted) process.exit(1);
  console.log("generated schema types are up to date");
}
