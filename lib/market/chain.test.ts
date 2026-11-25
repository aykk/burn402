import { describe, expect, it } from "vitest";
import { findPayment } from "./chain";

const RPC = "https://rpc.test";
const PAYER = "3YbtKYjoHy7Mo77AX7koyW3oCUbYSkoMQBKiVB7yUdT5";
const PAY_TO = "7avJggLBigx4S2M4mo1Gu5PmvuBWprm5zkHSsnQMFpEk";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PAYER_ATA = "4U6BBhhJZZicMH4VhQVJNkbRsJ6JV1J2XgsXdQsWv6Xr";
const SINCE = 1_795_588_800_000;

type Tx = { err?: unknown; blockTime?: number; payerDelta?: number; payToDelta?: number; payToOwner?: string; mint?: string; noPre?: boolean };

/** One balance pair per account, in the jsonParsed shape devnet returns (checked against a real devnet transfer). */
function txResult(t: Tx) {
  const mint = t.mint ?? MINT;
  const bal = (accountIndex: number, owner: string, amount: number) => ({ accountIndex, mint, owner, programId: "Tokenkeg", uiTokenAmount: { amount: String(amount), decimals: 6 } });
  const pre = [bal(2, t.payToOwner ?? PAY_TO, 20_072_674), bal(3, PAYER, 19_927_326)];
  const post = [bal(2, t.payToOwner ?? PAY_TO, 20_072_674 + (t.payToDelta ?? 10_382)), bal(3, PAYER, 19_927_326 - (t.payerDelta ?? 10_382))];
  return { blockTime: t.blockTime ?? SINCE / 1000 + 19, meta: { err: t.err ?? null, preTokenBalances: t.noPre ? [pre[1]] : pre, postTokenBalances: post } };
}

function scripted(txs: Record<string, Tx | "rpc-error">, o: { sigs?: { signature: string; blockTime: number | null; err?: unknown }[]; accounts?: unknown; failMethod?: string } = {}) {
  const calls: { method: string; params: unknown[] }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(RPC);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const { method, params, id } = JSON.parse(String(init?.body));
    calls.push({ method, params });
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
    if (method === o.failMethod) return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32005, message: "busy" } }));
    if (method === "getTokenAccountsByOwner") return ok(o.accounts ?? { context: { slot: 1 }, value: [{ pubkey: PAYER_ATA, account: {} }] });
    if (method === "getSignaturesForAddress") {
      return ok(o.sigs ?? Object.keys(txs).map((signature) => ({ signature, blockTime: (txs[signature] as Tx).blockTime ?? SINCE / 1000 + 19, err: null })));
    }
    if (method === "getTransaction") {
      const t = txs[params[0] as string];
      if (t === "rpc-error") return new Response("oops", { status: 500 });
      return ok(t ? txResult(t) : null);
    }
    throw new Error(`unexpected ${method}`);
  }) as typeof fetch;
  return { f, calls };
}

const q = (f: typeof fetch) => findPayment({ rpcUrl: RPC, payer: PAYER, mint: MINT, payTo: PAY_TO, atomic: "10382", sinceMs: SINCE, fetch: f });

describe("findPayment", () => {
  it("finds the transfer: payer down and recipient up by exactly the amount", async () => {
    const { f, calls } = scripted({ sigA: {} });
    expect(await q(f)).toEqual({ tx: "sigA" });
    expect(calls.map((c) => c.method)).toEqual(["getTokenAccountsByOwner", "getSignaturesForAddress", "getTransaction"]);
    expect(calls[0].params).toEqual([PAYER, { mint: MINT }, { encoding: "jsonParsed" }]);
    expect(calls[1].params).toEqual([PAYER_ATA, { limit: 20 }]);
    expect(calls[2].params).toEqual(["sigA", { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
  });

  it("accepts a recipient account created in the same transaction (no pre balance)", async () => {
    // a new account goes from nothing to exactly the amount
    expect(await q(scripted({ sigA: { noPre: true, payToDelta: 10_382 - 20_072_674 } }).f)).toEqual({ tx: "sigA" });
    // an existing balance with no pre entry is not a match
    expect(await q(scripted({ sigB: { noPre: true } }).f)).toBeNull();
  });

  it("skips the wrong amount and takes the next match", async () => {
    const { f } = scripted({ sigWrong: { payerDelta: 12_458, payToDelta: 12_458 }, sigRight: {} });
    expect(await q(f)).toEqual({ tx: "sigRight" });
  });

  it("is null for the wrong amount", async () => {
    expect(await q(scripted({ s: { payerDelta: 10_381, payToDelta: 10_381 } }).f)).toBeNull();
  });

  it("is null for the wrong recipient", async () => {
    expect(await q(scripted({ s: { payToOwner: "Someone111111111111111111111111111111111111" } }).f)).toBeNull();
  });

  it("is null for the wrong mint", async () => {
    expect(await q(scripted({ s: { mint: "So11111111111111111111111111111111111111112" } }).f)).toBeNull();
  });

  it("is null for a failed transaction", async () => {
    expect(await q(scripted({ s: { err: { InstructionError: [0, "Custom"] } } }).f)).toBeNull();
  });

  it("is null for a transfer older than sinceMs minus 60 s, and does not fetch it", async () => {
    const old = SINCE / 1000 - 61;
    const { f, calls } = scripted({ s: { blockTime: old } });
    expect(await q(f)).toBeNull();
    expect(calls.some((c) => c.method === "getTransaction")).toBe(false);
    // inside the slack it is found
    expect(await q(scripted({ s: { blockTime: SINCE / 1000 - 59 } }).f)).toEqual({ tx: "s" });
  });

  it("is null on RPC errors and odd shapes, never throws", async () => {
    expect(await q(scripted({ s: {} }, { failMethod: "getTokenAccountsByOwner" }).f)).toBeNull();
    expect(await q(scripted({ s: {} }, { failMethod: "getSignaturesForAddress" }).f)).toBeNull();
    expect(await q(scripted({ s: "rpc-error" }).f)).toBeNull();
    expect(await q(scripted({ s: {} }, { accounts: { value: "nope" } }).f)).toBeNull();
    expect(await q(scripted({ s: {} }, { sigs: [{ signature: "s", blockTime: null }] }).f)).toBeNull();
    const throwing = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    expect(await q(throwing)).toBeNull();
    const notJson = (async () => new Response("<html>")) as typeof fetch;
    expect(await q(notJson)).toBeNull();
  });

  it("is null for an amount that is not a whole number", async () => {
    const { f } = scripted({ s: {} });
    expect(await findPayment({ rpcUrl: RPC, payer: PAYER, mint: MINT, payTo: PAY_TO, atomic: "1.5", sinceMs: SINCE, fetch: f })).toBeNull();
  });
});
