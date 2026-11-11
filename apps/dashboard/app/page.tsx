import Dashboard from "../components/Dashboard";
import { comparisonView } from "../lib/compare";
import { liveProfile } from "../lib/live";
import { loadReplay } from "../lib/runs";
import { MODES, type ModeKey, type ReplayView } from "../lib/view";

// Rendered per request: the live profile is read from the environment and .env each time the page loads.
export const dynamic = "force-dynamic";

/** The three golden runs, replayed offline. A run that cannot be read is shown as not recorded. */
async function goldenRuns(): Promise<Partial<Record<ModeKey, ReplayView | null>>> {
  const loaded = await Promise.all(MODES.map(async (m) => [m.key, await loadReplay(m.key).catch(() => null)] as const));
  return Object.fromEntries(loaded);
}

export default async function Home() {
  const [profile, runs] = await Promise.all([liveProfile(), goldenRuns()]);
  return <Dashboard liveProfile={profile} comparison={comparisonView(runs)} />;
}
