import { describe, expect, it } from "vitest";
import { accessVerdict, newSessionId, publicHosts, sessionIdFrom, visitorOf, type AccessHeaders } from "./access";

const env = { BURN402_PUBLIC_HOSTS: "demo.example.com, Another.Example.org ,bad host,http://x.com" };
const h = (over: Partial<AccessHeaders>): AccessHeaders => ({ host: null, origin: null, cookie: null, cfIp: null, cfRay: null, forwardedFor: null, ...over });
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
  it("a listed public host is a public visitor, with its address and session", () => {
    expect(visitorOf(h({ host: "Demo.Example.com", cfIp: "203.0.113.9", cookie: `a=1; __Host-b402_sid=${SID}` }), env)).toEqual({ kind: "public", host: "demo.example.com", ip: "203.0.113.9", sid: SID });
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
  it("are read from the cookie only when well formed", () => {
    expect(sessionIdFrom(`__Host-b402_sid=${SID}`)).toBe(SID);
    expect(sessionIdFrom("__Host-b402_sid=../../etc/passwd")).toBeNull();
    expect(sessionIdFrom("other=1")).toBeNull();
    expect(sessionIdFrom(null)).toBeNull();
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
