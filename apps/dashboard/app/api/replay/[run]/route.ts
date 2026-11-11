// GET /api/replay/<run>: the replayed timeline of one golden run, rebuilt by
// the orchestrator from run.json + log.txt. No model call, no network, no key.
import { loadReplay } from "../../../../lib/runs";
import { isRunKey } from "../../../../lib/view";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ run: string }> }): Promise<Response> {
  const { run } = await params;
  if (!isRunKey(run)) return Response.json({ error: `unknown run "${run.slice(0, 40)}"` }, { status: 404 });
  try {
    return Response.json(await loadReplay(run));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "replay failed" }, { status: 500 });
  }
}
