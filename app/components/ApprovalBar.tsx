"use client";

import { useState } from "react";
import type { MarketRunView } from "@/lib/market/run";
import { ActionError, type Post } from "./ActionError";
import { approvalSentence } from "./market-copy";
import { BTN } from "./ui";

const PAY_TEST =
  "inline-flex h-10 shrink-0 items-center rounded-[3px] border border-foreground bg-foreground px-5 text-[13.5px] leading-5 font-semibold text-surface enabled:hover:bg-[#2B3644] disabled:cursor-not-allowed disabled:border-segment disabled:bg-segment disabled:text-muted";

/** The one control that spends real money: amber, the site's money colour, with ink text (7.3:1). */
const PAY_REAL =
  "inline-flex h-10 shrink-0 items-center rounded-[3px] border border-amber bg-amber px-5 text-[13.5px] leading-5 font-semibold text-foreground enabled:hover:border-foreground disabled:cursor-not-allowed disabled:border-segment disabled:bg-segment disabled:text-muted";

/**
 * The approval stop: exactly what will be paid, to whom and for what, then Pay and rent or Cancel.
 * Pay sends the one-time code the run issued with the quote; without a wallet for this market it is off,
 * with the reason beside it.
 */
export function ApprovalBar({ run, walletReady, post }: { run: MarketRunView; walletReady: boolean; post: Post }) {
  const [busy, setBusy] = useState<"pay" | "cancel" | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const a = run.approval;
  if (!a) return null;
  const real = run.market === "real";

  const pay = async () => {
    setPayError(null);
    setBusy("pay");
    setPayError(await post("/api/market/approve", { run: run.id, code: a.code }));
    setBusy(null);
  };
  const cancel = async () => {
    setCancelError(null);
    setBusy("cancel");
    setCancelError(await post("/api/market/destroy", { run: run.id, cancel: true }));
    setBusy(null);
  };

  const reason = walletReady ? null : real ? "Fund a mainnet wallet to pay on the real market." : "Set up the devnet wallet to pay on the test market.";

  return (
    <section aria-labelledby="approval-heading" className="space-y-3 border-l-2 border-foreground pl-3">
      <div>
        <h3 id="approval-heading" className="text-[13.5px] leading-5 font-semibold text-foreground">
          Your approval
        </h3>
        <p className="mt-1 max-w-[60ch] text-[16px] leading-[22px] font-semibold text-foreground tabular-nums [overflow-wrap:anywhere]">{approvalSentence(a)}</p>
        <p className="mt-1 max-w-[64ch] text-[12px] leading-4 text-muted">
          A firm quote from {run.marketLabel}. Your agent checks the seller&apos;s payment request against this amount and your limits before it signs.
        </p>
      </div>
      <div className="space-y-2">
        {real && <p className="font-medium text-foreground">This spends real money and cannot be undone.</p>}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button className={real ? PAY_REAL : PAY_TEST} disabled={busy !== null || !walletReady} aria-describedby={reason ? "pay-reason" : undefined} onClick={() => void pay()}>
            {busy === "pay" ? "Paying…" : "Pay and rent"}
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
        <ActionError what="The payment didn't go ahead" message={payError} onDismiss={() => setPayError(null)} />
        <ActionError what="The run wasn't cancelled" message={cancelError} onDismiss={() => setCancelError(null)} />
      </div>
    </section>
  );
}
