import type { Snapshot } from "@/lib/demo/snapshot";
import type { TrainingRunView } from "@/lib/demo/train";
import type { TrainedModel } from "@/lib/train";
import { HELP } from "./copy";
import { StressTest } from "./StressTest";
import { Timeline } from "./Timeline";
import { TryIt } from "./TryIt";

const STAGES = ["Deal", "Payment", "Training", "Receipt"] as const;
const DEAL = 0;
const PAYMENT = 1;
const TRAINING = 2;
const RECEIPT = 3;

type StageState = "done" | "now" | "next" | "failed";

/**
 * Which of the four stages the run is in. The backend never reports "paying" (the agent pays inside
 * the negotiation), so Payment is derived: a plan is picked or money has moved, but the server is not
 * yet both rented and paid for. A failed run is pinned to the stage it stopped in, from what happened.
 */
function stageIndex(job: TrainingRunView): number {
  const planned = job.plan !== null;
  const paid = job.paidUsd !== null;
  switch (job.phase) {
    case "negotiating":
      return planned || paid ? PAYMENT : DEAL;
    case "paying":
      return PAYMENT;
    case "booting":
      return planned && !paid ? PAYMENT : TRAINING;
    case "training":
      return TRAINING;
    case "publishing":
      return RECEIPT;
    case "done":
      return STAGES.length;
    case "failed":
      if (!planned && !paid) return DEAL;
      return planned && paid ? TRAINING : PAYMENT;
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
            {/* Current: thick ink bar. Finished: thin muted bar. Upcoming: empty segment. */}
            <span className="flex h-[5px] items-end" aria-hidden>
              <span
                className={`block w-full ${
                  s === "now" ? "h-[5px] bg-foreground" : s === "failed" ? "h-[5px] bg-bad" : s === "done" ? "h-[2px] bg-muted" : "h-[2px] bg-segment"
                }`}
              />
            </span>
            <span
              className={`mt-1.5 block truncate text-[12.5px] ${
                s === "now" ? "font-bold text-foreground" : s === "failed" ? "font-bold text-bad" : "text-muted"
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
