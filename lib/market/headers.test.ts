import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

/** The security headers every response carries (next.config.ts). */
async function headers(): Promise<Record<string, string>> {
  const rules = await nextConfig.headers!();
  const all = rules.find((r) => r.source === "/:path*");
  return Object.fromEntries((all?.headers ?? []).map((h) => [h.key.toLowerCase(), h.value]));
}

describe("security headers", () => {
  it("lets a page load from and talk to this site only", async () => {
    const csp = Object.fromEntries(
      (await headers())["content-security-policy"].split("; ").map((d) => {
        const [name, ...values] = d.split(" ");
        return [name, values];
      }),
    );
    expect(csp["default-src"]).toEqual(["'self'"]);
    expect(csp["font-src"]).toEqual(["'self'"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
    expect(csp["base-uri"]).toEqual(["'self'"]);
    expect(csp["form-action"]).toEqual(["'self'"]);
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
    // wallet icons are embedded data: images; nothing else comes from outside
    expect(csp["img-src"]).toEqual(["'self'", "data:"]);
    // no directive names another site, and none allows everything
    for (const values of Object.values(csp)) {
      for (const v of values) expect(v).toMatch(/^('self'|'none'|'unsafe-inline'|'unsafe-eval'|data:|ws:)$/);
    }
    expect(csp["connect-src"]).toContain("'self'");
    expect(csp["script-src"]).toContain("'self'");
  });

  it("refuses framing and content sniffing, and keeps the referrer and its responses to itself", async () => {
    const h = await headers();
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("same-origin");
    expect(h["cross-origin-resource-policy"]).toBe("same-origin");
    expect(h["permissions-policy"]).toContain("camera=()");
  });
});
