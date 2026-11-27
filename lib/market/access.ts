/**
 * Who is asking. The app has two kinds of visitor:
 *  - the owner: a browser on this computer, addressing the app by its local name. Everything is allowed,
 *    including the real market, which spends the owner's wallet.
 *  - the public: anyone reaching the app through a public host name listed in BURN402_PUBLIC_HOSTS (a
 *    tunnel or a reverse proxy). They get the test market only, each in a private session.
 * Anything else is refused. Functions of a few header values, so the request proxy (which must not
 * import node:fs) and the routes share one rule.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { localHosts, localOrigins } from "./local";

type Env = Record<string, string | undefined>;

/** The __Host- prefix makes browsers accept it only from this exact host, over https, for the whole site: a sibling subdomain cannot plant one. */
export const SESSION_COOKIE = "__Host-b402_sid";
/** The cookie's value: the session id, a dot, and this server's signature on the id. */
const SIGNED_SID_RE = /^([a-f0-9]{32})\.([a-f0-9]{32})$/;
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
  /** Any of these means a proxy handled the request: `Forwarded`, `Via`, `X-Real-IP`. */
  proxied: boolean;
  /** `Sec-Fetch-Site`, which browsers set and page scripts cannot change. */
  fetchSite: string | null;
  /** The owner key sent as a header (scripts and the app's own calls to itself); a browser sends it as a cookie. */
  ownerKey: string | null;
};

export function headersOf(h: { get(name: string): string | null }): AccessHeaders {
  return {
    host: h.get("host"),
    origin: h.get("origin"),
    cookie: h.get("cookie"),
    cfIp: h.get("cf-connecting-ip"),
    cfRay: h.get("cf-ray"),
    forwardedFor: h.get("x-forwarded-for"),
    proxied: h.get("forwarded") !== null || h.get("via") !== null || h.get("x-real-ip") !== null,
    fetchSite: h.get("sec-fetch-site"),
    ownerKey: h.get(OWNER_HEADER),
  };
}

/**
 * The owner key. When BURN402_OWNER_TOKEN is set (the public launcher makes one per start), a request is
 * the owner's only if it also carries that key, as the `b402_owner` cookie the launcher's link sets or as
 * the `x-b402-owner` header. Looking local is then not enough: a reverse proxy that rewrites the Host
 * header makes every visitor look local, and none of them has the key. Without the variable (plain
 * `npm run dev`, where nothing is public) the local name alone is the owner, as before.
 */
export const OWNER_COOKIE = "b402_owner";
export const OWNER_HEADER = "x-b402-owner";

export function ownerToken(env: Env = process.env): string | null {
  const t = env.BURN402_OWNER_TOKEN;
  return typeof t === "string" && t.length >= 32 ? t : null;
}

const cookieValue = (cookie: string | null, name: string): string | null => {
  for (const part of (cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
};

const sameText = (a: string, b: string): boolean => {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
};

/** True when no owner key is configured, or the request carries it. */
export function hasOwnerKey(h: Pick<AccessHeaders, "cookie" | "ownerKey">, env: Env = process.env): boolean {
  const token = ownerToken(env);
  if (token === null) return true;
  const given = h.ownerKey ?? cookieValue(h.cookie, OWNER_COOKIE);
  return given !== null && sameText(given, token);
}

/** True when `candidate` is the configured owner key (the launcher's link hands it over once). */
export function isOwnerToken(candidate: string | null, env: Env = process.env): boolean {
  const token = ownerToken(env);
  return token !== null && candidate !== null && sameText(candidate, token);
}

/** True when the request was addressed to the app's local name and nothing forwarded it. */
export function isLocalDirect(h: AccessHeaders, env: Env = process.env): boolean {
  return localHosts(env).has((h.host ?? "").toLowerCase()) && !forwarded(h);
}

/** True when the owner has opened the real market to public visitors, who then pay from their own wallets. */
export function publicReal(env: Env = process.env): boolean {
  return env.BURN402_PUBLIC_REAL === "1";
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

/**
 * True when the request came through a proxy or tunnel rather than straight from this computer. Any sign
 * of one counts: Cloudflare's headers, a `Forwarded`, `Via` or `X-Real-IP` header, or ANY address in
 * `X-Forwarded-For` that is not this computer (a visitor can put 127.0.0.1 first, but the proxy appends
 * the address it really saw). A proxy that rewrites the Host to the local name and adds none of these
 * cannot be told from the owner's own browser: never put one in front of this app (see the README).
 */
function forwarded(h: AccessHeaders): boolean {
  if (h.cfIp !== null || h.cfRay !== null || h.proxied) return true;
  return (h.forwardedFor ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .some((hop) => hop !== "" && !LOOPBACK_RE.test(hop));
}

/**
 * The key session ids are signed with: BURN402_SESSION_SECRET when the launcher set one, else a random
 * one made once per process. Sessions live in memory, so a key that changes on restart loses nothing.
 */
function sessionKey(env: Env): string {
  const set = env.BURN402_SESSION_SECRET;
  if (typeof set === "string" && set.length >= 32) return set;
  const g = globalThis as { __burn402SessionKey?: string };
  return (g.__burn402SessionKey ??= randomBytes(32).toString("hex"));
}

const tagOf = (sid: string, env: Env) => createHmac("sha256", sessionKey(env)).update(sid, "utf8").digest("hex").slice(0, 32);

/** What goes in the cookie: the id and this server's signature on it. */
export function sessionCookieValue(sid: string, env: Env = process.env): string {
  return `${sid}.${tagOf(sid, env)}`;
}

/**
 * The session id in the cookie, only when this server issued it: an id a visitor made up, or one issued
 * before the last restart, is no session at all, and the proxy hands out a fresh one.
 */
export function sessionIdFrom(cookie: string | null, env: Env = process.env): string | null {
  for (const part of (cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === SESSION_COOKIE) {
      const m = SIGNED_SID_RE.exec(part.slice(at + 1).trim());
      if (!m) return null;
      const expected = Buffer.from(tagOf(m[1], env), "utf8");
      const given = Buffer.from(m[2], "utf8");
      return expected.length === given.length && timingSafeEqual(expected, given) ? m[1] : null;
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
  // the local name through a tunnel is never the owner: only a request made on this computer is, and when an
  // owner key is configured, only one that carries it
  if (localHosts(env).has(host)) return forwarded(h) || !hasOwnerKey(h, env) ? null : OWNER;
  if (publicHosts(env).has(host)) {
    const ip = h.cfIp ?? firstHop(h.forwardedFor);
    return { kind: "public", host, ip: ip !== null && IP_RE.test(ip) ? ip : null, sid: sessionIdFrom(h.cookie, env) };
  }
  return null;
}

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/** What only the owner may reach: the test seller's own API (this app calls it from this computer; visitors never do). */
const OWNER_ONLY = ["/api/testseller", "/api/owner"];
/** Where the launcher's link hands the owner key to the browser: reachable on this computer before the key is held. */
export const OWNER_ENTRY = "/api/owner";
export const NEEDS_OWNER_KEY = "open this page from the link the launcher printed: it carries this computer's owner key";

export const NOT_PUBLIC = "This is not available on the public demo.";
/** The most a public visitor may set as a budget: they all spend one devnet wallet. */
export const PUBLIC_MAX_BUDGET_USD = 1;
/** On the real market a public visitor always pays from their own wallet and logs in with their own key. */
export const PUBLIC_REAL_NEEDS_WALLET = "On the real market you pay from your own wallet. Choose My wallet and connect it.";
export const PUBLIC_REAL_NEEDS_KEY = "Add your SSH public key: it is how you log in to the machine you pay for.";

export const PUBLIC_TEST_ONLY = "The public demo runs on the test market only: test money and simulated machines.";

/**
 * The rule for a request under /api. Null when it may go on; else the reason it is refused (403).
 * Owner: as before, the local host, and an Origin (when there is one) that is this app's own page.
 * Public: a listed host, nothing owner-only, and every write must carry this site's own https Origin.
 */
export function accessVerdict(method: string, pathname: string, h: AccessHeaders, env: Env = process.env): string | null {
  // the one address that must answer before the owner key is held: it is how the browser gets it
  if (pathname === OWNER_ENTRY && method.toUpperCase() === "GET" && isLocalDirect(h, env)) return null;
  const v = visitorOf(h, env);
  if (!v) return isLocalDirect(h, env) ? NEEDS_OWNER_KEY : `this app only answers on ${[...localHosts(env), ...publicHosts(env)].join(" or ")}`;
  const write = !READS.has(method.toUpperCase());
  if (v.kind === "owner") {
    if (write && h.origin !== null && !localOrigins(env).has(h.origin)) return "requests from other websites are not allowed";
    // the browser's own word on where a request came from: another site, or another app on this computer
    if (write && (h.fetchSite === "cross-site" || h.fetchSite === "same-site")) return "requests from other websites are not allowed";
    return null;
  }
  if (OWNER_ONLY.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NOT_PUBLIC;
  if (write && h.origin !== `https://${v.host}`) return "requests from other websites are not allowed";
  return null;
}
