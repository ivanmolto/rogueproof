import Dashboard from "../components/Dashboard";
import { liveProfile } from "../lib/live";

// Rendered per request: the live profile is read from the environment and .env each time the page loads.
export const dynamic = "force-dynamic";

export default async function Home() {
  return <Dashboard liveProfile={await liveProfile()} />;
}
