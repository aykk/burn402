import { describe, expect, it } from "vitest";
import { APP_PORT, localHosts, localOrigins, localVerdict, proxyVerdict } from "./local";

describe("local-only rule (I2)", () => {
  it("derives the allowed hosts and origins from one port, plus PORT when set", () => {
    expect(APP_PORT).toBe(3000);
    expect([...localHosts({})]).toEqual(["127.0.0.1:3000", "localhost:3000"]);
    expect([...localOrigins({})]).toEqual(["http://127.0.0.1:3000", "http://localhost:3000"]);
    expect([...localHosts({ PORT: "3001" })]).toEqual(["127.0.0.1:3000", "localhost:3000", "127.0.0.1:3001", "localhost:3001"]);
    expect([...localHosts({ PORT: "abc" })]).toEqual(["127.0.0.1:3000", "localhost:3000"]);
  });

  it("accepts the local host with no Origin or a local Origin", () => {
    expect(localVerdict({ host: "127.0.0.1:3000", origin: null }, { origin: true }, {})).toBeNull();
    expect(localVerdict({ host: "localhost:3000", origin: "http://localhost:3000" }, { origin: true }, {})).toBeNull();
    expect(localVerdict({ host: "localhost:3000", origin: "http://127.0.0.1:3000" }, { origin: true }, {})).toBeNull();
    expect(localVerdict({ host: "localhost:3001", origin: "http://localhost:3001" }, { origin: true }, { PORT: "3001" })).toBeNull();
  });

  it("refuses another host, a missing host and another origin", () => {
    expect(localVerdict({ host: "evil.example:3000", origin: null }, { origin: true }, {})).toMatch(/only answers on 127\.0\.0\.1:3000 or localhost:3000/);
    expect(localVerdict({ host: null, origin: null }, { origin: true }, {})).not.toBeNull();
    expect(localVerdict({ host: "127.0.0.1:3001", origin: null }, { origin: true }, {})).not.toBeNull();
    expect(localVerdict({ host: "127.0.0.1:3000", origin: "https://evil.example" }, { origin: true }, {})).toBe("requests from other websites are not allowed");
    expect(localVerdict({ host: "127.0.0.1:3000", origin: "null" }, { origin: true }, {})).not.toBeNull();
    expect(localVerdict({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000/" }, { origin: true }, {})).not.toBeNull();
    // the host-only check ignores Origin
    expect(localVerdict({ host: "127.0.0.1:3000", origin: "https://evil.example" }, { origin: false }, {})).toBeNull();
  });

  it("proxy: every non-GET/HEAD/OPTIONS request under /api gets the full rule", () => {
    const evil = { host: "127.0.0.1:3000", origin: "https://evil.example" };
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
      expect(proxyVerdict(method, "/api/demo/reset", evil, {})).not.toBeNull();
      expect(proxyVerdict(method, "/api/demo/dataset", { host: "evil.example:3000", origin: null }, {})).not.toBeNull();
      expect(proxyVerdict(method, "/api/demo/network", { host: "127.0.0.1:3000", origin: null }, {})).toBeNull();
    }
  });

  it("proxy: GET under /api/testseller and /api/market gets the host check only; other reads pass", () => {
    const rebinding = { host: "evil.example:3000", origin: null };
    for (const method of ["GET", "HEAD"]) {
      expect(proxyVerdict(method, "/api/testseller/compute/plans", rebinding, {})).not.toBeNull();
      expect(proxyVerdict(method, "/api/market/run", rebinding, {})).not.toBeNull();
      expect(proxyVerdict(method, "/api/market/run", { host: "localhost:3000", origin: "https://evil.example" }, {})).toBeNull();
      expect(proxyVerdict(method, "/api/demo/state", rebinding, {})).toBeNull();
      expect(proxyVerdict(method, "/api/marketing", rebinding, {})).toBeNull();
    }
    expect(proxyVerdict("OPTIONS", "/api/demo/reset", { host: "evil.example:3000", origin: "https://evil.example" }, {})).toBeNull();
  });
});
