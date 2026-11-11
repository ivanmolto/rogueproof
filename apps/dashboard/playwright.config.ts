import { defineConfig, devices } from "@playwright/test";

// e2e for the dashboard: replays of the golden runs, nothing beyond localhost.
// Port 3100 so whatever holds 3000 is left alone. The server command builds the
// orchestrator first (the API route loads it as built). Once per machine:
// `pnpm exec playwright install chromium --only-shell`.
const PORT = 3100;

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: "list",
  use: { baseURL: `http://localhost:${PORT}`, ...devices["Desktop Chrome"] },
  webServer: {
    command: `pnpm --filter "@rogueproof/orchestrator..." build && pnpm exec next dev --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
