"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Nav } from "@/app/nav";
import type { Snapshot } from "@/lib/demo/snapshot";
import type { TrainedModel } from "@/lib/train";
import { BudgetMeter } from "@/app/components/BudgetMeter";
import { JobForm, type JobDraft } from "@/app/components/JobForm";
import { LogDrawer } from "@/app/components/LogDrawer";
import { ModelPicker } from "@/app/components/ModelPicker";
import { RunPanel } from "@/app/components/RunPanel";
import { ActionError, UNREACHABLE, type Post } from "@/app/components/ActionError";
import { runAnnouncement, runMark, type RunMark } from "@/app/components/announce";

export default function Page() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  // Only the 1.5s state poll writes this: it means the page has lost the server. Action failures live
  // next to their controls instead, so the next good poll cannot wipe them.
  const [error, setError] = useState<{ message: string; unreachable: boolean } | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const logButton = useRef<HTMLButtonElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draft, setDraft] = useState<JobDraft>({ budgetUsd: 5, rateUsdHr: 1.25 });
  const [resetSignal, setResetSignal] = useState(0);
  const [models, setModels] = useState<Record<string, TrainedModel>>({});
  // Server clock minus client clock, refreshed on every poll, so the meter ticks in server seconds.
  const clockOffset = useRef(0);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    let res: Response;
    try {
      res = await fetch("/api/demo/state", { cache: "no-store" });
    } catch (e) {
      setError({ message: (e as Error).message, unreachable: true });
      return;
    }
    try {
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      if (typeof body.now === "number") clockOffset.current = body.now - Date.now() / 1000;
      setSnap(body);
      setError(null);
    } catch (e) {
      setError({ message: (e as Error).message, unreachable: false });
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const poll = setInterval(load, 1500);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
    };
  }, [load]);

  const job = snap?.job ?? null;

  // Run milestones for screen readers (stage, payment, done, failed), never the per-second drain.
  // `undefined` until the first snapshot, so loading the page on an old run is a silent baseline.
  const lastMark = useRef<RunMark | null | undefined>(undefined);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (!snap) return;
    const said = runAnnouncement(lastMark.current, job);
    lastMark.current = job ? runMark(job) : null;
    if (said) setAnnouncement(said);
  }, [snap, job]);

  useEffect(() => {
    if (!job?.modelReady || models[job.id]) return;
    void fetch(`/api/demo/trained?job=${job.id}`)
      .then((r) => r.json())
      .then((b: { id?: string; model?: TrainedModel }) => {
        if (b.id && b.model) setModels((m) => ({ ...m, [b.id!]: b.model! }));
      })
      .catch(() => {});
  }, [job?.modelReady, job?.id, models]);

  const post: Post = async (path, body) => {
    let res: Response;
    try {
      res = await fetch(path, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      return UNREACHABLE;
    }
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) return json.error ?? `The server answered HTTP ${res.status}`;
    await load();
    return null;
  };

  const closeDrawer = useCallback(() => setDrawer(false), []);

  const running = job !== null && !["done", "failed"].includes(job.phase);
  const current = job && models[job.id] ? models[job.id] : null;
  const previous = snap?.previous ?? null;
  const previousModel = previous && models[previous.id] ? models[previous.id] : null;

  // While a run is live (and the server answers), tick once a second so the meter drains between polls.
  useEffect(() => {
    if (!running || error) return;
    const id = setInterval(() => setTick(Date.now() / 1000 + clockOffset.current), 1000);
    return () => clearInterval(id);
  }, [running, error]);
  const nowSec = running ? Math.max(tick, snap?.now ?? 0) : (snap?.now ?? 0);

  return (
    <main className="mx-auto flex w-full max-w-[1280px] flex-col px-4 py-5 sm:px-6 lg:px-10 lg:py-6">
      <Nav current="/">
        {snap && (
          <ModelPicker
            models={snap.models}
            disabled={running}
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onSave={(provider, key) => post("/api/demo/model", { provider, key })}
          />
        )}
        <button
          ref={logButton}
          className="underline decoration-1 underline-offset-[3px] hover:decoration-2"
          aria-haspopup="dialog"
          aria-expanded={drawer}
          onClick={() => setDrawer(true)}
        >
          Log
        </button>
        {/* Reset is destructive, so it sits 40px from Log instead of 24. */}
        <button
          className="ml-4 text-muted underline decoration-1 underline-offset-[3px] hover:text-foreground"
          title="Forget this session: destroys any running server, clears the jobs and the log"
          onClick={async () => {
            setResetError(null);
            const failed = await post("/api/demo/reset");
            // A refused reset keeps the form as it was, so it still matches what the server holds.
            if (failed) setResetError(failed);
            else setResetSignal((k) => k + 1);
          }}
        >
          Reset
        </button>
      </Nav>

      {/* A cold visitor learns what this is in one line; the meter under it stays the biggest thing on the page. */}
      {/* On wide screens the explanation trails the heading on its baseline; it wraps under it when narrower. */}
      <div className="flex shrink-0 flex-wrap items-baseline gap-x-4 gap-y-1 pt-2">
        <h1 className="text-[20px] leading-[26px] font-semibold">Give an agent a budget and it trains a custom model for you.</h1>
        <p className="text-muted">It rents a server, pays as it goes, and the server shuts down when the budget runs out.</p>
      </div>

      <div className="mt-4 shrink-0">
        <BudgetMeter
          agentName={snap?.company?.name ?? null}
          formBudgetUsd={draft.budgetUsd}
          formRateUsdHr={draft.rateUsdHr}
          job={job}
          nowSec={nowSec}
        />
      </div>

      {resetError && (
        <div className="mt-4 shrink-0">
          <ActionError what="Reset didn't finish" message={resetError} onDismiss={() => setResetError(null)} />
        </div>
      )}

      {error && (
        <div role="status" className="mt-4 shrink-0 text-bad">
          {error.unreachable
            ? `Can't reach the demo server (${error.message}). Start it with: npm run dev`
            : `The demo server couldn't report its state (${error.message}). Check the terminal running npm run dev.`}
        </div>
      )}

      {/* The run column is wide while there is a current job (live, finished or failed) so the plan
          table fits; it gives the space back to the form after Reset. A finished job leaves the form
          expanded in a slightly wider column so the next run can be set up. */}
      <section
        className={`mt-6 grid grid-cols-[minmax(0,1fr)] gap-8 lg:gap-10 ${
          running
            ? "lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]"
            : job
              ? "lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]"
              : "lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]"
        }`}
      >
        {/* Below lg a current job puts the run column first, so the result is not under a blank form. */}
        <div className={`lg:pr-4 lg:pb-6 ${job ? "border-t border-rule pt-8 lg:border-t-0 lg:pt-0" : ""}`}>
          <JobForm
            resetSignal={resetSignal}
            snap={snap}
            running={running}
            collapsed={running}
            onDraftChange={setDraft}
            onStart={(body) => post("/api/demo/job", body)}
            onAddKey={() => setPickerOpen(true)}
            reload={load}
            post={post}
          />
        </div>

        <div
          className={`border-rule lg:sticky lg:top-6 lg:self-start lg:border-l lg:pt-0 lg:pr-2 lg:pb-6 lg:pl-10 ${
            job ? "order-first lg:order-none" : "border-t pt-8 lg:border-t-0"
          }`}
        >
          <RunPanel snap={snap} job={job} current={current} previous={previous} previousModel={previousModel} post={post} />
        </div>
      </section>

      <LogDrawer open={drawer} onClose={closeDrawer} log={snap?.log ?? []} returnFocus={logButton} />

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>
    </main>
  );
}
