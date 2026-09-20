import { getSession } from "@/lib/demo/session";
import { setNetwork } from "@/lib/demo/runtime";
import { snapshot } from "@/lib/demo/snapshot";

export async function POST(request: Request) {
  const { network } = (await request.json()) as { network?: string };
  if (network !== "testnet" && network !== "production") return Response.json({ error: "network must be testnet or production" }, { status: 400 });
  const session = await getSession();
  setNetwork(session.rt, network);
  return Response.json(snapshot(session));
}
