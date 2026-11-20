"use client";

import type { Snapshot } from "@/lib/demo/snapshot";
import { AttemptLedger } from "./AttemptLedger";
import { money } from "./format";
import { BTN } from "./ui";

export function StressTest({ snap, post }: { snap: Snapshot | null; post: (path: string, body?: unknown) => Promise<void> }) {
  const stress = snap?.stress;
  const target = stress?.target;
  // Count the steps the ledger shows, so "It tries 4 ways" matches Step 1 to Step 4.
  const attempts = stress?.attempts.filter((a) => !a.quiet).length ?? 0;
  const tries = attempts > 0 ? `${attempts} ways` : "every way it can";
  const before = stress?.trustBefore?.behavior ?? null;
  const after = stress?.trustAfter?.behavior ?? null;
  return (
    <div className="space-y-3 border-t border-rule pt-6">
      <div>
        <h2 className="text-[16px] leading-[22px] font-semibold">Limit testing</h2>
        <p className="mt-1 max-w-[64ch] text-muted">
          {target
            ? `A second agent is handed a slice of the same budget: ${money(target.budgetUsd)} at up to ${money(target.rateUsdHr)} an hour. It tries ${tries} to spend more than that.`
            : "A second agent is handed a slice of the budget this job used, then tries to spend more than it was allowed."}
        </p>
      </div>
      {/* Secondary: Start run stays the only filled button in the view. */}
      <button className={BTN} disabled={stress?.status === "running" || snap?.busy} onClick={() => post("/api/demo/stress")}>
        {stress?.status === "running" ? "Trying…" : "Try to overspend"}
      </button>
      {stress?.error && <div className="text-bad">{stress.error}</div>}
      {stress && stress.attempts.length > 0 && (
        <div className="space-y-3">
          <AttemptLedger attempts={stress.attempts.filter((a) => !a.quiet)} />
          {after !== null && (
            <div className="flex flex-wrap items-center gap-x-4 pt-1">
              <span className="inline-block h-1.5 w-40 shrink-0 border border-rule-strong">
                <span
                  className="block h-full transition-all"
                  style={{
                    width: `${Math.max(3, after)}%`,
                    background: "var(--foreground)",
                  }}
                />
              </span>
              <span className="text-[12px] leading-4 text-muted">
                {stress.trustAfter?.profile}, {before !== null && before !== after ? `from ${before} to ${after}` : after}
              </span>
              {(stress.trustAfter?.riskFactors ?? []).length > 0 && (
                <span className="text-[12px] leading-4 text-muted">{stress.trustAfter!.riskFactors.join(", ")}</span>
              )}
            </div>
          )}
          {stress.verdictUrl && (
            <a href={stress.verdictUrl} target="_blank" rel="noreferrer">
              Verdict, stored on Arweave
            </a>
          )}
        </div>
      )}
    </div>
  );
}
