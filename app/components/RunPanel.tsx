"use client";

import type { Snapshot } from "@/lib/demo/snapshot";
import type { TrainingRunView } from "@/lib/demo/train";
import type { TrainedModel } from "@/lib/train";
import { HELP } from "./copy";
import { StressTest } from "./StressTest";
import { Timeline } from "./Timeline";
import { TryIt } from "./TryIt";

const STAGES = ["Deal", "Payment", "Training", "Receipt"] as const;

type StageState = "done" | "now" | "next" | "failed";

/** Which of the four stages the run is in, from `job.phase`. A failed run is pinned to the stage it stopped in. */
function stageIndex(job: TrainingRunView): number {
  switch (job.phase) {
    case "negotiating":
      return 0;
    case "paying":
      return 1;
    case "booting":
    case "training":
      return 2;
    case "publishing":
      return 3;
    case "done":
      return STAGES.length;
    case "failed":
      if (job.paidUsd === null && job.handle === null) return job.plan === null ? 0 : 1;
      return job.doneAt === null ? 2 : 3;
  }
}

function StageRow({ job }: { job: TrainingRunView }) {
  const at = stageIndex(job);
  const failed = job.phase === "failed";
  const state = (i: number): StageState => (i < at ? "done" : i > at ? "next" : failed ? "failed" : "now");
  return (
    <ol aria-label="Run stages" className="grid grid-cols-4 gap-[3px]">
      {STAGES.map((label, i) => {
        const s = state(i);
        return (
          <li key={label} aria-current={s === "now" ? "step" : undefined} className="min-w-0">
            <span
              aria-hidden
              className={`block h-[3px] ${s === "failed" ? "bg-bad" : s === "next" ? "bg-segment" : "bg-foreground"}`}
            />
            <span
              className={`mt-1.5 block truncate text-[12.5px] ${
                s === "now" ? "font-semibold text-foreground" : s === "failed" ? "text-bad" : s === "done" ? "text-foreground" : "text-muted"
              }`}
            >
              {label}
              {s === "failed" && <span className="sr-only">, stopped here</span>}
              {s === "done" && <span className="sr-only">, finished</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function RunPanel({
  snap,
  job,
  current,
  previous,
  previousModel,
  post,
}: {
  snap: Snapshot | null;
  job: TrainingRunView | null;
  current: TrainedModel | null;
  previous: TrainingRunView | null;
  previousModel: TrainedModel | null;
  post: (path: string, body?: unknown) => Promise<void>;
}) {
  return (
    <div className="space-y-8">
      {job && <StageRow job={job} />}

      {job && <Timeline job={job} model={current} />}

      {job?.phase === "done" && current ? (
        <TryIt title="Your model" job={job} model={current} models={snap?.models} />
      ) : previousModel && previous ? (
        <TryIt title="The model from the last run" job={previous} model={previousModel} models={snap?.models} />
      ) : (
        <div className={job ? "border-t border-rule pt-5" : ""}>
          <h2 className="text-[15px] font-semibold text-foreground">Nothing trained yet</h2>
          <p className="mt-1.5 max-w-[46ch] text-muted">{HELP.empty}</p>
        </div>
      )}

      {job?.phase === "done" && <StressTest snap={snap} post={post} />}
    </div>
  );
}
