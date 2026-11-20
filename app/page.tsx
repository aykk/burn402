"use client";

import { useCallback, useEffect, useState } from "react";
import { Nav } from "@/app/nav";
import type { Snapshot } from "@/lib/demo/snapshot";
import type { TrainedModel } from "@/lib/train";
import { JobForm, type JobDraft } from "@/app/components/JobForm";
import { LogDrawer } from "@/app/components/LogDrawer";
import { ModelPicker } from "@/app/components/ModelPicker";
import { Timeline } from "@/app/components/Timeline";
import { TryIt } from "@/app/components/TryIt";


const PIPELINE = [
  { step: "your agent", detail: "ANS" },
  { step: "Vultr desk", detail: "A2A" },
  { step: "mandate", detail: "budget, rate, deadline" },
  { step: "x402", detail: "Solana" },
  { step: "Vultr box", detail: "trains, then dies" },
  { step: "Arweave", detail: "receipt" },
];



function Pipeline() {
  return (
    <div className="flex shrink-0 items-baseline gap-2.5 overflow-x-auto whitespace-nowrap border-b border-rule pb-4 text-[12.5px]">
      {PIPELINE.map((p, i) => (
        <span key={p.step} className="flex items-baseline gap-2">
          <span>
            {p.step} <span className="text-muted">{p.detail}</span>
          </span>
          {i < PIPELINE.length - 1 && <span className="text-muted">-&gt;</span>}
        </span>
      ))}
    </div>
  );
}

export default function Page() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [draft, setDraft] = useState<JobDraft>({ budgetUsd: 5, rateUsdHr: 1.25 });
  const [formKey, setFormKey] = useState(0);
  const [models, setModels] = useState<Record<string, TrainedModel>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/demo/state", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
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

  return (
    <main className="mx-auto flex h-screen w-full max-w-[1280px] flex-col overflow-hidden px-10 py-6">
      <Nav current="/">
        {snap && <ModelPicker models={snap.models} disabled={running} onSave={(provider, key) => post("/api/demo/model", { provider, key })} />}
        <button className="underline underline-offset-2" onClick={() => setDrawer(true)}>
          Log
        </button>
        <button
          className="text-muted underline underline-offset-2"
          title="Forget this session: destroys any running server, clears the jobs and the log"
          onClick={async () => {
            await post("/api/demo/reset");
            setFormKey((k) => k + 1);
          }}
        >
          Reset
        </button>
      </Nav>

      <Pipeline />

      {error && <div className="mt-4 shrink-0 text-bad">Can&apos;t reach the demo server ({error}). Start it with: npm run dev</div>}

      <section className="mt-6 grid min-h-0 flex-1 gap-10 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="min-h-0 space-y-12 overflow-y-auto pb-6 pr-4">
          <JobForm
            key={formKey}
            snap={snap}
            running={running}
            collapsed={running}
            onDraftChange={setDraft}
            onStart={(body) => post("/api/demo/job", body)}
            reload={load}
            post={post}
          />

          {job && <Timeline job={job} model={current} snap={snap} post={post} />}
        </div>

        <aside className="min-h-0 space-y-8 overflow-y-auto border-l border-rule pb-6 pl-10 pr-2">
          {job?.phase === "done" && current ? (
            <TryIt title="Your model" job={job} model={current} models={snap?.models} />
          ) : previousModel && previous ? (
            <TryIt title="The model from the last run" job={previous} model={previousModel} models={snap?.models} />
          ) : (
            <div className="rounded-lg border border-rule bg-surface p-5 text-muted">
              <div className="font-bold text-foreground">Nothing trained yet</div>
              <p className="mt-2 max-w-[46ch]">
                When a job finishes, the model produced lands here and can run in your browser. You can also download the model directly.
              </p>
            </div>
          )}
        </aside>
      </section>

      <LogDrawer open={drawer} onClose={() => setDrawer(false)} log={snap?.log ?? []} />
    </main>
  );
}
