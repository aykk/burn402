import { isProvider, selectModel } from "@/lib/demo/models";
import { getSession } from "@/lib/demo/session";
import { snapshotFor } from "@/lib/demo/snapshot";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { provider?: unknown; key?: unknown };
  if (!isProvider(body.provider)) return Response.json({ error: "unknown provider" }, { status: 400 });
  const session = await getSession();
  if (session.marketBusy) return Response.json({ error: "wait for the run to finish" }, { status: 409 });
  selectModel(body.provider, typeof body.key === "string" ? body.key : undefined);
  return Response.json(snapshotFor(session, request));
}
