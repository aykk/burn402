import { describe, expect, it } from "vitest";
import { accessVerdict, headersOf, newSessionId, publicHosts, sessionCookieValue, sessionIdFrom, visitorOf, type AccessHeaders } from "./access";

const env = { BURN402_PUBLIC_HOSTS: "demo.example.com, Another.Example.org ,bad host,http://x.com", BURN402_SESSION_SECRET: "k".repeat(40) };
const h = (over: Partial<AccessHeaders>): AccessHeaders => ({ host: null, origin: null, cookie: null, cfIp: null, cfRay: null, forwardedFor: null, proxied: false, fetchSite: null, ...over });
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
