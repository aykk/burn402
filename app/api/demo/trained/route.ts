import { getSession } from "@/lib/demo/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getSession();
  const id = new URL(request.url).searchParams.get("job");
  const run = session.job && (!id || session.job.id === id) ? session.job : null;
  if (run?.trained) return Response.json({ id: run.id, kind: run.spec.kind, dataset: run.spec.dataset, model: run.trained });
  return Response.json({ error: "no trained model for that job yet" }, { status: 404 });
}
