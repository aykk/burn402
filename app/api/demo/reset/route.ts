import { resetSession, ResetRefusedError } from "@/lib/demo/session";
import { snapshotFor } from "@/lib/demo/snapshot";

export async function POST(request: Request) {
  try {
    return Response.json(snapshotFor(await resetSession(), request));
  } catch (error) {
    if (error instanceof ResetRefusedError) return Response.json({ error: error.message }, { status: 409 });
    return Response.json({ error: (error as Error).message }, { status: 503 });
  }
}
