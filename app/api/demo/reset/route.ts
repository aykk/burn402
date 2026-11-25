import { resetSession } from "@/lib/demo/session";
import { snapshotFor } from "@/lib/demo/snapshot";

export async function POST(request: Request) {
  try {
    return Response.json(snapshotFor(await resetSession(), request));
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 503 });
  }
}
