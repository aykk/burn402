import { getSession } from "@/lib/demo/session";
import { snapshot } from "@/lib/demo/snapshot";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(snapshot(await getSession()));
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 503 });
  }
}
