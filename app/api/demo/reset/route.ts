import { resetSession } from "@/lib/demo/session";
import { snapshot } from "@/lib/demo/snapshot";

export async function POST() {
  try {
    return Response.json(snapshot(await resetSession()));
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 503 });
  }
}
