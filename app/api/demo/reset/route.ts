import { getRuntime, peekSession, resetSession, ResetRefusedError } from "@/lib/demo/session";
import { snapshotFor } from "@/lib/demo/snapshot";
import { headersOf, visitorOf } from "@/lib/market/access";

/** Forgets the asking visitor's session only. A public visitor with nothing started has nothing to reset. */
export async function POST(request: Request) {
  const v = visitorOf(headersOf(request.headers));
  if (!v) return Response.json({ error: "this app does not answer on that address" }, { status: 403 });
  try {
    const rt = await getRuntime();
    if (v.kind === "public" && !(await peekSession(v))) return Response.json(snapshotFor(rt, null, v));
    return Response.json(snapshotFor(rt, await resetSession(v), v));
  } catch (error) {
    if (error instanceof ResetRefusedError) return Response.json({ error: error.message }, { status: 409 });
    return Response.json({ error: (error as Error).message }, { status: 503 });
  }
}
