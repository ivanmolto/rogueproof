// POST /api/live/safe (the only live mode, lib/view.ts LIVE_MODE_KEYS): starts `run:<mode>` through the
// orchestrator and streams the run as server-sent events (lib/sse.ts): each
// timeline event as it happens, then `end` with the saved run or `failed` with
// the reason. A real run: real Otari calls, real cost, the sandbox container.
// The orchestrator stops it after four minutes. A browser that goes away does not
// stop it: the run finishes and saves its run.json under runs/ (lib/live.ts).
import { liveStream, sameOrigin } from "../../../../lib/live";
import { isLiveModeKey } from "../../../../lib/view";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ mode: string }> }): Promise<Response> {
  const { mode } = await params;
  if (!isLiveModeKey(mode)) return Response.json({ error: `no live run for "${mode.slice(0, 40)}": live runs are Safe mode only` }, { status: 404 });
  if (!sameOrigin(request.headers)) return Response.json({ error: "live runs are started from the dashboard itself" }, { status: 403 });
  return new Response(liveStream(mode, request.signal), {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      // no-transform: a compressed stream would be held back until it ends.
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
