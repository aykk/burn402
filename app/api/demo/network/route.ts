import { getSession } from "@/lib/demo/session";
import { setDisclosure, setNetwork } from "@/lib/demo/runtime";
import { snapshot } from "@/lib/demo/snapshot";

export async function POST(request: Request) {
  const { network, disclosure } = (await request.json()) as { network?: string; disclosure?: string };
  const session = await getSession();
  if (disclosure !== undefined) {
    if (disclosure !== "desk-only" && disclosure !== "full") return Response.json({ error: "disclosure must be desk-only or full" }, { status: 400 });
    setDisclosure(session.rt, disclosure);
    if (network === undefined) return Response.json(snapshot(session));
  }
  if (network !== "testnet" && network !== "production") return Response.json({ error: "network must be testnet or production" }, { status: 400 });
  setNetwork(session.rt, network);
  return Response.json(snapshot(session));
}
