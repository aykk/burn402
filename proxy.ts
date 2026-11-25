import { NextResponse, type NextRequest } from "next/server";
import { proxyVerdict } from "./lib/market/local";

/**
 * Local-only rule for the API (Next 16 proxy, formerly middleware). Every request under /api that
 * is not GET, HEAD or OPTIONS must be addressed to this app by its local name and, when it carries
 * an Origin, come from this app's own page; reads of /api/market and /api/testseller get the host
 * check. Anything else is refused with 403 before a route runs. Routes keep their own checks.
 */
export function proxy(request: NextRequest) {
  const refused = proxyVerdict(request.method, request.nextUrl.pathname, { host: request.headers.get("host"), origin: request.headers.get("origin") });
  if (refused) return NextResponse.json({ error: refused }, { status: 403 });
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
