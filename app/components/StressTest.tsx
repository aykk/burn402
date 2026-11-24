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
  // Only the second agent's attempts count (blocked is set); the auditor and trust-index steps respond to them.
  const attempts = stress?.attempts.filter((a) => a.blocked !== null).length ?? 0;
  const tries = stress?.status === "done" && attempts > 0 ? `${attempts} ways` : "every way it can";
  return (
    <div className="space-y-3 border-t border-rule pt-6">
      <div>
        <h2 className="text-[16px] leading-[22px] font-semibold">Limit testing</h2>
        <p className="mt-1 max-w-[64ch] text-muted">
          {target
            ? `A second agent is handed a slice of the same budget: ${money(target.budgetUsd)} at up to ${money(target.rateUsdHr)} an hour. It tries ${tries} to spend more than that.${stress?.status === "done" ? " Then the auditor checks the public record." : ""}`
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
          <AttemptLedger attempts={stress.attempts} />
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
