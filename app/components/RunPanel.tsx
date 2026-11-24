import type { Snapshot } from "@/lib/demo/snapshot";
import type { TrainingRunView } from "@/lib/demo/train";
import type { TrainedModel } from "@/lib/train";
import type { Post } from "./ActionError";
import { HELP } from "./copy";
import { STAGES, stageIndex } from "./stages";
import { StressTest } from "./StressTest";
import { Timeline } from "./Timeline";
import { TryIt } from "./TryIt";

type StageState = "done" | "now" | "next" | "failed";

/**
 * With no job every stage is upcoming, so the row previews what Start run will do. Upcoming stages are
 * thin dashed strong-rule bars, finished ones thin solid ink bars with a check before the label, and the
 * current (or failed) stage a thick bar, so state never rests on the colour difference alone and a
 * finished run reads as a completed ink track.
 */
/** A 10px drawn check for finished stages, in the label's ink. */
function Check() {
  return (
    <svg aria-hidden width="10" height="10" viewBox="0 0 10 10" className="shrink-0" fill="none">
      <path d="M1.5 5.2 4 7.6 8.5 2.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StageRow({ job }: { job: TrainingRunView | null }) {
  const at = job ? stageIndex(job) : -1;
  const failed = job?.phase === "failed";
  const state = (i: number): StageState => (i < at ? "done" : i > at ? "next" : failed ? "failed" : "now");
  return (
    <div>
      {/* Before a run the row is a preview, so it says so; during a run the timeline under it explains each stage. */}
      {!job && (
        <p id="stages-label" className="mb-2 text-[12px] leading-4 font-medium text-foreground">
          What happens when you start
        </p>
      )}
      <ol aria-label={job ? "Run stages" : undefined} aria-labelledby={job ? undefined : "stages-label"} className="grid grid-cols-4 gap-[3px]">
        {STAGES.map((label, i) => {
          const s = state(i);
          return (
            <li key={label} aria-current={s === "now" ? "step" : undefined} className="min-w-0">
              <span className="flex h-[5px] items-end" aria-hidden>
                <span
                  className={`block w-full ${
                    s === "now"
                      ? "h-[5px] bg-foreground"
                      : s === "failed"
                        ? "h-[5px] bg-bad"
                        : s === "done"
                          ? "h-[2px] bg-foreground"
                          : "h-0 border-t-2 border-dashed border-rule-strong"
                  }`}
                />
              </span>
              <span
                className={`mt-1.5 flex items-center gap-1 truncate text-[12px] leading-4 ${
                  s === "now"
                    ? "font-semibold text-foreground"
                    : s === "failed"
                      ? "font-semibold text-bad"
                      : s === "done"
                        ? "font-medium text-foreground"
                        : "font-medium text-muted"
                }`}
              >
                {s === "done" && <Check />}
                <span className="truncate">{label}</span>
                {s === "failed" && <span className="sr-only">, stopped here</span>}
                {s === "done" && <span className="sr-only">, finished</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
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
  post: Post;
}) {
  const done = job?.phase === "done";
  const settled = done || job?.phase === "failed";
  // The finished run's model sits directly under the result heading, inside the timeline.
  const result = done && current && job ? <TryIt title="Your model" job={job} model={current} models={snap?.models} bare /> : null;
  return (
    <div className="space-y-8">
      <StageRow job={job} />

      {job && <Timeline job={job} model={current} result={result} />}

      {result ? null : previousModel && previous ? (
        <TryIt title="The model from the last run" job={previous} model={previousModel} models={snap?.models} />
      ) : !job || settled ? (
        <div className={job ? "border-t border-rule pt-6" : ""}>
          {job?.phase === "failed" ? (
            <>
              <h2 className="text-[16px] leading-[22px] font-semibold text-foreground">No model from this run</h2>
              <p className="mt-1.5 max-w-[44ch] text-muted">It stopped before a model was trained. The next finished run puts its model here.</p>
            </>
          ) : (
            <>
              <h2 className="text-[16px] leading-[22px] font-semibold text-foreground">Nothing trained yet</h2>
              <p className="mt-1.5 max-w-[44ch] text-muted">{HELP.empty}</p>
            </>
          )}
        </div>
      ) : null}

      {done && <StressTest snap={snap} post={post} />}
    </div>
  );
}
