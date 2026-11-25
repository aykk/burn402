import { getSession } from "@/lib/demo/session";
import { snapshotFor } from "@/lib/demo/snapshot";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session.busy) void session.runAgent();
  return Response.json(snapshotFor(session, request));
}
