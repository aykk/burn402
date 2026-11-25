import { describe, expect, it } from "vitest";
import { SOLANA_DEVNET } from "../x402";
import { atomicToUsd, checkPayment, NETWORKS, usdToAtomic, type Accepts } from "./guard";

const real: Accepts = {
  scheme: "exact",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amount: "10000",
  payTo: "ELT2NA1N9u7TgumXjCZXgo87X7HKkwiffSrCnDFgd5Ux",
};
const base = { accepts: real, market: "real" as const, approvedAtomic: BigInt(10000), budgetLeftUsd: 1, rateUsdHr: 0.05, hours: 1, alreadyPaid: false };
const code = (over: Record<string, unknown>) => {
  const r = checkPayment({ ...base, ...over } as never);
  return r.ok ? "ok" : r.code;
};
const acc = (over: Record<string, unknown>) => code({ accepts: { ...real, ...over } });

describe("checkPayment", () => {
  it("accepts the real quote", () => {
    expect(checkPayment(base)).toEqual({ ok: true, usd: 0.01 });
  });
  it("matches the devnet constant", () => {
    expect(NETWORKS.test.caip2).toBe(SOLANA_DEVNET);
  });
  it("refuses a second payment", () => expect(code({ alreadyPaid: true })).toBe("ALREADY_PAID"));
  it("refuses another scheme", () => expect(acc({ scheme: "upto" })).toBe("WRONG_NETWORK"));
  it("refuses devnet on the real market", () => expect(acc({ network: SOLANA_DEVNET })).toBe("WRONG_NETWORK"));
  it("refuses another mint", () => expect(acc({ asset: NETWORKS.test.usdc })).toBe("WRONG_ASSET"));
  it("refuses a higher amount", () => expect(acc({ amount: "10001" })).toBe("OVER_QUOTE"));
  it("refuses over budget", () => expect(code({ budgetLeftUsd: 0.005 })).toBe("OVER_BUDGET"));
  it("refuses over rate", () => expect(code({ rateUsdHr: 0.009 })).toBe("OVER_RATE"));
  it("refuses a changed recipient", () => {
    const r = checkPayment({ ...base, payTo: "SomeoneElse1111111111111111111111111111111" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("OVER_QUOTE");
      expect(r.detail).toMatch(/recipient/);
    }
  });
  it("accepts an unchanged recipient", () => expect(code({ payTo: real.payTo })).toBe("ok"));
  it.each(["-5", "1e9", "abc", "", "1.5", " 10", "9".repeat(400)])("malformed amount %j", (amount) => {
    expect(acc({ amount })).toBe("MALFORMED");
  });
  it("malformed on missing or wrong-typed fields", () => {
    for (const k of Object.keys(real)) {
      const a: Record<string, unknown> = { ...real, [k]: undefined };
      expect(code({ accepts: a })).toBe("MALFORMED");
      expect(acc({ [k]: 5 })).toBe("MALFORMED");
    }
    expect(code({ accepts: {} })).toBe("MALFORMED");
    expect(code({ accepts: null })).toBe("MALFORMED");
    expect(code({ accepts: undefined })).toBe("MALFORMED");
    expect(code({ accepts: "x" })).toBe("MALFORMED");
  });
  it("malformed on bad hours and limits", () => {
    expect(code({ hours: 0 })).toBe("MALFORMED");
    expect(code({ hours: -1 })).toBe("MALFORMED");
    expect(code({ hours: NaN })).toBe("MALFORMED");
    expect(code({ budgetLeftUsd: NaN })).toBe("MALFORMED");
    expect(code({ rateUsdHr: "1" })).toBe("MALFORMED");
  });
  it("never throws on junk input", () => {
    expect(code({ approvedAtomic: 10000 })).toBe("MALFORMED");
    expect(code({ market: "nope" })).toBe("MALFORMED");
    expect(checkPayment(undefined as never).ok).toBe(false);
  });
  it("checks in the documented order", () => {
    expect(code({ alreadyPaid: true, accepts: { ...real, amount: "x" } })).toBe("MALFORMED");
    expect(acc({ scheme: "upto", asset: "z", amount: "99999" })).toBe("WRONG_NETWORK");
    expect(acc({ asset: "z", amount: "99999" })).toBe("WRONG_ASSET");
    expect(code({ accepts: { ...real, amount: "20000" }, budgetLeftUsd: 0, rateUsdHr: 0 })).toBe("OVER_QUOTE");
    expect(code({ budgetLeftUsd: 0, rateUsdHr: 0 })).toBe("OVER_BUDGET");
  });
  it("uses the devnet network on the test market", () => {
    const t = { ...real, network: NETWORKS.test.caip2, asset: NETWORKS.test.usdc };
    expect(checkPayment({ ...base, accepts: t, market: "test" })).toEqual({ ok: true, usd: 0.01 });
  });
});

describe("conversions", () => {
  it("atomicToUsd", () => expect(atomicToUsd("10000")).toBe(0.01));
  it("usdToAtomic rounds up", () => {
    expect(usdToAtomic(0.0100001)).toBe(BigInt(10001));
    expect(usdToAtomic(0.01)).toBe(BigInt(10000));
    expect(usdToAtomic(0)).toBe(BigInt(0));
  });
  it("usdToAtomic rejects junk", () => expect(() => usdToAtomic(NaN)).toThrow());
});
