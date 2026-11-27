import { headersOf, isLocalDirect, isOwnerToken, OWNER_COOKIE, ownerToken } from "@/lib/market/access";

/**
 * Hands the owner key to the owner's browser. The public launcher prints (and opens) a link to this
 * address carrying the key it made for this start; a right key is stored as an HttpOnly cookie and the
 * browser goes on to the app, so the key leaves the address bar at once. Only on this computer: a request
 * that came through a tunnel or a proxy is refused before the key is looked at.
 */
export async function GET(request: Request) {
  if (!isLocalDirect(headersOf(request.headers))) return Response.json({ error: "this address only answers on this computer" }, { status: 403 });
  const home = new Response(null, { status: 303, headers: { Location: "/", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  // nothing public is running: the local name is the owner already
  if (ownerToken() === null) return home;
  const given = new URL(request.url).searchParams.get("token");
  if (!isOwnerToken(given)) return Response.json({ error: "that is not this computer\u2019s owner key; use the link the launcher printed last" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  home.headers.append("Set-Cookie", `${OWNER_COOKIE}=${given}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`);
  return home;
}
