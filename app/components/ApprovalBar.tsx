"use client";

import { useRef, useState } from "react";
import type { MarketRunView } from "@/lib/market/run";
import { ActionError, type Post } from "./ActionError";
import { approvalSentence, billedHoursLine, shortAddress, surchargeLine } from "./market-copy";
import type { FocusNext } from "./MarketPanel";
import { BTN } from "./ui";
import { signWithWallet, useWallet, type WalletChain } from "./wallet";
import { WalletConnect } from "./WalletConnect";

const PAY_TEST =
  "inline-flex h-10 shrink-0 items-center rounded-[3px] border border-foreground bg-foreground px-5 text-[14px] leading-5 font-semibold text-surface enabled:hover:bg-[#2B3644] disabled:cursor-not-allowed disabled:border-segment disabled:bg-segment disabled:text-muted";

/** The one control that spends real money: amber, the site's money colour, with ink text (7.3:1). */
const PAY_REAL =
  "inline-flex h-10 shrink-0 items-center rounded-[3px] border border-amber bg-amber px-5 text-[14px] leading-5 font-semibold text-foreground enabled:hover:border-foreground disabled:cursor-not-allowed disabled:border-segment disabled:bg-segment disabled:text-muted";

/**
 * The approval stop: exactly what will be paid, to whom and for what, then Pay and rent or Cancel.
 * Pay sends the one-time code the run issued with the quote; without a wallet for this market it is off,
 * with the reason beside it.
 */
export function ApprovalBar({ run, walletReady, post, onFocusNext }: { run: MarketRunView; walletReady: boolean; post: Post; onFocusNext?: (next: FocusNext) => void }) {
  const [busy, setBusy] = useState<"wallet" | "pay" | "cancel" | null>(null);
  const wallet = useWallet();
  const [payError, setPayError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  // Blocks a second Pay or Cancel in the same tick, before the busy state has rendered.
  const inFlight = useRef(false);
  const a = run.approval;
  if (!a) return null;
  const real = run.market === "real";

  /**
   * A run paid from the visitor's own wallet: the server prepares an approval for exactly this amount, the
   * wallet shows it and signs, and the signed approval goes back with the one-time code. Declining in the
   * wallet leaves the run waiting here; nothing was sent.
   */
  const payFromWallet = async (address: string): Promise<string | null> => {
    setBusy("wallet");
    let prepared: { transaction?: string; chain?: WalletChain; error?: string };
    try {
      const res = await fetch("/api/market/wallet", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ run: run.id, code: a.code }) });
      prepared = (await res.json().catch(() => ({}))) as typeof prepared;
      if (!res.ok || !prepared.transaction || !prepared.chain) return prepared.error ?? `The server answered HTTP ${res.status}`;
    } catch {
      return "Can't reach the site right now. Nothing was sent.";
    }
    const signed = await signWithWallet(prepared.transaction, prepared.chain, address);
    if (!signed.ok) return signed.error;
    setBusy("pay");
    return post("/api/market/approve", { run: run.id, code: a.code, signedTransaction: signed.signed });
  };

  // The guard is released in `finally`, so a throw can never leave Pay and Cancel dead.
  const pay = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setPayError(null);
      setBusy("pay");
      // This bar goes away once the payment is sent: focus moves on to the machine block.
      onFocusNext?.("machine");
      const failed = run.wallet ? await payFromWallet(run.wallet) : await post("/api/market/approve", { run: run.id, code: a.code });
      if (failed) onFocusNext?.(null);
      setPayError(failed);
    } finally {
      setBusy(null);
      inFlight.current = false;
    }
  };
  const cancel = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setCancelError(null);
      setBusy("cancel");
      onFocusNext?.("heading");
      const failed = await post("/api/market/destroy", { run: run.id, cancel: true });
      if (failed) onFocusNext?.(null);
      setCancelError(failed);
    } finally {
      setBusy(null);
      inFlight.current = false;
    }
  };
  const surcharge = surchargeLine(a.surcharge);
  // "2 hours" in the sentence above, when 1 was asked for, is explained rather than left to surprise.
  const billed = billedHoursLine(run.need.hours, a.hours);

  // Paid from the visitor's own wallet: it must be connected, on the account the run was started with.
  const own = run.wallet;
  const ownReady = own === null || wallet.connected?.address === own;
  const reason = !walletReady
    ? real
      ? "Fund a mainnet wallet to pay on the real market."
      : "Set up the devnet wallet to pay on the test market."
    : !ownReady
      ? wallet.connected
        ? `Switch your wallet to ${shortAddress(own!)}, the account this rental was started with.`
        : `Connect the wallet ${shortAddress(own!)} to approve the payment.`
      : null;

  return (
    <section aria-labelledby="approval-heading" className="space-y-3 border-l-2 border-foreground pl-3">
      <div>
        <h3 id="approval-heading" className="text-[14px] leading-5 font-semibold text-foreground">
          Your approval
        </h3>
        <p className="mt-1 max-w-[60ch] text-[16px] leading-[22px] font-semibold text-foreground tabular-nums [overflow-wrap:anywhere]">{approvalSentence(a)}</p>
        {billed && <p className="mt-1 max-w-[64ch] text-foreground">{billed}</p>}
        {surcharge && <p className="mt-1 max-w-[64ch] text-foreground">{surcharge}</p>}
        {own && (
          <p className="mt-1 max-w-[64ch] text-foreground">
            Paid from your wallet {shortAddress(own)}. It will ask you to approve exactly {a.exact} USDC for your agent, which then pays the seller. Your wallet pays the
            approval&apos;s network fee, well under a cent of SOL.
          </p>
        )}
        <p className="mt-1 max-w-[64ch] text-[12px] leading-4 text-muted">
          A firm quote from the seller. Your agent checks the seller&apos;s payment request against this amount and your limits before it signs.
        </p>
      </div>
      <div className="space-y-2">
        {real && <p className="font-medium text-foreground">This spends real money and cannot be undone.</p>}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button className={real ? PAY_REAL : PAY_TEST} disabled={busy !== null || !walletReady || !ownReady} aria-describedby={reason ? "pay-reason" : undefined} onClick={() => void pay()}>
            {busy === "wallet" ? "Check your wallet…" : busy === "pay" ? "Paying…" : own ? "Approve in wallet and rent" : "Pay and rent"}
          </button>
          <button className={BTN} disabled={busy !== null} onClick={() => void cancel()}>
            {busy === "cancel" ? "Cancelling…" : "Cancel"}
          </button>
          {reason && (
            <span id="pay-reason" className="min-w-0 text-foreground">
              {reason}
            </span>
          )}
        </div>
        {own && !wallet.connected && <WalletConnect />}
        <ActionError what="The payment didn't go ahead" message={payError} onDismiss={() => setPayError(null)} />
        <ActionError what="The run wasn't cancelled" message={cancelError} onDismiss={() => setCancelError(null)} />
      </div>
    </section>
  );
}
