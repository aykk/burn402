/**
 * Read-only look at the chain: did a USDC transfer from the payer to the seller land? Plain
 * JSON-RPC over fetch, no keys, no writes. Any error or unexpected shape is "not found" (null).
 */

const CALL_TIMEOUT_MS = 10_000;
const SIGNATURE_LIMIT = 20;
const SLACK_MS = 60_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export type FindPaymentOpts = { rpcUrl: string; payer: string; mint: string; payTo: string; atomic: string; sinceMs: number; fetch?: typeof fetch };

async function rpc(f: typeof fetch, url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await f(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${method} answered ${response.status}`);
  const body: unknown = await response.json();
  if (!isObj(body) || "error" in body || !("result" in body)) throw new Error(`${method} returned an error`);
  return body.result;
}

/** Token balance changes per account index for one mint, read from pre/post balances. */
function deltas(meta: Obj, mint: string): Map<number, { owner: string; delta: bigint }> {
  const out = new Map<number, { owner: string; pre: bigint; post: bigint }>();
  const read = (list: unknown, key: "pre" | "post") => {
    if (!Array.isArray(list)) throw new Error("balances missing");
    for (const b of list) {
      if (!isObj(b) || b.mint !== mint || typeof b.accountIndex !== "number" || typeof b.owner !== "string") continue;
      const amount = isObj(b.uiTokenAmount) ? b.uiTokenAmount.amount : undefined;
      if (typeof amount !== "string" || !/^\d+$/.test(amount)) continue;
      const row = out.get(b.accountIndex) ?? { owner: b.owner, pre: BigInt(0), post: BigInt(0) };
      row[key] = BigInt(amount);
      out.set(b.accountIndex, row);
    }
  };
  read(meta.preTokenBalances, "pre");
  read(meta.postTokenBalances, "post");
  return new Map([...out].map(([i, r]) => [i, { owner: r.owner, delta: r.post - r.pre }]));
}

/**
 * The first successful transaction since `sinceMs` (minus a minute of slack) in which the payer's
 * account for `mint` went down by exactly `atomic` and an account owned by `payTo` went up by
 * exactly `atomic`. Null when none is found or anything goes wrong; never throws.
 */
export async function findPayment(opts: FindPaymentOpts): Promise<{ tx: string } | null> {
  const f = opts.fetch ?? ((input, init) => fetch(input, init));
  try {
    if (!/^\d{1,30}$/.test(opts.atomic)) return null;
    const amount = BigInt(opts.atomic);
    const accounts = await rpc(f, opts.rpcUrl, "getTokenAccountsByOwner", [opts.payer, { mint: opts.mint }, { encoding: "jsonParsed" }]);
    if (!isObj(accounts) || !Array.isArray(accounts.value)) return null;
    const keys = accounts.value.map((a) => (isObj(a) && typeof a.pubkey === "string" ? a.pubkey : null)).filter((k): k is string => k !== null);
    const since = (opts.sinceMs - SLACK_MS) / 1000;
    const seen = new Set<string>();
    for (const key of keys) {
      const sigs = await rpc(f, opts.rpcUrl, "getSignaturesForAddress", [key, { limit: SIGNATURE_LIMIT }]);
      if (!Array.isArray(sigs)) continue;
      for (const s of sigs) {
        if (!isObj(s) || typeof s.signature !== "string" || typeof s.blockTime !== "number" || s.blockTime < since) continue;
        if (s.err !== null && s.err !== undefined) continue;
        if (seen.has(s.signature)) continue;
        seen.add(s.signature);
        let tx: unknown;
        try {
          tx = await rpc(f, opts.rpcUrl, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
        } catch {
          continue;
        }
        if (!isObj(tx) || !isObj(tx.meta) || tx.meta.err !== null) continue;
        if (typeof tx.blockTime === "number" && tx.blockTime < since) continue;
        let changes: ReturnType<typeof deltas>;
        try {
          changes = deltas(tx.meta, opts.mint);
        } catch {
          continue;
        }
        const rows = [...changes.values()];
        const paid = rows.some((r) => r.owner === opts.payer && r.delta === -amount);
        const received = rows.some((r) => r.owner === opts.payTo && r.delta === amount);
        if (paid && received) return { tx: s.signature };
      }
    }
    return null;
  } catch {
    return null;
  }
}
