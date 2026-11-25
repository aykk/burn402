import { getSession } from "@/lib/demo/session";
import { snapshotFor } from "@/lib/demo/snapshot";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return Response.json(snapshotFor(await getSession(), request));
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 503 });
  }
}
