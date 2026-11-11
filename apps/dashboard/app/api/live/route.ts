// GET /api/live: the MODEL_PROFILE a live run started now would use, as the
// orchestrator resolves it (the server's environment, then the repo's .env).
// The page asks again whenever its window regains focus, so an edit to .env
// shows without a reload. No key, no gateway call.
import { liveProfile } from "../../../lib/live";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    return Response.json({ profile: await liveProfile() }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "profile not readable" }, { status: 500 });
  }
}
