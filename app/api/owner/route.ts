import { hasOwnerKey, headersOf, isLocalDirect, isOwnerEntry, OWNER_COOKIE, ownerToken } from "@/lib/market/access";

/**
 * Hands the owner key to the owner's browser. The public launcher prints (and opens) a link to this
 * address carrying a one-time code; the first request with the right code is answered with the owner key
 * as an HttpOnly cookie, and the browser goes on to the app. The code is not the key and works once: the
 * link stays in the terminal and in the browser's history, where it is then worth nothing. Only on this
 * computer: a request that came through a tunnel or a proxy is refused before the code is looked at.
 */
const used = ((globalThis as unknown as { __burn402OwnerEntryUsed?: Set<string> }).__burn402OwnerEntryUsed ??= new Set<string>());

export async function GET(request: Request) {
  const h = headersOf(request.headers);
  if (!isLocalDirect(h)) return Response.json({ error: "this address only answers on this computer" }, { status: 403 });
  const home = () => new Response(null, { status: 303, headers: { Location: "/", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  // nothing to hand over: no key is needed (nothing public is running), or this browser holds it already
  const token = ownerToken();
  if (token === null || hasOwnerKey(h)) return home();
  const given = new URL(request.url).searchParams.get("token");
  const refused = (error: string) => Response.json({ error }, { status: 403, headers: { "Cache-Control": "no-store" } });
  if (!isOwnerEntry(given)) return refused("that is not a link the launcher printed for this start");
  if (used.has(given!)) return refused("that link was used already; run npm run public again for a new one (the public address stays the same)");
  used.add(given!);
  const response = home();
  response.headers.append("Set-Cookie", `${OWNER_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`);
  return response;
}
