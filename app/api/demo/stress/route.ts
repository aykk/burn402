import { getSession } from "@/lib/demo/session";
import { snapshot } from "@/lib/demo/snapshot";

export async function POST(request: Request) {
  const session = await getSession();
  if (session.busy) return Response.json({ error: "something else is running; wait for it to finish" }, { status: 409 });
  const body = (await request.json().catch(() => ({}))) as { jobId?: string };
  const job = body.jobId ? session.jobFor(body.jobId) : session.finished()[0];
  if (!job || job.chain.length === 0) {
    return Response.json({ error: "run a job first: the stress test attacks the budget that job used" }, { status: 400 });
  }
  void session.runStressTest(job.id);
  return Response.json(snapshot(session));
}
