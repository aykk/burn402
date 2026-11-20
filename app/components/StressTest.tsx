"use client";

import type { Snapshot } from "@/lib/demo/snapshot";
import { AttemptLedger } from "./AttemptLedger";
import { money } from "./format";
import { BTN } from "./ui";

const sentence = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const period = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);

export function StressTest({ snap, post }: { snap: Snapshot | null; post: (path: string, body?: unknown) => Promise<void> }) {
  const stress = snap?.stress;
  const target = stress?.target;
  // Count the steps the ledger shows, so "It tries 4 ways" matches Step 1 to Step 4.
  const attempts = stress?.attempts.filter((a) => !a.quiet).length ?? 0;
  const tries = attempts > 0 ? `${attempts} ways` : "every way it can";
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
      {stress?.error && <div className="text-bad">{period(sentence(stress.error))}</div>}
      {stress && stress.attempts.length > 0 && (
        <div className="space-y-3">
          <AttemptLedger attempts={stress.attempts.filter((a) => !a.quiet)} />
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
