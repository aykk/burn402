import { describe, expect, it } from "vitest";
import { accessVerdict, hasOwnerKey, headersOf, isLocalDirect, isOwnerEntry, newSessionId, publicHosts, publicReal, sessionCookieValue, sessionIdFrom, visitorOf, type AccessHeaders } from "./access";

/** The owner key the public launcher would have made; a public site always has one. */
const OWNER = "o".repeat(64);
const env = { BURN402_PUBLIC_HOSTS: "demo.example.com, Another.Example.org ,bad host,http://x.com", BURN402_SESSION_SECRET: "k".repeat(40), BURN402_OWNER_TOKEN: OWNER };
const h = (over: Partial<AccessHeaders>): AccessHeaders => ({ host: null, origin: null, cookie: null, cfIp: null, cfRay: null, forwardedFor: null, proxied: false, fetchSite: null, ownerKey: OWNER, ...over });
const SID = "0123456789abcdef0123456789abcdef";

describe("public hosts", () => {
  it("reads a comma list, lowercased, and drops anything that is not a host name", () => {
    expect([...publicHosts(env)]).toEqual(["demo.example.com", "another.example.org"]);
    expect(publicHosts({}).size).toBe(0);
  });
});

describe("visitorOf", () => {
  it("the local name, straight from this computer, is the owner", () => {
    expect(visitorOf(h({ host: "127.0.0.1:3000" }), env)).toEqual({ kind: "owner" });
    expect(visitorOf(h({ host: "localhost:3000", forwardedFor: "::1" }), env)).toEqual({ kind: "owner" });
    expect(visitorOf(h({ host: "127.0.0.1:3000", forwardedFor: "::ffff:127.0.0.1" }), env)).toEqual({ kind: "owner" });
  });
  it("the local name through a tunnel or proxy is nobody", () => {
    expect(visitorOf(h({ host: "127.0.0.1:3000", cfIp: "203.0.113.9" }), env)).toBeNull();
    expect(visitorOf(h({ host: "127.0.0.1:3000", cfRay: "abc" }), env)).toBeNull();
    expect(visitorOf(h({ host: "localhost:3000", forwardedFor: "203.0.113.9, 127.0.0.1" }), env)).toBeNull();
  });
  it("a visitor who puts this computer first in X-Forwarded-For is still nobody: the proxy appended the address it saw", () => {
    expect(visitorOf(h({ host: "127.0.0.1:3000", forwardedFor: "127.0.0.1, 203.0.113.9" }), env)).toBeNull();
    expect(visitorOf(h({ host: "127.0.0.1:3000", forwardedFor: "::1,127.0.0.1 , 198.51.100.7" }), env)).toBeNull();
    // every hop on this computer is still the owner
    expect(visitorOf(h({ host: "127.0.0.1:3000", forwardedFor: "127.0.0.1, ::1" }), env)).toEqual({ kind: "owner" });
  });
  it("any other sign of a proxy (Forwarded, Via, X-Real-IP) makes the local name nobody", () => {
    expect(visitorOf(h({ host: "127.0.0.1:3000", proxied: true }), env)).toBeNull();
    for (const name of ["forwarded", "via", "x-real-ip"]) {
      const headers = new Headers({ host: "127.0.0.1:3000", [name]: "1.1 edge" });
      expect(headersOf(headers).proxied).toBe(true);
      expect(visitorOf(headersOf(headers), env)).toBeNull();
    }
    expect(headersOf(new Headers({ host: "127.0.0.1:3000" })).proxied).toBe(false);
  });
  it("a listed public host is a public visitor, with its address and session", () => {
    expect(visitorOf(h({ host: "Demo.Example.com", cfIp: "203.0.113.9", cookie: `a=1; __Host-b402_sid=${sessionCookieValue(SID, env)}` }), env)).toEqual({ kind: "public", host: "demo.example.com", ip: "203.0.113.9", sid: SID });
    expect(visitorOf(h({ host: "demo.example.com" }), env)).toEqual({ kind: "public", host: "demo.example.com", ip: null, sid: null });
  });
  it("any other host, or no public hosts configured, is nobody", () => {
    expect(visitorOf(h({ host: "evil.example" }), env)).toBeNull();
    expect(visitorOf(h({ host: "demo.example.com" }), {})).toBeNull();
    expect(visitorOf(h({}), env)).toBeNull();
  });
});

describe("session ids", () => {
  it("are 32 hex characters and never repeat", () => {
    const a = newSessionId();
    expect(a).toMatch(/^[a-f0-9]{32}$/);
    expect(newSessionId()).not.toBe(a);
  });
  it("are read from the cookie only when this server signed them", () => {
    const signed = sessionCookieValue(SID, env);
    expect(signed).toMatch(/^[a-f0-9]{32}\.[a-f0-9]{32}$/);
    expect(sessionIdFrom(`__Host-b402_sid=${signed}`, env)).toBe(SID);
    expect(sessionIdFrom(`a=1; __Host-b402_sid=${signed}; b=2`, env)).toBe(SID);
    // an id a visitor made up, with no signature or a wrong one, is no session
    expect(sessionIdFrom(`__Host-b402_sid=${SID}`, env)).toBeNull();
    expect(sessionIdFrom(`__Host-b402_sid=${SID}.${"0".repeat(32)}`, env)).toBeNull();
    // the signature of one id does not carry over to another
    const other = "f".repeat(32);
    expect(sessionIdFrom(`__Host-b402_sid=${other}.${signed.split(".")[1]}`, env)).toBeNull();
    // a cookie signed with another key (before a restart, or by another server) is no session
    expect(sessionIdFrom(`__Host-b402_sid=${signed}`, { BURN402_SESSION_SECRET: "z".repeat(40) })).toBeNull();
    expect(sessionIdFrom("__Host-b402_sid=../../etc/passwd", env)).toBeNull();
    expect(sessionIdFrom("other=1", env)).toBeNull();
    expect(sessionIdFrom(null, env)).toBeNull();
  });
  it("without a configured key, one process still signs and reads its own ids", () => {
    const signed = sessionCookieValue(SID, {});
    expect(sessionIdFrom(`__Host-b402_sid=${signed}`, {})).toBe(SID);
    // a short BURN402_SESSION_SECRET is not used as a key
    expect(sessionIdFrom(`__Host-b402_sid=${signed}`, { BURN402_SESSION_SECRET: "short" })).toBe(SID);
  });

});

describe("accessVerdict", () => {
  const pub = { host: "demo.example.com", cfIp: "203.0.113.9" };
  it("owner: reads and same-origin writes pass; a cross-site write is refused", () => {
    expect(accessVerdict("GET", "/api/demo/state", h({ host: "127.0.0.1:3000" }), env)).toBeNull();
    expect(accessVerdict("POST", "/api/market/run", h({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }), env)).toBeNull();
    expect(accessVerdict("POST", "/api/market/run", h({ host: "127.0.0.1:3000" }), env)).toBeNull();
    expect(accessVerdict("POST", "/api/market/run", h({ host: "127.0.0.1:3000", origin: "https://evil.example" }), env)).toMatch(/other websites/);
  });
  it("owner: a write the browser marks as coming from another site, or another app on this computer, is refused", () => {
    expect(accessVerdict("POST", "/api/market/run", h({ host: "127.0.0.1:3000", fetchSite: "cross-site" }), env)).toMatch(/other websites/);
    expect(accessVerdict("POST", "/api/demo/reset", h({ host: "127.0.0.1:3000", fetchSite: "same-site" }), env)).toMatch(/other websites/);
    // the app's own page, a typed address, and a script with no such header all pass
    expect(accessVerdict("POST", "/api/market/run", h({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", fetchSite: "same-origin" }), env)).toBeNull();
    expect(accessVerdict("POST", "/api/market/run", h({ host: "127.0.0.1:3000", fetchSite: "none" }), env)).toBeNull();
    expect(accessVerdict("POST", "/api/market/run", h({ host: "127.0.0.1:3000" }), env)).toBeNull();
    // reads are not affected: another site cannot read the answer anyway
    expect(accessVerdict("GET", "/api/demo/state", h({ host: "127.0.0.1:3000", fetchSite: "cross-site" }), env)).toBeNull();
  });
  it("owner-only paths are open to the owner", () => {
    expect(accessVerdict("POST", "/api/testseller/compute/provision", h({ host: "127.0.0.1:3000" }), env)).toBeNull();
  });
  it("public: reads pass; writes need this site's own https origin", () => {
    expect(accessVerdict("GET", "/api/demo/state", h(pub), env)).toBeNull();
    expect(accessVerdict("POST", "/api/market/run", h({ ...pub, origin: "https://demo.example.com" }), env)).toBeNull();
    expect(accessVerdict("POST", "/api/market/run", h(pub), env)).toMatch(/other websites/);
    expect(accessVerdict("POST", "/api/market/run", h({ ...pub, origin: "http://demo.example.com" }), env)).toMatch(/other websites/);
    expect(accessVerdict("POST", "/api/market/run", h({ ...pub, origin: "https://another.example.org" }), env)).toMatch(/other websites/);
  });
  it("public: the test seller's own API is refused, reads included", () => {
    for (const path of ["/api/testseller/compute/plans", "/api/testseller"]) {
      expect(accessVerdict("GET", path, h(pub), env)).toMatch(/not available/);
      expect(accessVerdict("POST", path, h({ ...pub, origin: "https://demo.example.com" }), env)).toMatch(/not available/);
    }
    expect(accessVerdict("GET", "/api/testsellers", h(pub), env)).toBeNull();
  });
  it("an unlisted host is refused whatever it sends", () => {
    expect(accessVerdict("GET", "/api/demo/state", h({ host: "evil.example" }), env)).toMatch(/only answers on/);
    expect(accessVerdict("GET", "/api/demo/state", h({ host: "127.0.0.1:3000", cfIp: "203.0.113.9" }), env)).toMatch(/only answers on/);
  });
});

describe("the owner key", () => {
  const KEY = OWNER;
  const keyed = env;
  const bare = (over: Partial<AccessHeaders>) => h({ ownerKey: null, ...over });

  it("with nothing public and no key set, the local name alone is the owner (plain development)", () => {
    expect(visitorOf(bare({ host: "127.0.0.1:3000" }), {})).toEqual({ kind: "owner" });
    expect(hasOwnerKey(bare({}), {})).toBe(true);
  });

  it("a public site with no key, or one too short to be a key, has no owner at all", () => {
    const noKey = { BURN402_PUBLIC_HOSTS: "demo.example.com" };
    expect(visitorOf(bare({ host: "127.0.0.1:3000" }), noKey)).toBeNull();
    expect(visitorOf(bare({ host: "127.0.0.1:3000" }), { ...noKey, BURN402_OWNER_TOKEN: "short" })).toBeNull();
    // a short key is not accepted even when the request repeats it
    expect(visitorOf(bare({ host: "127.0.0.1:3000", ownerKey: "short" }), { ...noKey, BURN402_OWNER_TOKEN: "short" })).toBeNull();
    expect(visitorOf(bare({ host: "127.0.0.1:3000", ownerKey: "short" }), { BURN402_OWNER_TOKEN: "short" })).toBeNull();
    // the public side is unaffected
    expect(visitorOf(bare({ host: "demo.example.com" }), noKey)?.kind).toBe("public");
  });

  it("with a key, looking local is not enough: a proxy that rewrites the Host makes anyone look local", () => {
    // exactly what nginx's default proxy_pass sends: the local Host and nothing else
    expect(visitorOf(bare({ host: "127.0.0.1:3000" }), keyed)).toBeNull();
    expect(accessVerdict("GET", "/api/demo/state", bare({ host: "127.0.0.1:3000" }), keyed)).toMatch(/owner key/);
    expect(accessVerdict("POST", "/api/market/run", bare({ host: "127.0.0.1:3000" }), keyed)).toMatch(/owner key/);
    expect(accessVerdict("GET", "/api/testseller/compute/plans", bare({ host: "127.0.0.1:3000" }), keyed)).toMatch(/owner key/);
  });

  it("the key as a cookie (the browser) or a header (scripts, the app's own calls) is the owner", () => {
    expect(visitorOf(bare({ host: "127.0.0.1:3000", cookie: `x=1; b402_owner=${KEY}` }), keyed)).toEqual({ kind: "owner" });
    expect(visitorOf(bare({ host: "127.0.0.1:3000", ownerKey: KEY }), keyed)).toEqual({ kind: "owner" });
    expect(headersOf(new Headers({ host: "127.0.0.1:3000", "x-b402-owner": KEY })).ownerKey).toBe(KEY);
    // a wrong key, a near miss, an empty one
    for (const bad of ["z".repeat(64), KEY.slice(1), `${KEY}o`, ""]) {
      expect(visitorOf(bare({ host: "127.0.0.1:3000", cookie: `b402_owner=${bad}` }), keyed)).toBeNull();
      expect(visitorOf(bare({ host: "127.0.0.1:3000", ownerKey: bad }), keyed)).toBeNull();
    }
  });

  it("the key never makes a forwarded request the owner, and a public visitor is still public", () => {
    expect(visitorOf(h({ host: "127.0.0.1:3000", cfRay: "x" }), keyed)).toBeNull();
    expect(visitorOf(h({ host: "127.0.0.1:3000", forwardedFor: "127.0.0.1, 203.0.113.9" }), keyed)).toBeNull();
    expect(visitorOf(h({ host: "demo.example.com", cfIp: "203.0.113.9" }), keyed)?.kind).toBe("public");
  });

  it("the address that hands the key over answers on this computer before the key is held, and nowhere else", () => {
    expect(accessVerdict("GET", "/api/owner", bare({ host: "127.0.0.1:3000" }), keyed)).toBeNull();
    expect(accessVerdict("POST", "/api/owner", bare({ host: "127.0.0.1:3000" }), keyed)).toMatch(/owner key/);
    expect(accessVerdict("GET", "/api/owner/x", bare({ host: "127.0.0.1:3000" }), keyed)).toMatch(/owner key/);
    expect(accessVerdict("GET", "/api/owner", bare({ host: "127.0.0.1:3000", cfRay: "x" }), keyed)).not.toBeNull();
    expect(accessVerdict("GET", "/api/owner", h({ host: "demo.example.com", cfIp: "203.0.113.9" }), keyed)).toBe("This is not available on the public demo.");
    expect(isLocalDirect(bare({ host: "127.0.0.1:3000" }), keyed)).toBe(true);
    expect(isLocalDirect(bare({ host: "127.0.0.1:3000", proxied: true }), keyed)).toBe(false);
    expect(isLocalDirect(bare({ host: "demo.example.com" }), keyed)).toBe(false);
  });

  it("the launcher's link carries a one-time code that is not the key", () => {
    const CODE = "c".repeat(64);
    const withCode = { ...keyed, BURN402_OWNER_ENTRY: CODE };
    expect(isOwnerEntry(CODE, withCode)).toBe(true);
    // the key itself is not a code, and a code is not the key
    expect(isOwnerEntry(KEY, withCode)).toBe(false);
    expect(visitorOf(bare({ host: "127.0.0.1:3000", ownerKey: CODE }), withCode)).toBeNull();
    expect(isOwnerEntry("nope", withCode)).toBe(false);
    expect(isOwnerEntry(null, withCode)).toBe(false);
    // no code configured, a short one, or no key to hand over: nothing is a code
    expect(isOwnerEntry(CODE, keyed)).toBe(false);
    expect(isOwnerEntry("short", { ...keyed, BURN402_OWNER_ENTRY: "short" })).toBe(false);
    expect(isOwnerEntry(CODE, { BURN402_OWNER_ENTRY: CODE })).toBe(false);
  });

  it("the real market opens to the public only with the switch AND an agent key of the visitors' own", () => {
    const theirs = "p".repeat(88);
    const base = { MAINNET_SOLANA_SECRET_KEY: "m".repeat(88), AGENT_SOLANA_SECRET_KEY: "a".repeat(88) };
    expect(publicReal({ ...base, BURN402_PUBLIC_REAL: "1", PUBLIC_MAINNET_SOLANA_SECRET_KEY: theirs })).toBe(true);
    // the switch alone does nothing: strangers' rentals would land on the owner's wallet
    expect(publicReal({ ...base, BURN402_PUBLIC_REAL: "1" })).toBe(false);
    expect(publicReal({ ...base, BURN402_PUBLIC_REAL: "1", PUBLIC_MAINNET_SOLANA_SECRET_KEY: "" })).toBe(false);
    // the visitors' key must not be one of the owner's
    expect(publicReal({ ...base, BURN402_PUBLIC_REAL: "1", PUBLIC_MAINNET_SOLANA_SECRET_KEY: base.MAINNET_SOLANA_SECRET_KEY })).toBe(false);
    expect(publicReal({ ...base, BURN402_PUBLIC_REAL: "1", PUBLIC_MAINNET_SOLANA_SECRET_KEY: base.AGENT_SOLANA_SECRET_KEY })).toBe(false);
    // the key alone does nothing either
    for (const flag of [undefined, "0", "true", ""]) expect(publicReal({ ...base, BURN402_PUBLIC_REAL: flag, PUBLIC_MAINNET_SOLANA_SECRET_KEY: theirs })).toBe(false);
  });
});
