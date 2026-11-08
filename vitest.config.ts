import { defineConfig } from "vitest/config";

// One config for the whole monorepo. Unit tests run offline by default.
// Integration suites are gated, see packages/testing:
//   [otari]   needs the live gateway  -> RUN_OTARI=1   (pnpm test:otari)
//   [sandbox] needs Docker            -> RUN_SANDBOX=1 (pnpm test:sandbox)
export default defineConfig({
  test: {
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "vendor/**", "runs/**"],
    environment: "node",
    passWithNoTests: false,
  },
});
