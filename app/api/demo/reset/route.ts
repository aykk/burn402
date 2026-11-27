import { getRuntime, peekSession, resetSession, ResetRefusedError } from "@/lib/demo/session";
import { snapshotFor } from "@/lib/demo/snapshot";
import { errorFor } from "@/lib/demo/visit";
import { accessVerdict, headersOf, visitorOf } from "@/lib/market/access";

/** Forgets the asking visitor's session only. A public visitor with nothing started has nothing to reset. */
export async function POST(request: Request) {
  // the proxy applies this rule too; the route keeps its own check, so a reset can never come from another website
  const h = headersOf(request.headers);
  const refused = accessVerdict(request.method, new URL(request.url).pathname, h);
  if (refused) return Response.json({ error: refused }, { status: 403 });
  const v = visitorOf(h);
  if (!v) return Response.json({ error: "this app does not answer on that address" }, { status: 403 });
  try {
    const rt = await getRuntime();
    if (v.kind === "public" && !(await peekSession(v))) return Response.json(snapshotFor(rt, null, v));
    return Response.json(snapshotFor(rt, await resetSession(v), v));
  } catch (error) {
    if (error instanceof ResetRefusedError) return Response.json({ error: error.message }, { status: 409 });
    return Response.json({ error: errorFor(v, error) }, { status: 503 });
  }
}
