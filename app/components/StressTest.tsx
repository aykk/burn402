"use client";

import type { Snapshot } from "@/lib/demo/snapshot";
import { money, toneOf } from "./format";

export function StressTest({ snap, post }: { snap: Snapshot | null; post: (path: string, body?: unknown) => Promise<void> }) {
  const stress = snap?.stress;
  const target = stress?.target;
  const attempts = stress?.attempts.length ?? 0;
  const tries = attempts > 0 ? `${attempts} ways` : "every way it can";
  const before = stress?.trustBefore?.behavior ?? null;
  const after = stress?.trustAfter?.behavior ?? null;
  return (
    <div className="space-y-3 border-t border-rule pt-8">
      <div className="flex flex-wrap items-baseline gap-x-4">
        <h2 className="text-[15px] font-bold">Limit testing</h2>
        <button
          className="border border-foreground bg-foreground px-3.5 py-1.5 text-background hover:opacity-85 disabled:opacity-40"
          disabled={stress?.status === "running" || snap?.busy}
          onClick={() => post("/api/demo/stress")}
        >
          {stress?.status === "running" ? "Trying…" : "Start"}
        </button>
      </div>
      <div className="text-muted">
        {target
          ? `A second agent is handed a slice of the same budget: ${money(target.budgetUsd)} at up to ${money(target.rateUsdHr)} an hour. It tries ${tries} to spend more than that.`
          : "A second agent is handed a slice of the budget this job used, then tries to spend more than it was allowed."}
      </div>
      {stress?.error && <div className="text-bad">{stress.error}</div>}
      {stress && stress.attempts.length > 0 && (
        <div className="space-y-2">
          {stress.attempts
            .filter((a) => !a.quiet)
            .map((a, i) => (
            <div key={i} className="border-l-2 pl-3" style={{ borderColor: toneOf(a) }}>
              <div>{a.what}</div>
              <div style={{ color: toneOf(a) }}>{a.result}</div>
              <div className="text-muted">{a.proves}</div>
            </div>
          ))}
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
              <span className="text-muted">
                {stress.trustAfter?.profile}, {before !== null && before !== after ? `from ${before} to ${after}` : after}
              </span>
              {(stress.trustAfter?.riskFactors ?? []).length > 0 && (
                <span className="text-muted">{stress.trustAfter!.riskFactors.join(", ")}</span>
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
