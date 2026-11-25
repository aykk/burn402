import { describe, expect, it } from "vitest";
import { networkName, sellerReason, tokenName, usdExact, usdPlain } from "./money";

describe("usdExact", () => {
  it.each([
    ["10382", "$0.010382"],
    ["10000", "$0.0100"],
    ["12458", "$0.012458"],
    ["10380", "$0.01038"],
    ["0", "$0.0000"],
    ["1", "$0.000001"],
    ["1000000", "$1.0000"],
    ["123456789", "$123.456789"],
    ["001", "$0.000001"],
  ])("%s atomic is %s", (atomic, want) => expect(usdExact(atomic)).toBe(want));

  it("never shows a malformed amount as money", () => {
    for (const bad of ["", "-1", "1.5", "abc", "1e6"]) expect(usdExact(bad)).toBe("an unreadable amount");
  });
});

describe("usdPlain", () => {
  it.each([
    [1, "$1.00"],
    [0.05, "$0.05"],
    [0.010382, "$0.010382"],
    [0.0090270000001, "$0.009027"],
    [1234.5, "$1,234.50"],
    [20, "$20.00"],
  ])("%s is %s", (n, want) => expect(usdPlain(n)).toBe(want));
});

describe("tokenName", () => {
  it("names the tokens plainly", () => {
    expect(tokenName("So11111111111111111111111111111111111111112")).toBe("SOL");
    expect(tokenName("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")).toBe("USDC");
    expect(tokenName("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe("USDC");
    expect(tokenName("Abcd1111111111111111111111111111111111Wxyz")).toBe("another token (Abcd…Wxyz)");
  });
});

describe("networkName", () => {
  it("names the networks plainly", () => {
    expect(networkName("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1")).toBe("Solana devnet");
    expect(networkName("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toBe("Solana mainnet");
    expect(networkName("eip155:8453")).toBe("another network (eip155:8453)");
  });
});

describe("sellerReason", () => {
  it("takes a short message field, never the raw body", () => {
    expect(sellerReason('{"error":"payment rejected, pay again","quote_usd":0.010382}')).toBe("payment rejected, pay again");
    expect(sellerReason('{"message":"plan is out of stock in ewr"}')).toBe("plan is out of stock in ewr");
    expect(sellerReason('{"detail":"x"}')).toBe("x");
    expect(sellerReason(JSON.stringify({ error: "y".repeat(300) }))).toBe(`${"y".repeat(120)}…`);
  });

  it("says the seller gave no reason for anything else", () => {
    for (const t of ["", "<html>502 Bad Gateway</html>", '{"quote_usd":1}', "[1,2]", '{"error":{"nested":true}}']) {
      expect(sellerReason(t)).toBe("the seller gave no reason");
    }
  });
});

describe("known values agree with NETWORKS", () => {
  it("names each market's USDC mint and network", async () => {
    const { NETWORKS } = await import("./guard");
    for (const n of Object.values(NETWORKS)) {
      expect(tokenName(n.usdc)).toBe("USDC");
      expect(networkName(n.caip2)).toBe(n.label);
    }
  });
});
