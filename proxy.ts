import { NextResponse, type NextRequest } from "next/server";
import { accessVerdict, headersOf, newSessionId, SESSION_COOKIE, sessionCookieValue, visitorOf } from "./lib/market/access";

/**
 * The gate in front of the API (Next 16 proxy, formerly middleware). A request under /api goes on
 * only when it is the owner's (this computer, the app's local name) or addressed to a listed public
 * host; writes must come from this app's own page; a public visitor never reaches the owner-only
 * routes. Anything else is refused with 403 before a route runs. Routes keep their own checks.
 *
 * A public visitor without a session cookie this server issued is given one here, on the request as
 * well as the response, so the route already sees it. The cookie carries the server's signature on the
 * id, so a visitor cannot make one up.
 */
export function proxy(request: NextRequest) {
  const h = headersOf(request.headers);
  const refused = accessVerdict(request.method, request.nextUrl.pathname, h);
  if (refused) return NextResponse.json({ error: refused }, { status: 403 });
  const v = visitorOf(h);
  if (v?.kind !== "public" || v.sid !== null) return NextResponse.next();

  const value = sessionCookieValue(newSessionId());
  const headers = new Headers(request.headers);
  // any cookie of the same name that this server did not issue is dropped, then the new one is added
  const others = (h.cookie ?? "").split(";").map((c) => c.trim()).filter((c) => c !== "" && !c.startsWith(`${SESSION_COOKIE}=`));
  headers.set("cookie", [...others, `${SESSION_COOKIE}=${value}`].join("; "));
  const response = NextResponse.next({ request: { headers } });
  response.cookies.set({ name: SESSION_COOKIE, value, httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 86_400 });
  return response;
}

export const config = {
  matcher: "/api/:path*",
};
