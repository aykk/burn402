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

export default function Page() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [draft, setDraft] = useState<JobDraft>({ budgetUsd: 5, rateUsdHr: 1.25 });
  const [resetSignal, setResetSignal] = useState(0);
  const [models, setModels] = useState<Record<string, TrainedModel>>({});
  // Server clock minus client clock, refreshed on every poll, so the meter ticks in server seconds.
  const clockOffset = useRef(0);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/demo/state", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      if (typeof body.now === "number") clockOffset.current = body.now - Date.now() / 1000;
      setSnap(body);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
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

  useEffect(() => {
    if (!job?.modelReady || models[job.id]) return;
    void fetch(`/api/demo/trained?job=${job.id}`)
      .then((r) => r.json())
      .then((b: { id?: string; model?: TrainedModel }) => {
        if (b.id && b.model) setModels((m) => ({ ...m, [b.id!]: b.model! }));
      })
      .catch(() => {});
  }, [job?.modelReady, job?.id, models]);

  const post = async (path: string, body?: unknown) => {
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

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
        {snap && <ModelPicker models={snap.models} disabled={running} onSave={(provider, key) => post("/api/demo/model", { provider, key })} />}
        <button className="underline decoration-1 underline-offset-[3px] hover:decoration-2" onClick={() => setDrawer(true)}>
          Log
        </button>
        {/* Reset is destructive, so it sits 40px from Log instead of 24. */}
        <button
          className="ml-4 text-muted underline decoration-1 underline-offset-[3px] hover:text-foreground"
          title="Forget this session: destroys any running server, clears the jobs and the log"
          onClick={async () => {
            await post("/api/demo/reset");
            setResetSignal((k) => k + 1);
          }}
        >
          Reset
        </button>
      </Nav>

      <div className="shrink-0">
        <BudgetMeter
          agentName={snap?.company?.name ?? null}
          formBudgetUsd={draft.budgetUsd}
          formRateUsdHr={draft.rateUsdHr}
          job={job}
          nowSec={nowSec}
        />
      </div>

      {error && <div className="mt-4 shrink-0 text-bad">Can&apos;t reach the demo server ({error}). Start it with: npm run dev</div>}

      {/* The run column is wide while there is a current job (live, finished or failed) so the plan
          table fits; it gives the space back to the form after Reset. A finished job leaves the form
          expanded in a slightly wider column so the next run can be set up. */}
      <section
        className={`mt-8 grid grid-cols-[minmax(0,1fr)] gap-8 lg:gap-10 ${
          running
            ? "lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]"
            : job
              ? "lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]"
              : "lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]"
        }`}
      >
        <div className="lg:pr-4 lg:pb-6">
          <JobForm
            resetSignal={resetSignal}
            snap={snap}
            running={running}
            collapsed={running}
            onDraftChange={setDraft}
            onStart={(body) => post("/api/demo/job", body)}
            reload={load}
            post={post}
          />
        </div>

        <div className="border-t border-rule pt-8 lg:sticky lg:top-6 lg:self-start lg:border-t-0 lg:border-l lg:pt-0 lg:pr-2 lg:pb-6 lg:pl-10">
          <RunPanel snap={snap} job={job} current={current} previous={previous} previousModel={previousModel} post={post} />
        </div>
      </section>

      <LogDrawer open={drawer} onClose={() => setDrawer(false)} log={snap?.log ?? []} />
    </main>
  );
}
