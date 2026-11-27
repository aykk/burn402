"use client";

import { useRef, useState } from "react";
import type { MarketRunView } from "@/lib/market/run";
import { shortAddress } from "./market-copy";
import { BTN } from "./ui";
import { signWithWallet, type WalletChain } from "./wallet";

type State = { kind: "idle" } | { kind: "busy"; what: string } | { kind: "none" } | { kind: "done" } | { kind: "error"; text: string };

/**
 * After a wallet-funded run that ended without paying: the wallet may have approved an amount the agent
 * never used. This reads the chain and, when something is left, asks the wallet to take it back.
 */
export function RevokeApproval({ run }: { run: MarketRunView }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const inFlight = useRef(false);
  const wallet = run.wallet;
  if (!wallet) return null;

  const ask = async (body: Record<string, unknown>) => {
    const res = await fetch("/api/market/wallet", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ run: run.id, revoke: true, ...body }) });
    const json = (await res.json().catch(() => ({}))) as { none?: boolean; transaction?: string; chain?: WalletChain; exact?: string; error?: string };
    return res.ok ? json : { error: json.error ?? `The server answered HTTP ${res.status}` };
  };

  const revoke = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setState({ kind: "busy", what: "Checking…" });
      const left = await ask({});
      if (left.error) return setState({ kind: "error", text: left.error });
      if (left.none || !left.transaction || !left.chain) return setState({ kind: "none" });
      setState({ kind: "busy", what: "Check your wallet…" });
      const signed = await signWithWallet(left.transaction, left.chain, wallet);
      if (!signed.ok) return setState({ kind: "error", text: signed.error });
      setState({ kind: "busy", what: "Revoking…" });
      const sent = await ask({ signedTransaction: signed.signed });
      setState(sent.error ? { kind: "error", text: sent.error } : { kind: "done" });
    } catch {
      setState({ kind: "error", text: "Can't reach the site right now. Nothing was sent." });
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <section aria-labelledby="revoke-heading" className="space-y-2">
      <h3 id="revoke-heading" className="text-[14px] leading-5 font-semibold text-foreground">
        An approval may be left in your wallet
      </h3>
      <p className="max-w-[64ch] text-foreground">
        This rental ended without a confirmed payment, after your wallet {shortAddress(wallet)} approved an amount for your agent. If that approval was not used, it is still
        there. It covers that one amount only, and you can take it back.
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button type="button" className={BTN} disabled={state.kind === "busy" || state.kind === "done" || state.kind === "none"} onClick={() => void revoke()}>
          {state.kind === "busy" ? state.what : "Check and revoke"}
        </button>
        <span role="status" className={state.kind === "error" ? "min-w-0 text-bad" : "min-w-0 text-foreground"}>
          {state.kind === "none" && "Nothing is left approved for your agent."}
          {state.kind === "done" && "Revoked. Your agent can no longer move anything from your wallet."}
          {state.kind === "error" && state.text}
        </span>
      </div>
    </section>
  );
}
