"use client";

import { useState } from "react";
import { Nav } from "@/app/nav";
import { ActionError, failureMessage } from "@/app/components/ActionError";
import { AttemptLedger } from "@/app/components/AttemptLedger";
import { usd2 } from "@/app/components/format";
import { usdPlain } from "@/lib/market/money";
import { BTN_PRIMARY } from "@/app/components/ui";
import type { OverspendAttempt, OverspendResult } from "@/lib/market/overspend";
import type { Snapshot } from "@/lib/demo/snapshot";

/** Mirrors OVERSPEND_LIMITS in lib/market/overspend.ts (a server module, so it is not imported here). */
const LIMITS = { budgetUsd: 0.05, rateUsdHr: 0.05 };
type LedgerRow = Snapshot["stress"]["attempts"][number];

/** The ledger reads "refused: …" as Blocked and "not stopped: …" as Got through. */
const toRow = (a: OverspendAttempt): LedgerRow => ({
  what: a.what,
  result: `${a.blocked ? "refused" : "not stopped"}: ${a.paidUsd === null ? `${a.result.replace(/([^.!?])$/, "$1.")} Paid during this attempt: unknown.` : a.result}`,
  ok: a.blocked,
  blocked: a.blocked,
  mark: null,
  quiet: false,
  proves: a.proves,
});

export default function OverspendPage() {
  const [result, setResult] = useState<OverspendResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    setRunning(true);
    try {
      const res = await fetch("/api/market/overspend", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const body = (await res.json()) as OverspendResult & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `The server answered HTTP ${res.status}`);
      setResult(body);
    } catch (e) {
      setError(failureMessage(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <main className="mx-auto flex w-full max-w-[1280px] flex-col px-4 py-5 sm:px-6 lg:px-10 lg:py-6">
      <Nav current="/audit" />

      <div className="pt-2">
        <h1 className="text-[20px] leading-[26px] font-semibold">Overspend test</h1>
        <p className="mt-3 max-w-[64ch] text-muted">
          The agent is given a limit of {usd2(LIMITS.rateUsdHr)} an hour and {usd2(LIMITS.budgetUsd)} in total, then five ways to spend more are tried against the test seller: a plan over the
          hourly limit, a rental over the budget, a seller that raises its price after quoting, a seller that asks for the wrong token, and a seller that takes the payment, then claims it was rejected, to get paid again.
          It runs on Solana devnet with simulated machines. In the last attempt the dishonest seller really keeps one payment of about one cent of test USDC.
        </p>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
        <button type="button" className={BTN_PRIMARY} disabled={running} onClick={run}>
          {running ? "Running…" : "Run the test"}
        </button>
        <ActionError what="The overspend test didn't run" message={error} onDismiss={() => setError(null)} />
      </div>

      {result && (
        <section className="mt-6 max-w-[80ch] space-y-4 border-t border-rule pt-6">
          {/* The test's own sentences carry exact amounts ("$0.010382"); the ledger shows them as they are. */}
          <AttemptLedger attempts={result.attempts.map(toRow)} status="done" verdict={result.verdict} exact />
          <p className="flex items-center gap-x-2 text-muted">
            <span aria-hidden className="inline-block size-2.5 shrink-0 bg-amber" />
            <span>
              Paid during the test: <span className="font-semibold text-foreground tabular-nums">{result.spentUsd === null ? "unknown" : `${usdPlain(result.spentUsd)} USDC`}</span> on Solana devnet.
            </span>
          </p>
        </section>
      )}
    </main>
  );
}
