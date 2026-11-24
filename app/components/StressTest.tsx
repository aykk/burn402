"use client";

import { useState } from "react";
import type { Snapshot } from "@/lib/demo/snapshot";
import { ActionError, type Post } from "./ActionError";
import { AttemptLedger, testCopy } from "./AttemptLedger";
import { usd2 } from "./format";
import { BTN } from "./ui";

/** The overspend test on the Run page. The feature is "Overspend test" everywhere; the action is "Try to overspend". */
export function StressTest({ snap, post }: { snap: Snapshot | null; post: Post }) {
  // A refused start (the server says no before any attempt runs); failures during the test arrive as stress.error.
  const [startError, setStartError] = useState<string | null>(null);
  const stress = snap?.stress;
  const target = stress?.target;
  // The attempt count lives in the ledger's verdict sentence, so the intro only sets up the test.
  return (
    <div className="space-y-3 border-t border-rule pt-6">
      <div>
        <h2 className="text-[16px] leading-[22px] font-semibold">Overspend test</h2>
        <p className="mt-1 max-w-[64ch] text-muted">
          {target
            ? `A second agent gets a slice of the same budget, ${usd2(target.budgetUsd)} at up to ${usd2(target.rateUsdHr)} an hour, and tries every way it can to spend more than that. Then the auditor checks the public record.`
            : "A second agent gets a slice of the budget this job used and tries every way it can to spend more than that. Then the auditor checks the public record."}
        </p>
      </div>
      {/* Secondary: Start run stays the only filled button in the view. */}
      <button
        className={BTN}
        disabled={stress?.status === "running" || snap?.busy}
        onClick={async () => {
          setStartError(null);
          setStartError(await post("/api/demo/stress"));
        }}
      >
        {stress?.status === "running" ? "Trying…" : "Try to overspend"}
      </button>
      <ActionError what="The overspend test didn't start" message={startError} onDismiss={() => setStartError(null)} />
      {stress?.error && <div className="text-bad">{testCopy(stress.error)}</div>}
      {stress && stress.attempts.length > 0 && (
        <div className="space-y-3">
          <AttemptLedger attempts={stress.attempts} status={stress.status} />
          {stress.verdictUrl && (
            <a href={stress.verdictUrl} target="_blank" rel="noreferrer">
              The auditor&apos;s verdict, stored on Arweave
            </a>
          )}
        </div>
      )}
    </div>
  );
}
