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
  it("refuses a requirement that makes the paying wallet pay the network fee", () => {
    const r = checkPayment({ ...base, accepts: { ...real, extra: { feePayer: "Payer11111111111111111111111111111111111111" } }, payer: "Payer11111111111111111111111111111111111111" });
    expect(r).toEqual({ ok: false, code: "WRONG_NETWORK", detail: "The seller asked your wallet to pay the network fee." });
  });
  it("accepts a fee payer that is not the paying wallet, and requirements with no fee payer", () => {
    expect(checkPayment({ ...base, accepts: { ...real, extra: { feePayer: "Fee11111111111111111111111111111111111111" } }, payer: "Payer11111111111111111111111111111111111111" }).ok).toBe(true);
    expect(checkPayment({ ...base, payer: "Payer11111111111111111111111111111111111111" }).ok).toBe(true);
    expect(checkPayment({ ...base, accepts: { ...real, extra: {} }, payer: "Payer11111111111111111111111111111111111111" }).ok).toBe(true);
  });
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
  it("fails closed when alreadyPaid is not a boolean", () => {
    for (const v of [undefined, null, 0, "false", ""]) expect(code({ alreadyPaid: v })).toBe("MALFORMED");
  });
  it("clips seller text in details to 64 characters", () => {
    const long = "x".repeat(500);
    for (const over of [{ network: long }, { scheme: long }, { asset: long }]) {
      const r = checkPayment({ ...base, accepts: { ...real, ...over } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.detail).not.toContain("x".repeat(65));
    }
    const r = checkPayment({ ...base, payTo: "a", accepts: { ...real, payTo: long } });
    if (!r.ok) expect(r.detail).not.toContain("x".repeat(65));
    expect(r.ok).toBe(false);
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

describe("checkPayment details are plain", () => {
  const detail = (over: Record<string, unknown>) => {
    const r = checkPayment({ ...base, ...over } as never);
    return r.ok ? "ok" : r.detail;
  };
  const detailAcc = (over: Record<string, unknown>) => detail({ accepts: { ...real, ...over } });

  it("names the token the seller asked for", () => {
    expect(detailAcc({ asset: "So11111111111111111111111111111111111111112" })).toBe("The seller asked to be paid in SOL instead of USDC on Solana mainnet.");
    expect(detailAcc({ asset: "Abcd1111111111111111111111111111111111Wxyz" })).toBe("The seller asked to be paid in another token (Abcd…Wxyz) instead of USDC on Solana mainnet.");
    expect(detailAcc({ asset: NETWORKS.test.usdc })).toBe("The seller asked to be paid in USDC from Solana devnet instead of USDC on Solana mainnet.");
  });

  it("names the network the seller asked for", () => {
    expect(detailAcc({ network: SOLANA_DEVNET })).toBe("The seller asked to be paid on Solana devnet instead of Solana mainnet.");
    expect(detailAcc({ scheme: "upto" })).toBe('The seller asked for a kind of payment this agent does not make ("upto"); it pays only exact amounts.');
  });

  it("says the new price and the approved one in exact dollars", () => {
    expect(detail({ accepts: { ...real, amount: "12458" }, approvedAtomic: BigInt(10382) })).toBe("The seller now asks $0.012458, more than the $0.010382 you approved.");
  });

  it("says budget and hourly limit in dollars", () => {
    expect(detail({ budgetLeftUsd: 0.005 })).toBe("$0.0100 is more than the $0.005 left in your budget.");
    expect(detail({ rateUsdHr: 0.009 })).toBe("$0.01 an hour is more than your hourly limit of $0.009.");
  });

  it("uses no codes or atomic units in any detail", () => {
    const cases = [
      detailAcc({ asset: "So11111111111111111111111111111111111111112" }),
      detail({ accepts: { ...real, amount: "12458" }, approvedAtomic: BigInt(10382) }),
      detail({ budgetLeftUsd: 0.005 }),
      detail({ rateUsdHr: 0.009 }),
      detail({ alreadyPaid: true }),
      detailAcc({ payTo: "" }),
    ];
    for (const d of cases) {
      expect(d).not.toMatch(/[A-Z]{3,}_[A-Z]+|atomic|So1111/);
    }
  });
});

describe("NETWORKS rpcUrl", () => {
  it("has a public RPC per market", () => {
    expect(NETWORKS.test.rpcUrl).toBe("https://api.devnet.solana.com");
    expect(NETWORKS.real.rpcUrl).toBe("https://api.mainnet-beta.solana.com");
  });
});
