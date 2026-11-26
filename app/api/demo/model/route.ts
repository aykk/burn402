import { isProvider, selectModel } from "@/lib/demo/models";
import { getRuntime, getSession } from "@/lib/demo/session";
import { snapshotFor } from "@/lib/demo/snapshot";
import { NOT_PUBLIC, OWNER } from "@/lib/market/access";
import { isOwner } from "@/lib/market/session";

/** Picks the model and stores its key. Owner only: the key is the owner's, kept in this process's memory. */
export async function POST(request: Request) {
  if (!isOwner(request)) return Response.json({ error: NOT_PUBLIC }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { provider?: unknown; key?: unknown };
  if (!isProvider(body.provider)) return Response.json({ error: "unknown provider" }, { status: 400 });
  const session = await getSession(OWNER);
  if (session.marketBusy) return Response.json({ error: "wait for the run to finish" }, { status: 409 });
  selectModel(body.provider, typeof body.key === "string" ? body.key : undefined);
  return Response.json(snapshotFor(await getRuntime(), session, OWNER));
}
