// Task 5.2: "Run live" in the page. The live route is answered by the test (a
// real one starts `pnpm run:<mode>` and spends credit), in the route's own SSE
// format; the fallback replays the real golden run. What the real route sends,
// and when, is covered offline by lib/live.test.ts and the orchestrator's
// run/live.test.ts.
import { expect, test, type Page } from "@playwright/test";

const sse = (messages: object[]): string => messages.map((m) => `event: ${(m as { type: string }).type}\ndata: ${JSON.stringify(m)}\n\n`).join("");
const timeline = (t: number, type: string, summary: string) => ({ type: "timeline", event: { t, type, summary, requestId: `req_${t}`, cost: 0.0002 } });

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

async function answerLive(page: Page, mode: string, messages: object[]): Promise<{ posts: () => number }> {
  let posts = 0;
  await page.route(`**/api/live/${mode}`, async (route) => {
    posts++;
    expect(route.request().method()).toBe("POST");
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" }, body: sse(messages) });
  });
  return { posts: () => posts };
}

test("a live Safe run shows its events in order and ends on the saved run", async ({ page, request }) => {
  const errors = watchConsole(page);
  // The saved run the server would send at the end: here, the golden Safe run through the real replay route.
  const view = (await (await request.get("/api/replay/safe")).json()) as { events: { type: string }[]; outcome: string };
  const live = await answerLive(page, "safe", [
    { type: "info", text: "sandbox container up (no network, /work only)" },
    timeline(900, "fetch", "fetched https://honeypot.example/lumen-notes/"),
    timeline(1500, "deny", "read_file .env — denied by safe policy (no-env)"),
    { type: "end", view },
  ]);
  await page.goto("/");
  await page.getByRole("button", { name: "Run live" }).click();
  await expect(page.getByTestId("card-cost")).toContainText("run total");
  expect(live.posts()).toBe(1);
  const shown = await page.getByTestId("event").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-type") ?? ""));
  expect(shown).toEqual(view.events.map((e) => e.type));
  await expect(page.getByTestId("card-status")).toContainText("live ·");
  await expect(page.getByTestId("live-failed")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a live run whose sandbox was killed keeps its events and offers the golden replay", async ({ page }) => {
  const errors = watchConsole(page);
  await answerLive(page, "safe", [
    timeline(900, "fetch", "fetched https://honeypot.example/lumen-notes/"),
    timeline(1400, "read", "read_file MISSION.md"),
    { type: "failed", reason: "the sandbox container stopped during the run; the run was stopped" },
  ]);
  await page.goto("/");
  await page.getByRole("button", { name: "Run live" }).click();
  await expect(page.getByTestId("live-failed")).toContainText("Live run failed: the sandbox container stopped during the run");
  await expect(page.getByTestId("card-status-value")).toHaveText("Live run failed");
  await expect(page.getByTestId("event")).toHaveCount(2);
  await expect(page.getByTestId("card-cost")).not.toContainText("run total");

  await page.getByTestId("fallback-to-replay").click();
  await expect(page.getByTestId("live-failed")).toHaveCount(0);
  await expect(page.getByTestId("card-cost")).toContainText("run total", { timeout: 60_000 });
  await expect(page.getByTestId("card-status")).not.toContainText("live ·");
  expect(await page.getByTestId("event").last().getAttribute("data-type")).toBe("done");
  expect(errors).toEqual([]);
});

test("a refused start, a dropped stream and an HTTP error all show the fallback button", async ({ page }) => {
  await page.goto("/");
  const button = page.getByTestId("fallback-to-replay");

  await answerLive(page, "safe", [{ type: "failed", reason: "the honeypot is not reachable at its public URL" }]);
  await page.getByRole("button", { name: "Run live" }).click();
  await expect(page.getByTestId("live-failed")).toContainText("the honeypot is not reachable");
  await expect(button).toBeVisible();

  // Picking a mode clears the failure; a later answer for the same route replaces the earlier one.
  await page.getByRole("radio", { name: "Safe" }).click();
  await expect(button).toHaveCount(0);
  await answerLive(page, "safe", [timeline(100, "fetch", "fetched x")]);
  await page.getByRole("button", { name: "Run live" }).click();
  await expect(page.getByTestId("live-failed")).toContainText("the event stream ended before the run did");

  await page.route("**/api/live/safe", (route) => route.fulfill({ status: 403, json: { error: "live runs are started from the dashboard itself" } }));
  await page.getByRole("radio", { name: "Safe" }).click();
  await page.getByRole("button", { name: "Run live" }).click();
  await expect(page.getByTestId("live-failed")).toContainText("live runs are started from the dashboard itself");
  await expect(button).toBeVisible();
});

test("live is Safe mode only: other modes and the fallback run are replay, and the route refuses them and other sites", async ({ page, request }) => {
  await page.goto("/");
  const runLive = page.getByRole("button", { name: "Run live" });
  await expect(runLive).toBeEnabled();
  // The profile a run would start under is on the page before any click.
  const profile = page.getByTestId("live-profile");
  await expect(profile).toHaveAttribute("data-profile", /^(dev|rubric|invalid)$/);
  await expect(profile).toContainText(/open-weight models A\/B\/C|model D|will refuse/);
  for (const mode of ["Permissive", "Budget-limited"]) {
    await page.getByRole("radio", { name: mode }).click();
    await expect(runLive).toBeDisabled();
    await expect(page.getByRole("button", { name: "Replay golden" })).toBeEnabled();
  }
  await page.getByRole("radio", { name: "Safe" }).click();
  await page.getByRole("checkbox").check();
  await expect(runLive).toBeDisabled();
  expect((await request.post("/api/live/permissive", { data: {} })).status()).toBe(404);
  expect((await request.post("/api/live/budget", { data: {} })).status()).toBe(404);
  // Neither request reaches the orchestrator: no run is started.
  expect((await request.post("/api/live/control", { data: {} })).status()).toBe(404);
  expect((await request.post("/api/live/safe", { data: {}, headers: { origin: "https://evil.example" } })).status()).toBe(403);
});

test("the profile line follows .env: asked again on focus, and set by the run that just ended", async ({ page, request }) => {
  let profile: string | null = "dev";
  await page.route("**/api/live", (route) => route.fulfill({ json: { profile } }));
  await page.goto("/");
  const line = page.getByTestId("live-profile");
  // The window comes back after .env was edited: the line is asked for again, with no reload.
  // Focus is sent until the page has answered it: the listener is attached on hydration and ignores bursts.
  const afterFocus = async (want: string): Promise<void> => {
    await expect(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(line).toHaveAttribute("data-profile", want, { timeout: 400 });
    }).toPass({ timeout: 15_000 });
  };
  await afterFocus("dev");
  await expect(line).toContainText("model D");
  profile = "rubric";
  await afterFocus("rubric");
  await expect(line).toContainText("open-weight models A/B/C");
  profile = null;
  await afterFocus("invalid");
  await expect(line).toContainText("will refuse");

  // A run that ended names the profile it ran under; the line and the Status card show that one.
  const view = (await (await request.get("/api/replay/safe")).json()) as { profile: string };
  expect(view.profile).toBe("rubric");
  await answerLive(page, "safe", [{ type: "end", view }]);
  await page.getByRole("button", { name: "Run live" }).click();
  await expect(page.getByTestId("card-status")).toContainText("live · profile rubric");
  await expect(line).toHaveAttribute("data-profile", "rubric");
});

test("GET /api/live answers with the profile and nothing else", async ({ request }) => {
  const res = await request.get("/api/live");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(Object.keys(body)).toEqual(["profile"]);
  expect(["dev", "rubric", null]).toContain(body.profile);
});
