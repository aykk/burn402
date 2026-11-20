"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Nav } from "@/app/nav";
import type { Snapshot } from "@/lib/demo/snapshot";
import type { DatasetSource, TrainedModel } from "@/lib/train";
import { DatasetCard, type Detected } from "@/app/components/DatasetCard";
import { LogDrawer } from "@/app/components/LogDrawer";
import { ModelPicker } from "@/app/components/ModelPicker";
import { Timeline } from "@/app/components/Timeline";
import { TryIt } from "@/app/components/TryIt";
import { size } from "@/app/components/format";


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
  const [request, setRequest] = useState("");
  const [url, setUrl] = useState("");
  const [sources, setSources] = useState<DatasetSource[]>([]);
  const [detected, setDetected] = useState<Detected | null>(null);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [datasetError, setDatasetError] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("");
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [budget, setBudget] = useState(5);
  const [rate, setRate] = useState(1.25);
  const [deadline, setDeadline] = useState(30);
  const [preference, setPreference] = useState(0.5);
  const [models, setModels] = useState<Record<string, TrainedModel>>({});
  const fileRef = useRef<HTMLInputElement>(null);

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

  const combineSources = async (list: DatasetSource[]) => {
    if (list.length === 0) {
      setDetected(null);
      return;
    }
    const res = await fetch("/api/demo/dataset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sources: list }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    setDetected(body as Detected);
  };

  const addSources = async (init: RequestInit) => {
    setDatasetError(null);
    setReading(true);
    try {
      const res = await fetch("/api/demo/dataset", init);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const next = [...sources, (body as Detected).dataset];
      setSources(next);
      await combineSources(next);
    } catch (e) {
      setDatasetError((e as Error).message);
    } finally {
      setReading(false);
    }
  };

  const readFiles = (files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append("file", file);
    void addSources({ method: "POST", body: form });
  };

  const readUrl = () => {
    if (!url.trim()) return;
    void addSources({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) }).then(() => setUrl(""));
  };

  const dropSource = async (index: number) => {
    const next = sources.filter((_, i) => i !== index);
    setSources(next);
    setDatasetError(null);
    try {
      await combineSources(next);
    } catch (e) {
      setDatasetError((e as Error).message);
    }
  };

  const registerAgent = async () => {
    if (!agentName.trim()) return;
    setRegistering(true);
    setRegisterError(null);
    try {
      const res = await fetch("/api/demo/identity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: agentName }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setRegisterError((e as Error).message);
    } finally {
      setRegistering(false);
    }
  };

  const running = job !== null && !["done", "failed"].includes(job.phase);
  const hasKey = snap?.models.providers.find((p) => p.id === snap.models.selected)?.key;
  const current = job && models[job.id] ? models[job.id] : null;
  const previous = snap?.previous ?? null;
  const previousModel = previous && models[previous.id] ? models[previous.id] : null;

  return (
    <main className="mx-auto flex h-screen w-full max-w-[1280px] flex-col overflow-hidden px-10 py-6">
      <Nav current="/">
        {snap && <ModelPicker models={snap.models} disabled={running} onSave={(provider, key) => post("/api/demo/model", { provider, key })} />}
        <label className="flex items-center gap-2 text-muted" title="Your own words go on Arweave with the negotiation, permanently and publicly. Off by default: only the desk's side is stored as text, yours as a hash.">
          <input
            type="checkbox"
            checked={snap?.disclosure === "full"}
            disabled={running}
            onChange={(e) => post("/api/demo/network", { disclosure: e.target.checked ? "full" : "desk-only" })}
          />
          Append conversations to record
        </label>
        <button className="underline underline-offset-2" onClick={() => setDrawer(true)}>
          Log
        </button>
        <button
          className="text-muted underline underline-offset-2"
          title="Forget this session: destroys any running server, clears the jobs and the log"
          onClick={async () => {
            await post("/api/demo/reset");
            setSources([]);
            setDetected(null);
            setDatasetError(null);
            setUrl("");
            setRequest("");
            setAgentName("");
            setRegisterError(null);
          }}
        >
          Reset
        </button>
      </Nav>

      <Pipeline />

      {error && <div className="mt-4 shrink-0 text-bad">Can&apos;t reach the demo server ({error}). Start it with: npm run dev</div>}

      <section className="mt-6 grid min-h-0 flex-1 gap-10 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="min-h-0 space-y-12 overflow-y-auto pb-6 pr-4">
          <div className="space-y-8">
            <div className="space-y-2">
              <h2 className="text-[15px] font-bold">Your agent</h2>
              <div className="text-muted">
                Carries the budget and timeframe for this instance. Negotiates with the Vultr desk and pays it. Name it to get its own registered
                identity, so that all transactions and records can be attributed to it. Not to be confused with the model you are training.
              </div>
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void registerAgent();
                }}
              >
                <input
                  className="min-w-0 flex-1 border border-rule px-2.5 py-1"
                  placeholder="agent-name"
                  value={agentName}
                  disabled={running || registering}
                  onChange={(e) => setAgentName(e.target.value)}
                />
                <button
                  className="border border-rule-strong px-3 py-1 hover:border-foreground disabled:opacity-40"
                  disabled={running || registering || !agentName.trim()}
                >
                  {registering ? "Registering…" : "Register it"}
                </button>
              </form>
              {registerError && <div className="text-bad">{registerError}</div>}
              {snap?.company && (
                <div>
                  <span className="text-ok">registered</span> <span className="break-all">{snap.company.ansName}</span>
                  <div className="text-muted">its key is sealed in the transparency log</div>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <h2 className="text-[15px] font-bold">Training data</h2>
              <div
                className={`flex flex-wrap items-center gap-3 rounded-lg border border-dashed p-4 transition-colors ${dragging ? "border-foreground bg-surface" : "border-rule-strong"}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!running && !dragging) setDragging(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  setDragging(false);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  if (running) return;
                  const files = Array.from(e.dataTransfer.files ?? []);
                  if (files.length > 0) readFiles(files);
                }}
              >
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    if (files.length > 0) readFiles(files);
                    e.target.value = "";
                  }}
                />
                <button
                  className="border border-charcoal bg-charcoal px-3 py-1 text-background hover:opacity-85 disabled:opacity-30"
                  disabled={running || reading}
                  onClick={() => fileRef.current?.click()}
                >
                  {sources.length > 0 ? "Add more files" : "Choose files"}
                </button>
                <span className="text-muted">{dragging ? "drop them here" : "or drop them here, or"}</span>
                <input
                  className="min-w-0 flex-1 border border-rule px-2.5 py-1"
                  placeholder="paste a URL"
                  value={url}
                  disabled={running}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") readUrl();
                  }}
                />
                <button
                  className="border border-rule-strong px-3 py-1 hover:border-foreground disabled:opacity-40"
                  disabled={running || reading || !url.trim()}
                  onClick={readUrl}
                >
                  Add
                </button>
              </div>

              {sources.length > 0 && (
                <div className="space-y-1">
                  {sources.map((src, i) => (
                    <div key={`${src.uploadId ?? src.url}-${i}`} className="flex items-baseline gap-3">
                      <span className="truncate">{src.name}</span>
                      <span className="shrink-0 text-muted">{size(src)}</span>
                      <button
                        className="ml-auto shrink-0 text-muted underline underline-offset-2 hover:text-foreground disabled:opacity-40"
                        disabled={running}
                        onClick={() => void dropSource(i)}
                      >
                        remove
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {reading && <div className="text-muted">Reading it…</div>}
              {datasetError && <div className="text-bad">{datasetError}</div>}
              {detected && <DatasetCard detected={detected} />}
            </div>

            <div className="space-y-2">
              <h2 className="text-[15px] font-bold">What should the custom model learn to do?</h2>
              <textarea
                className="w-full resize-none border border-rule px-3 py-2.5 leading-relaxed"
                rows={3}
                placeholder="Take our company documentation and datasets and spin up a custom chatbot that attributes our documentation and data for relevant responses, and refuses questions that are not about our company."
                value={request}
                disabled={running}
                onChange={(e) => setRequest(e.target.value)}
              />
            </div>

            <div className="space-y-4">
              <h2 className="text-[15px] font-bold">Budget and timeframe</h2>
              <div className="grid gap-4 sm:grid-cols-3">
                <label className="space-y-1">
                  <div className="text-muted">Total budget</div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="shrink-0 text-muted">$</span>
                    <input
                      type="number"
                      min={0.05}
                      max={20}
                      step={0.25}
                      value={budget}
                      disabled={running}
                      className="min-w-0 flex-1 border border-rule px-2 py-1"
                      onChange={(e) => {
                        const next = Number(e.target.value);
                        setBudget(next);
                        if (rate > next) setRate(next);
                      }}
                    />
                  </div>
                </label>
                <label className="space-y-1">
                  <div className="text-muted">Hourly cap</div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="shrink-0 text-muted">$</span>
                    <input
                      type="number"
                      min={0.003}
                      max={budget}
                      step={0.005}
                      value={rate}
                      disabled={running}
                      className="min-w-0 flex-1 border border-rule px-2 py-1"
                      onChange={(e) => setRate(Number(e.target.value))}
                    />
                    <span className="shrink-0 text-muted">per hour</span>
                  </div>
                </label>
                <label className="space-y-1">
                  <div className="text-muted">Time limit</div>
                  <div className="flex items-baseline gap-1.5">
                    <input
                      type="number"
                      min={3}
                      max={120}
                      step={1}
                      value={deadline}
                      disabled={running}
                      className="min-w-0 flex-1 border border-rule px-2 py-1"
                      onChange={(e) => setDeadline(Number(e.target.value))}
                    />
                    <span className="shrink-0 text-muted">minutes</span>
                  </div>
                </label>
              </div>

              <div className="space-y-1">
                <div className="text-muted">Pick a plan that is</div>
                <div className="flex gap-2">
                  {(
                    [
                      ["cheapest", 0],
                      ["balanced", 0.5],
                      ["fastest", 1],
                    ] as const
                  ).map(([label, value]) => (
                    <button
                      key={label}
                      className={`border px-4 py-1.5 ${preference === value ? "border-charcoal bg-charcoal text-background" : "border-rule-strong text-muted hover:border-charcoal hover:text-foreground"} disabled:opacity-40`}
                      disabled={running}
                      onClick={() => setPreference(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <button
                className="border border-charcoal bg-charcoal px-6 py-2.5 font-bold text-background hover:opacity-85 disabled:opacity-30"
                disabled={running || !hasKey || !detected || !snap?.company}
                onClick={() =>
                  post("/api/demo/job", {
                    request,
                    dataset: detected?.dataset,
                    budgetUsd: budget,
                    rateUsdHr: rate,
                    deadlineMinutes: deadline,
                    preference,
                  })
                }
              >
                {running ? "Your agent is working…" : job ? "Pass another job" : "Pass to agent"}
              </button>
              {!hasKey && <span className="text-muted">pick a model and add its key, top right</span>}
              {hasKey && !snap?.company && <span className="text-muted">name and register your agent first</span>}
              {hasKey && snap?.company && !detected && <span className="text-muted">add the data it should learn from</span>}
            </div>
          </div>

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
