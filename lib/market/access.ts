/**
 * Who is asking. The app has two kinds of visitor:
 *  - the owner: a browser on this computer, addressing the app by its local name. Everything is allowed,
 *    including the real market, which spends the owner's wallet.
 *  - the public: anyone reaching the app through a public host name listed in BURN402_PUBLIC_HOSTS (a
 *    tunnel or a reverse proxy). They get the test market only, each in a private session.
 * Anything else is refused. Pure functions of a few header values, so the request proxy (which must not
 * import node:fs) and the routes share one rule.
 */
import { localHosts, localOrigins } from "./local";

type Env = Record<string, string | undefined>;

export const SESSION_COOKIE = "b402_sid";
const SID_RE = /^[a-f0-9]{32}$/;
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const LOOPBACK_RE = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
const IP_RE = /^[0-9a-fA-F:.]{3,45}$/;

export type AccessHeaders = {
  host: string | null;
  origin: string | null;
  cookie: string | null;
  /** Cloudflare's edge sets these on every request it forwards; a visitor cannot remove them. */
  cfIp: string | null;
  cfRay: string | null;
  forwardedFor: string | null;
};

export function headersOf(h: { get(name: string): string | null }): AccessHeaders {
  return {
    host: h.get("host"),
    origin: h.get("origin"),
    cookie: h.get("cookie"),
    cfIp: h.get("cf-connecting-ip"),
    cfRay: h.get("cf-ray"),
    forwardedFor: h.get("x-forwarded-for"),
  };
}

/** The public host names this app answers on, from BURN402_PUBLIC_HOSTS (comma separated, no scheme or port). */
export function publicHosts(env: Env = process.env): Set<string> {
  return new Set(
    (env.BURN402_PUBLIC_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter((h) => HOSTNAME_RE.test(h) && h.length <= 253),
  );
}

const firstHop = (forwardedFor: string | null): string | null => {
  const hop = (forwardedFor ?? "").split(",")[0].trim();
  return hop === "" ? null : hop;
};

/** True when the request came through a proxy or tunnel rather than straight from this computer. */
function forwarded(h: AccessHeaders): boolean {
  if (h.cfIp !== null || h.cfRay !== null) return true;
  const hop = firstHop(h.forwardedFor);
  return hop !== null && !LOOPBACK_RE.test(hop);
}

export function sessionIdFrom(cookie: string | null): string | null {
  for (const part of (cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === SESSION_COOKIE) {
      const value = part.slice(at + 1).trim();
      return SID_RE.test(value) ? value : null;
    }
  }
  return null;
}

/** 128 random bits, hex. Web Crypto, so it works in the request proxy too. */
export function newSessionId(): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type Visitor = { kind: "owner" } | { kind: "public"; host: string; ip: string | null; sid: string | null };

export const OWNER: Visitor = { kind: "owner" };

/** Null when the request is neither the owner's nor addressed to a listed public host. */
export function visitorOf(h: AccessHeaders, env: Env = process.env): Visitor | null {
  const host = (h.host ?? "").toLowerCase();
  // the local name through a tunnel is never the owner: only a request made on this computer is
  if (localHosts(env).has(host)) return forwarded(h) ? null : OWNER;
  if (publicHosts(env).has(host)) {
    const ip = h.cfIp ?? firstHop(h.forwardedFor);
    return { kind: "public", host, ip: ip !== null && IP_RE.test(ip) ? ip : null, sid: sessionIdFrom(h.cookie) };
  }
  return null;
}

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/** What only the owner may reach: the test seller's own API, the model key and anything that spends a model key. */
const OWNER_ONLY = ["/api/testseller", "/api/demo/model", "/api/market/parse"];

export const NOT_PUBLIC = "This is not available on the public demo.";
export const PUBLIC_TEST_ONLY = "The public demo runs on the test market only: test money and simulated machines.";

/**
 * The rule for a request under /api. Null when it may go on; else the reason it is refused (403).
 * Owner: as before, the local host, and an Origin (when there is one) that is this app's own page.
 * Public: a listed host, nothing owner-only, and every write must carry this site's own https Origin.
 */
export function accessVerdict(method: string, pathname: string, h: AccessHeaders, env: Env = process.env): string | null {
  const v = visitorOf(h, env);
  if (!v) return `this app only answers on ${[...localHosts(env), ...publicHosts(env)].join(" or ")}`;
  const write = !READS.has(method.toUpperCase());
  if (v.kind === "owner") {
    if (write && h.origin !== null && !localOrigins(env).has(h.origin)) return "requests from other websites are not allowed";
    return null;
  }
  if (OWNER_ONLY.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NOT_PUBLIC;
  if (write && h.origin !== `https://${v.host}`) return "requests from other websites are not allowed";
  return null;
}
