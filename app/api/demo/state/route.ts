import { snapshotFor } from "@/lib/demo/snapshot";
import { visit } from "@/lib/demo/visit";

export const dynamic = "force-dynamic";

/** The page's state, for the visitor asking. Reading it never creates a session. */
export async function GET(request: Request) {
  const who = await visit(request, { create: false });
  if (who instanceof Response) return who;
  return Response.json(snapshotFor(who.rt, who.session, who.v), { headers: { "Cache-Control": "no-store" } });
}
