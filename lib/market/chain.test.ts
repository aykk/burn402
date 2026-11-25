import { describe, expect, it } from "vitest";
import { findPayment, type FindPaymentOpts } from "./chain";

const RPC = "https://rpc.test";
const PAYER = "3YbtKYjoHy7Mo77AX7koyW3oCUbYSkoMQBKiVB7yUdT5";
const PAY_TO = "7avJggLBigx4S2M4mo1Gu5PmvuBWprm5zkHSsnQMFpEk";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PAYER_ATA = "4U6BBhhJZZicMH4VhQVJNkbRsJ6JV1J2XgsXdQsWv6Xr";
const SINCE = 1_795_588_800_000;

type Tx = { err?: unknown; blockTime?: number; payerDelta?: number; payToDelta?: number; payToOwner?: string; mint?: string; noPre?: boolean; signatures?: string[] };

/** One balance pair per account, in the jsonParsed shape devnet returns (checked against a real devnet transfer). */
function txResult(t: Tx) {
  const mint = t.mint ?? MINT;
  const bal = (accountIndex: number, owner: string, amount: number) => ({ accountIndex, mint, owner, programId: "Tokenkeg", uiTokenAmount: { amount: String(amount), decimals: 6 } });
  const pre = [bal(2, t.payToOwner ?? PAY_TO, 20_072_674), bal(3, PAYER, 19_927_326)];
  const post = [bal(2, t.payToOwner ?? PAY_TO, 20_072_674 + (t.payToDelta ?? 10_382)), bal(3, PAYER, 19_927_326 - (t.payerDelta ?? 10_382))];
  return { blockTime: t.blockTime ?? SINCE / 1000 + 19, transaction: { signatures: t.signatures ?? ["feePayerSig", "payerSig"], message: {} }, meta: { err: t.err ?? null, preTokenBalances: t.noPre ? [pre[1]] : pre, postTokenBalances: post } };
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

const q = (f: typeof fetch, more: Partial<FindPaymentOpts> = {}) => findPayment({ rpcUrl: RPC, payer: PAYER, mint: MINT, payTo: PAY_TO, atomic: "10382", sinceMs: SINCE, fetch: f, ...more });

describe("findPayment", () => {
  it("finds the transfer: payer down and recipient up by exactly the amount", async () => {
    const { f, calls } = scripted({ sigA: {} });
    expect(await q(f)).toEqual({ tx: "sigA" });
    expect(calls.map((c) => c.method)).toEqual(["getTokenAccountsByOwner", "getSignaturesForAddress", "getTransaction"]);
    expect(calls[0].params).toEqual([PAYER, { mint: MINT }, { encoding: "jsonParsed" }]);
    expect(calls[1].params).toEqual([PAYER_ATA, { limit: 20, commitment: "confirmed" }]);
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

  it("without a signature: is null for a transfer older than sinceMs minus 10 s, and does not fetch it", async () => {
    const old = SINCE / 1000 - 11;
    const { f, calls } = scripted({ s: { blockTime: old } });
    expect(await q(f)).toBeNull();
    expect(calls.some((c) => c.method === "getTransaction")).toBe(false);
    // inside the slack it is found
    expect(await q(scripted({ s: { blockTime: SINCE / 1000 - 9 } }).f)).toEqual({ tx: "s" });
  });

  it("without a signature: skips excluded transaction ids without fetching them", async () => {
    const { f, calls } = scripted({ oldRun: {}, mine: {} });
    expect(await q(f, { exclude: ["oldRun"] })).toEqual({ tx: "mine" });
    expect(calls.filter((c) => c.method === "getTransaction").map((c) => c.params[0])).toEqual(["mine"]);
    expect(await q(scripted({ oldRun: {} }).f, { exclude: ["oldRun"] })).toBeNull();
  });

  it("with a signature: matches only a transaction that carries it", async () => {
    // same amount, payer and recipient, but another run's transaction
    const { f } = scripted({ other: { signatures: ["fee1", "someoneElse"] }, mine: { signatures: ["fee2", "payerSig"] } });
    expect(await q(f, { signature: "payerSig" })).toEqual({ tx: "mine" });
    expect(await q(scripted({ other: { signatures: ["fee1", "someoneElse"] } }).f, { signature: "payerSig" })).toBeNull();
    // the signature alone is not enough: amount and recipient still have to match
    expect(await q(scripted({ wrong: { signatures: ["fee", "payerSig"], payerDelta: 1, payToDelta: 1 } }).f, { signature: "payerSig" })).toBeNull();
    // a transaction with no signatures array is not a match
    const noSigs = scripted({ s: {} });
    const bare = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = await noSigs.f(input, init);
      const body = await r.json();
      if (body.result && body.result.transaction) delete body.result.transaction;
      return new Response(JSON.stringify(body));
    }) as typeof fetch;
    expect(await q(bare, { signature: "payerSig" })).toBeNull();
  });

  it("examines at most 2 token accounts and makes at most 10 getTransaction calls", async () => {
    const accounts = { value: ["A1", "A2", "A3"].map((pubkey) => ({ pubkey, account: {} })) };
    const few = scripted({ n: { payerDelta: 1, payToDelta: 1 } }, { accounts });
    expect(await q(few.f)).toBeNull();
    expect(few.calls.filter((c) => c.method === "getSignaturesForAddress").map((c) => c.params[0])).toEqual(["A1", "A2"]);
    const txs: Record<string, Tx> = {};
    for (let i = 0; i < 15; i++) txs[`n${i}`] = { payerDelta: 1, payToDelta: 1 };
    txs.late = {}; // a match past the limit is not looked at
    const many = scripted(txs, { accounts });
    expect(await q(many.f)).toBeNull();
    expect(many.calls.filter((c) => c.method === "getTransaction")).toHaveLength(10);
  });

  it("has one deadline for the whole lookup: a hanging RPC gives \"unavailable\" within it, never throws", async () => {
    let signal: AbortSignal | undefined;
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const t0 = Date.now();
    expect(await q(hanging, { deadlineMs: 50 })).toBe("unavailable");
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(signal?.aborted).toBe(true);
    // a slow RPC that answers each call late still stops at the deadline
    const slow = scripted({ a: { payerDelta: 1, payToDelta: 1 }, b: { payerDelta: 1, payToDelta: 1 }, c: {} });
    const late = (async (input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise((r) => setTimeout(r, 30));
      return slow.f(input, init);
    }) as typeof fetch;
    expect(await q(late, { deadlineMs: 80 })).toBe("unavailable");
    expect(slow.calls.length).toBeLessThan(5);
  });

  it("is \"unavailable\" when it could not look (RPC errors, odd shapes, an answer over 2 MB), never throws", async () => {
    expect(await q(scripted({ s: {} }, { failMethod: "getTokenAccountsByOwner" }).f)).toBe("unavailable");
    expect(await q(scripted({ s: {} }, { failMethod: "getSignaturesForAddress" }).f)).toBe("unavailable");
    expect(await q(scripted({ s: "rpc-error" }).f)).toBe("unavailable");
    expect(await q(scripted({ s: {} }, { accounts: { value: "nope" } }).f)).toBe("unavailable");
    const throwing = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    expect(await q(throwing)).toBe("unavailable");
    const notJson = (async () => new Response("<html>")) as typeof fetch;
    expect(await q(notJson)).toBe("unavailable");
    const huge = (async () => new Response(`{"jsonrpc":"2.0","id":1,"result":{"value":[]},"pad":"${"x".repeat(2 * 1024 * 1024)}"}`)) as typeof fetch;
    expect(await q(huge)).toBe("unavailable");
  });

  it("is null when it looked and found nothing", async () => {
    expect(await q(scripted({ s: {} }, { sigs: [{ signature: "s", blockTime: null }] }).f)).toBeNull();
    expect(await q(scripted({ s: {} }, { accounts: { value: [] } }).f)).toBeNull();
  });

  it("is null for an amount that is not a whole number", async () => {
    const { f } = scripted({ s: {} });
    expect(await findPayment({ rpcUrl: RPC, payer: PAYER, mint: MINT, payTo: PAY_TO, atomic: "1.5", sinceMs: SINCE, fetch: f })).toBeNull();
  });
});
