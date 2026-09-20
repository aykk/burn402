import { getSession } from "@/lib/demo/session";
import { snapshot } from "@/lib/demo/snapshot";

export async function POST() {
  const session = await getSession();
  if (!session.busy) void session.runStressTest();
  return Response.json(snapshot(session));
}
