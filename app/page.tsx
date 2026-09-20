"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Snapshot } from "@/lib/demo/snapshot";
import type { TrainingRunView } from "@/lib/demo/train";
import type { DatasetSource, Metric, TrainedModel } from "@/lib/train";
import { formatMetric, headlineMetric, run as runModel, runnerFor } from "@/lib/train/infer";

const REGIONS: Record<string, string> = { ewr: "New Jersey", ord: "Chicago", atl: "Atlanta", lax: "Los Angeles", sjc: "Silicon Valley" };

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

function duration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "-";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

function money(n: number | null): string {
  if (n === null) return "-";
  return n >= 1 ? `$${n.toFixed(2)}` : `$${parseFloat(n.toFixed(6))}`;
}

function kb(bytes: number | null): string {
  return bytes === null ? "-" : bytes > 900000 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

const PHASE_TEXT: Record<TrainingRunView["phase"], string> = {
  negotiating: "your agent is talking to the Vultr desk",
  paying: "paying for the server over x402",
  booting: "the server is booting",
  training: "training on the rented server",
  publishing: "collecting the model",
  done: "done",
  failed: "stopped",
};

type Detected = { dataset: DatasetSource; labels: string[]; sampleRows: string[] };

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
    <div className="flex items-baseline gap-2 overflow-x-auto whitespace-nowrap border-b border-rule pb-3">
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
  const [detected, setDetected] = useState<Detected | null>(null);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [datasetError, setDatasetError] = useState<string | null>(null);
  const [budget, setBudget] = useState(5);
  const [rate, setRate] = useState(1.25);
  const [deadline, setDeadline] = useState(30);
  const [preference, setPreference] = useState(0.5);
  const [models, setModels] = useState<Record<string, TrainedModel>>({});
  const logRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [snap?.log.length, drawer]);

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

  const readFile = (file: File) => {
    const form = new FormData();
    form.append("file", file);
    void readDataset({ method: "POST", body: form });
  };

  const readDataset = async (init: RequestInit) => {
    setDatasetError(null);
    setReading(true);
    try {
      const res = await fetch("/api/demo/dataset", init);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setDetected(body as Detected);
    } catch (e) {
      setDetected(null);
      setDatasetError((e as Error).message);
    } finally {
      setReading(false);
    }
  };

  const running = job !== null && !["done", "failed"].includes(job.phase);
  const hasKey = snap?.models.providers.find((p) => p.id === snap.models.selected)?.key;
  const current = job && models[job.id] ? models[job.id] : null;
  const previous = snap?.previous ?? null;
  const previousModel = previous && models[previous.id] ? models[previous.id] : null;

  return (
    <main className="mx-auto w-full max-w-[1320px] px-8 py-6">
      <header className="flex flex-wrap items-baseline gap-x-6 gap-y-2 pb-3">
        <h1 className="text-lg font-bold">burn402</h1>
        <span className="ml-auto flex items-center gap-7">
          <Link href="/audit">ANS, mandates, receipts</Link>
          <Link href={`/records?network=${snap?.network ?? "production"}`}>Arweave records</Link>
          <button className="underline underline-offset-2" onClick={() => setDrawer(true)}>
            Log
          </button>
          <button className="text-muted underline underline-offset-2" onClick={() => post("/api/demo/reset")}>
            Start over
          </button>
        </span>
      </header>

      <Pipeline />

      {error && <div className="mt-4 text-bad">Can&apos;t reach the demo server ({error}). Start it with: npm run dev</div>}

      <section className="mt-6 grid gap-12 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="space-y-10">
          <div className="space-y-6">
            {snap && <ModelPicker models={snap.models} disabled={running} onSave={(provider, key) => post("/api/demo/model", { provider, key })} />}

            <div className="space-y-2">
              <h2 className="text-base font-bold">Your data</h2>
              <div
                className={`flex flex-wrap items-center gap-3 border border-dashed p-3 ${dragging ? "border-foreground bg-foreground/5" : "border-rule"}`}
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
                  if (files.length > 1) {
                    setDetected(null);
                    setDatasetError(`${files.length} files at once: burn402 trains one model per run, so drop the one you want to train on`);
                    return;
                  }
                  if (files[0]) readFile(files[0]);
                }}
              >
                <input
                  ref={fileRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) readFile(file);
                  }}
                />
                <button
                  className="border border-foreground px-3 py-2 hover:bg-foreground hover:text-background disabled:opacity-40"
                  disabled={running || reading}
                  onClick={() => fileRef.current?.click()}
                >
                  Choose a file
                </button>
                <span className="text-muted">{dragging ? "drop it here" : "or drop one here, or"}</span>
                <input
                  className="min-w-0 flex-1 border border-rule px-2 py-2"
                  placeholder="paste a URL to a CSV, TSV, JSONL or text file"
                  value={url}
                  disabled={running}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && url.trim()) void readDataset({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
                  }}
                />
                <button
                  className="border border-rule px-3 py-2 hover:border-foreground disabled:opacity-40"
                  disabled={running || reading || !url.trim()}
                  onClick={() => readDataset({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) })}
                >
                  Read it
                </button>
              </div>
              <div className="text-muted">
                Labelled rows train something that sorts text. Plain text trains something that writes more of it. Nothing about your data is assumed:
                the columns, the labels and the job all come from the file.
              </div>
              {reading && <div className="text-muted">Reading the first part of the file…</div>}
              {datasetError && <div className="text-bad">{datasetError}</div>}
              {detected && <DatasetCard detected={detected} />}
            </div>

            <div className="space-y-2">
              <h2 className="text-base font-bold">What should it learn to do?</h2>
              <textarea
                className="w-full resize-none border border-rule px-3 py-2"
                rows={2}
                placeholder={detected ? "leave this empty and your agent will describe the job from the data" : "add your data first"}
                value={request}
                disabled={running}
                onChange={(e) => setRequest(e.target.value)}
              />
            </div>

            <div className="space-y-3">
              <h2 className="text-base font-bold">What it may spend</h2>
              <div className="grid gap-4 sm:grid-cols-3">
                <label className="space-y-1">
                  <div className="text-muted">Total budget</div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-muted">$</span>
                    <input
                      type="number"
                      min={0.05}
                      max={20}
                      step={0.25}
                      value={budget}
                      disabled={running}
                      className="w-full border border-rule px-2 py-1"
                      onChange={(e) => {
                        const next = Number(e.target.value);
                        setBudget(next);
                        if (rate > next) setRate(next);
                      }}
                    />
                  </div>
                  <div className="text-muted">the mandate is void past this, faucet cap is $20</div>
                </label>
                <label className="space-y-1">
                  <div className="text-muted">Hourly cap</div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-muted">$</span>
                    <input
                      type="number"
                      min={0.003}
                      max={budget}
                      step={0.005}
                      value={rate}
                      disabled={running}
                      className="w-full border border-rule px-2 py-1"
                      onChange={(e) => setRate(Number(e.target.value))}
                    />
                    <span className="text-muted">/hr</span>
                  </div>
                  <div className="text-muted">the broker refuses any plan dearer than this</div>
                </label>
                <label className="space-y-1">
                  <div className="text-muted">Time limit</div>
                  <div className="flex items-baseline gap-2">
                    <input
                      type="number"
                      min={3}
                      max={120}
                      step={1}
                      value={deadline}
                      disabled={running}
                      className="w-full border border-rule px-2 py-1"
                      onChange={(e) => setDeadline(Number(e.target.value))}
                    />
                    <span className="text-muted">min</span>
                  </div>
                  <div className="text-muted">the mandate expires then, and the server dies</div>
                </label>
              </div>

              <div className="space-y-1">
                <div className="text-muted">Pick a plan that is</div>
                <div className="flex gap-2">
                  {([
                    ["cheapest", 0],
                    ["balanced", 0.5],
                    ["fastest", 1],
                  ] as const).map(([label, value]) => (
                    <button
                      key={label}
                      className={`border px-3 py-1 ${preference === value ? "border-foreground font-bold" : "border-rule text-muted hover:border-foreground"} disabled:opacity-40`}
                      disabled={running}
                      onClick={() => setPreference(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {snap && <ModelPicker models={snap.models} disabled={running} onSave={(provider, key) => post("/api/demo/model", { provider, key })} />}

            <div className="space-y-2">
              <h2 className="text-base font-bold">Your data</h2>
              <div
                className={`flex flex-wrap items-center gap-3 border border-dashed p-3 ${dragging ? "border-foreground bg-foreground/5" : "border-rule"}`}
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
                  if (files.length > 1) {
                    setDetected(null);
                    setDatasetError(`${files.length} files at once: burn402 trains one model per run, so drop the one you want to train on`);
                    return;
                  }
                  if (files[0]) readFile(files[0]);
                }}
              >
                <input
                  ref={fileRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) readFile(file);
                  }}
                />
                <button
                  className="border border-foreground px-3 py-2 hover:bg-foreground hover:text-background disabled:opacity-40"
                  disabled={running || reading}
                  onClick={() => fileRef.current?.click()}
                >
                  Choose a file
                </button>
                <span className="text-muted">{dragging ? "drop it here" : "or drop one here, or"}</span>
                <input
                  className="min-w-0 flex-1 border border-rule px-2 py-2"
                  placeholder="paste a URL to a CSV, TSV, JSONL or text file"
                  value={url}
                  disabled={running}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && url.trim()) void readDataset({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
                  }}
                />
                <button
                  className="border border-rule px-3 py-2 hover:border-foreground disabled:opacity-40"
                  disabled={running || reading || !url.trim()}
                  onClick={() => readDataset({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) })}
                >
                  Read it
                </button>
              </div>
              <div className="text-muted">
                Labelled rows train something that sorts text. Plain text trains something that writes more of it. Nothing about your data is assumed:
                the columns, the labels and the job all come from the file.
              </div>
              {reading && <div className="text-muted">Reading the first part of the file…</div>}
              {datasetError && <div className="text-bad">{datasetError}</div>}
              {detected && <DatasetCard detected={detected} />}
            </div>

            <div className="space-y-2">
              <h2 className="text-base font-bold">What should it learn to do?</h2>
              <textarea
                className="w-full resize-none border border-rule px-3 py-2"
                rows={2}
                placeholder={detected ? "leave this empty and your agent will describe the job from the data" : "add your data first"}
                value={request}
                disabled={running}
                onChange={(e) => setRequest(e.target.value)}
              />
            </div>

            <div className="grid gap-6 sm:grid-cols-2">
              <label className="space-y-1">
                <div className="text-muted">
                  Budget: <span className="text-foreground">{money(budget)}</span>, so at most {money(budget / 4)}/hour
                </div>
                <input type="range" min={1} max={20} step={1} value={budget} disabled={running} className="w-full" onChange={(e) => setBudget(Number(e.target.value))} />
              </label>
              <div className="space-y-1">
                <div className="text-muted">Pick a plan that is</div>
                <div className="flex gap-2">
                  {([
                    ["cheapest", 0],
                    ["balanced", 0.5],
                    ["fastest", 1],
                  ] as const).map(([label, value]) => (
                    <button
                      key={label}
                      className={`border px-3 py-1 ${preference === value ? "border-foreground font-bold" : "border-rule text-muted hover:border-foreground"} disabled:opacity-40`}
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
                className="border border-foreground px-5 py-2 font-bold hover:bg-foreground hover:text-background disabled:opacity-40"
                disabled={running || !hasKey || !detected}
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
                {running ? "Your agent is working…" : job ? "Send another job" : "Send it to your agent"}
              </button>
              {!hasKey && <span className="text-muted">add an API key for your agent first</span>}
            </div>
          </div>

          {job && <Timeline job={job} model={current} />}
        </div>

        <aside className="space-y-8">
          {job?.phase === "done" && current ? (
            <TryIt title="Your model" job={job} model={current} />
          ) : previousModel && previous ? (
            <TryIt title="The model from the last run" job={previous} model={previousModel} />
          ) : (
            <div className="border border-rule p-4 text-muted">
              <div className="font-bold text-foreground">Nothing trained yet</div>
              <p className="mt-2 max-w-[46ch]">
                When a job finishes, the model it produced lands here and runs in your browser. Whatever the trainer reports about it is shown as it
                reports it.
              </p>
            </div>
          )}
        </aside>
      </section>

      <div
        className={`fixed right-0 top-0 z-10 flex h-full w-full max-w-[620px] flex-col border-l border-rule bg-background shadow-xl transition-transform duration-200 ${drawer ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-center border-b border-rule p-3">
          <span className="font-bold">Event log</span>
          <button className="ml-auto border border-rule px-2" onClick={() => setDrawer(false)}>
            Close
          </button>
        </div>
        <div ref={logRef} className="flex-1 overflow-y-auto p-3 text-[12px]">
          {snap?.log.map((l) => (
            <div
              key={l.seq}
              className={`${l.kind === "error" || l.kind === "refused" || l.kind === "breach" ? "text-bad" : l.kind === "step" ? "mt-2 font-bold" : ""} whitespace-pre-wrap break-all`}
            >
              <span className="text-muted">{clock(l.at)} </span>
              {l.code} {l.text}
              {l.link && (
                <>
                  {"  "}
                  <a href={l.link.href} target="_blank" rel="noreferrer">
                    {l.link.label}
                  </a>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

function DatasetCard({ detected }: { detected: Detected }) {
  const d = detected.dataset;
  return (
    <div className="border-l-2 border-rule pl-3">
      <div>
        <b>{d.name}</b> · {d.note}
      </div>
      <div className="text-muted">
        {d.rows > 0 ? `about ${d.rows.toLocaleString()} rows` : `${Math.round(d.bytes / 1024).toLocaleString()} KB`} ·{" "}
        {d.origin === "upload" ? "uploaded from your machine" : "fetched from your URL"}
      </div>
      {detected.labels.length > 0 && <div className="text-muted">labels found: {detected.labels.slice(0, 8).join(", ")}{detected.labels.length > 8 ? ", …" : ""}</div>}
      {detected.sampleRows[0] && <div className="text-muted">&ldquo;{detected.sampleRows[0].slice(0, 140)}&rdquo;</div>}
    </div>
  );
}

function MetricList({ metrics }: { metrics: Metric[] }) {
  return (
    <div className="space-y-0.5">
      {metrics.map((m) => (
        <div key={m.key} className="flex justify-between gap-4">
          <span className="text-muted">{m.label}</span>
          <span>{formatMetric(m.value, m.format)}</span>
        </div>
      ))}
    </div>
  );
}

function Timeline({ job, model }: { job: TrainingRunView; model: TrainedModel | null }) {
  const status = job.status;
  const progress = status?.progress ?? 0;
  const elapsed = status?.elapsed ?? null;
  return (
    <div className="space-y-8 border-t border-rule pt-6">
      <div className="flex flex-wrap items-baseline gap-x-4">
        <h2 className="text-base font-bold">{PHASE_TEXT[job.phase]}</h2>
        <span className="text-muted">
          {job.model.name} by {job.model.company} · mandate {job.mandateJti} · {money(job.budgetUsd)} total, {money(job.rateUsdHr)}/hour cap, expires in{" "}
          {job.deadlineMinutes} min
        </span>
      </div>
      {job.error && <div className="text-bad">{job.error}</div>}
      <div className="text-muted">
        the job: <span className="text-foreground">{job.request}</span>
      </div>

      {job.messages.length > 0 && (
        <div className="space-y-3">
          <div className="text-muted">Agents have signed both ways, ANS keys verified.</div>
          {job.messages.map((m) => (
            <div key={m.seq} className={`flex ${m.fromLabel === "company" ? "justify-start" : "justify-end"}`}>
              <div className="max-w-[80%] border-l-2 pl-3" style={{ borderColor: m.fromLabel === "company" ? "var(--paid)" : "var(--warn)" }}>
                <div className="text-muted">
                  <span style={{ color: m.fromLabel === "company" ? "var(--paid)" : "var(--warn)" }}>
                    {m.fromLabel === "company" ? "your agent" : "Vultr desk"}
                  </span>{" "}
                  · {m.kind.replace(/_/g, " ")} · sig {m.signed}…{" "}
                  {m.verified ? <span className="text-ok">verified</span> : <span className="text-bad">unverified</span>}
                </div>
                <div className="whitespace-pre-wrap">{m.text}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {job.quotes.length > 0 && (
        <div className="space-y-2">
          <div className="text-muted">Recommended plans with budget of {money(job.budgetUsd)}:</div>
          <table className="w-full border-collapse">
            <thead className="text-muted">
              <tr className="border-b border-rule text-left">
                <th className="py-1 pr-3 font-normal">plan</th>
                <th className="py-1 pr-3 font-normal">cores</th>
                <th className="py-1 pr-3 font-normal">RAM</th>
                <th className="py-1 pr-3 text-right font-normal">$/hour</th>
                <th className="py-1 pr-3 text-right font-normal">ready in</th>
                <th className="py-1 pr-3 text-right font-normal">this job</th>
                <th className="py-1 text-right font-normal">budget lasts</th>
              </tr>
            </thead>
            <tbody>
              {job.quotes.map((q) => {
                const chosen = q.plan === job.chosen?.plan;
                return (
                  <tr key={q.plan} className={`border-b border-rule ${chosen ? "font-bold" : q.enoughRam && q.withinDeadline ? "" : "text-muted"}`}>
                    <td className="py-1 pr-3">
                      {chosen ? "→ " : ""}
                      {q.plan}
                    </td>
                    <td className="py-1 pr-3">
                      {q.vcpus} {q.familyLabel}
                    </td>
                    <td className="py-1 pr-3">
                      {q.ramGb} GB{q.enoughRam ? "" : " (too small)"}
                    </td>
                    <td className="py-1 pr-3 text-right">{q.hourlyUsd.toFixed(4)}</td>
                    <td className="py-1 pr-3 text-right">
                      {duration(q.totalSeconds)}
                      {q.withinDeadline ? "" : " (over the limit)"}
                    </td>
                    <td className="py-1 pr-3 text-right">{q.jobUsd.toFixed(4)}</td>
                    <td className="py-1 text-right">{q.budgetHours} h</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {job.chosenReason && <div>{job.chosenReason}</div>}
        </div>
      )}

      {job.plan && (
        <div className="space-y-1">
          <div className="text-muted">Rented and paid</div>
          <div>
            <b>{job.plan}</b> in {REGIONS[job.region] ?? job.region} ·{" "}
            <span className="text-ok">{job.paidUsd !== null ? `${money(job.paidUsd)} USDC settled` : "paid over x402"}</span>
            {job.boxUrl && job.phase !== "done" && (
              <>
                {" · "}
                <a href={job.boxUrl} target="_blank" rel="noreferrer">
                  open the box {job.ip}
                </a>
              </>
            )}
          </div>
          <div className="flex flex-wrap gap-4">
            {job.solscan && (
              <a href={job.solscan} target="_blank" rel="noreferrer">
                the payment on Solscan
              </a>
            )}
            {job.arweaveUrl && (
              <a href={job.arweaveUrl} target="_blank" rel="noreferrer">
                the receipt on Arweave
              </a>
            )}
          </div>
        </div>
      )}

      {(job.phase === "booting" || job.phase === "training" || job.phase === "publishing" || job.phase === "done") && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-4">
            <span className="text-muted">Training</span>
            <span>
              predicted {duration(job.predictedSeconds)}
              {job.actualSeconds !== null ? ` · took ${duration(job.actualSeconds)}` : elapsed !== null ? ` · ${duration(Math.round(elapsed))} on the box so far` : ""}
            </span>
            {status?.vcpus ? <span className="text-muted">{status.vcpus} workers</span> : null}
          </div>
          <div className="h-2 w-full max-w-[520px] border border-foreground">
            <div className="h-full transition-all" style={{ width: `${Math.round(progress * 100)}%`, background: job.phase === "done" ? "var(--ok)" : "var(--warn)" }} />
          </div>
          <div className="space-y-0.5 text-muted">
            {(status?.log ?? []).slice(-6).map((l, i) => (
              <div key={i}>
                {l.at.toFixed(1)}s {l.text}
              </div>
            ))}
            {job.phase === "booting" && !status && <div>waiting for the box to answer, usually under two minutes</div>}
          </div>
        </div>
      )}

      {job.phase === "done" && model && (
        <div className="text-ok">The model is {kb(job.modelBytes)} and the server was shut down. It is on the right, running in your browser.</div>
      )}
    </div>
  );
}

function TryIt({ title, job, model }: { title: string; job: TrainingRunView; model: TrainedModel }) {
  const [input, setInput] = useState("");
  const [controls, setControls] = useState<Record<string, number>>(() =>
    Object.fromEntries((model.interface.output.controls ?? []).map((c) => [c.key, c.value])),
  );
  const [produced, setProduced] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [answer, setAnswer] = useState<{ answer: string; model: { name: string; company: string }; cited: { n: number; title: string; url: string }[] } | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const runner = runnerFor(model);
  const headline = headlineMetric(model);
  const live = model.interface.output.type === "labels" || model.interface.output.type === "passages";
  const result = useMemo(() => (live && runner && input.trim() ? runModel(model, input, controls) : null), [live, runner, model, input, controls]);

  const download = () => {
    const blob = new Blob([JSON.stringify(model)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${job.dataset.name.replace(/\W+/g, "-").toLowerCase()}-${model.kind}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <div className="space-y-4 border border-rule p-4">
      <div>
        <div className="font-bold">{title}</div>
        {headline && (
          <div>
            <div>
              {formatMetric(headline.value, headline.format)} <span className="text-muted">{headline.label}</span>
            </div>
            {headline.detail && <div className="text-muted">{headline.detail}</div>}
          </div>
        )}
        <div className="text-muted">
          {model.kind} · trained on {job.plan} for {money(job.paidUsd)} · {job.dataset.name} · {kb(job.modelBytes)}
        </div>
      </div>

      {runner ? (
        <div className="space-y-2">
          <div className="text-muted">{model.interface.input.label}</div>
          {model.interface.input.lines && model.interface.input.lines > 1 ? (
            <textarea
              className="w-full resize-none border border-rule px-2 py-1"
              rows={model.interface.input.lines}
              placeholder={model.interface.input.placeholder}
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          ) : (
            <input
              className="w-full border border-rule px-2 py-1"
              placeholder={model.interface.input.placeholder}
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          )}

          {(model.interface.output.controls ?? []).map((c) => (
            <label key={c.key} className="flex items-center gap-3 text-muted">
              {c.label}
              <input
                type="range"
                min={c.min ?? 0}
                max={c.max ?? 1000}
                step={c.step ?? 1}
                value={controls[c.key] ?? c.value}
                className="flex-1"
                onChange={(e) => setControls((s) => ({ ...s, [c.key]: Number(e.target.value) }))}
              />
              <span className="text-foreground">{controls[c.key] ?? c.value}</span>
            </label>
          ))}

          {!live && (
            <button
              className="border border-foreground px-3 py-1 hover:bg-foreground hover:text-background"
              onClick={() => {
                const out = runModel(model, input, controls);
                setProduced(out && out.type === "text" ? out.text : null);
              }}
            >
              Run it
            </button>
          )}

          {model.interface.output.type === "passages" && (
            <div className="space-y-2">
              <button
                className="border border-foreground px-3 py-1 hover:bg-foreground hover:text-background disabled:opacity-40"
                disabled={asking || !result || result.type !== "passages"}
                onClick={async () => {
                  if (!result || result.type !== "passages") return;
                  setAsking(true);
                  setAskError(null);
                  setAnswer(null);
                  try {
                    const res = await fetch("/api/demo/ask", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ question: input, passages: result.passages }),
                    });
                    const body = await res.json();
                    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
                    setAnswer(body);
                  } catch (e) {
                    setAskError((e as Error).message);
                  } finally {
                    setAsking(false);
                  }
                }}
              >
                {asking ? "Asking…" : "Answer it"}
              </button>
              {askError && <div className="text-bad">{askError}</div>}
              {answer && (
                <div className="border-l-2 pl-3" style={{ borderColor: "var(--paid)" }}>
                  <div className="whitespace-pre-wrap">{answer.answer}</div>
                  <div className="mt-2 text-muted">
                    written by {answer.model.name} from the passages below. The rented box trained the index that found them, not the model that wrote
                    this.
                  </div>
                </div>
              )}
            </div>
          )}

          {live && result && result.type === "passages" && (
            <div className="space-y-3">
              {result.passages.map((p, i) => (
                <div key={i} className="border-l-2 border-rule pl-3">
                  <div className="flex items-baseline gap-2">
                    <span className="text-muted">[{i + 1}]</span>
                    <a href={p.url} target="_blank" rel="noreferrer" className="font-bold">
                      {p.title || p.url}
                    </a>
                    <span className="text-muted">{(p.score * 100).toFixed(0)}% match</span>
                  </div>
                  <div className="text-muted break-words">{p.text}</div>
                </div>
              ))}
            </div>
          )}

          {live && model.interface.output.type === "passages" && !result && (
            <div className="text-muted">{input.trim() ? "nothing in the docs matches those words" : model.interface.output.label}</div>
          )}

          {live &&
            model.interface.output.type === "labels" &&
            (result && result.type === "labels" ? (
              <div className="space-y-1">
                <div>
                  <b>{result.label}</b>{" "}
                  <span className="text-muted">{(result.scores.find((s) => s.label === result.label)!.probability * 100).toFixed(1)}% sure</span>
                </div>
                {result.scores
                  .slice()
                  .sort((a, b) => b.probability - a.probability)
                  .slice(0, 8)
                  .map((s) => (
                    <div key={s.label} className="flex items-center gap-2">
                      <span className="w-28 shrink-0 truncate text-muted">{s.label}</span>
                      <span className="h-2 flex-1 border border-rule">
                        <span className="block h-full bg-foreground" style={{ width: `${Math.round(s.probability * 100)}%` }} />
                      </span>
                      <span className="w-12 shrink-0 text-right text-muted">{(s.probability * 100).toFixed(0)}%</span>
                    </div>
                  ))}
                {result.evidence && (
                  <div className="text-muted">
                    {result.evidence.label}: {result.evidence.items.join(", ")}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-muted">{input.trim() ? "nothing in that text is in the model's vocabulary" : model.interface.output.label}</div>
            ))}

          {!live && produced && <pre className="max-h-[320px] overflow-y-auto whitespace-pre-wrap border-l-2 border-rule pl-3">{produced}</pre>}
        </div>
      ) : (
        <div className="text-muted">
          This model was trained with a runtime this page cannot run ({model.runtime}). Its numbers are below, and you can download it and run it
          yourself.
        </div>
      )}

      <div className="border-t border-rule pt-3">
        <button className="text-muted underline underline-offset-2" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Hide the numbers" : "What the trainer reported"}
        </button>
        {expanded && (
          <div className="mt-2 space-y-3">
            <MetricList metrics={model.metrics} />
            {model.settings && model.settings.length > 0 && (
              <div>
                <div className="text-muted">settings it chose</div>
                <MetricList metrics={model.settings} />
              </div>
            )}
            {model.candidates && model.candidates.rows.length > 0 && (
              <div>
                <div className="text-muted">settings it compared</div>
                <table className="w-full border-collapse">
                  <thead className="text-muted">
                    <tr className="border-b border-rule text-left">
                      {model.candidates.columns.map((c) => (
                        <th key={c.key} className="py-1 pr-3 font-normal">
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {model.candidates.rows.map((row, i) => (
                      <tr key={i} className="border-b border-rule">
                        {model.candidates!.columns.map((c) => (
                          <td key={c.key} className="py-1 pr-3">
                            {formatMetric(row[c.key], c.format)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4 border-t border-rule pt-3">
        <button className="underline underline-offset-2" onClick={download}>
          Download the model
        </button>
        <span className="text-muted">plain JSON, no runtime needed</span>
      </div>
    </div>
  );
}

function ModelPicker({ models, disabled, onSave }: { models: Snapshot["models"]; disabled: boolean; onSave: (provider: string, key?: string) => Promise<void> }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const selected = models.providers.find((p) => p.id === models.selected)!;
  const open = editing === selected.id || !selected.key;

  const save = async () => {
    await onSave(selected.id, draft);
    setDraft("");
    setEditing(null);
  };

  return (
    <div className="space-y-2">
      <div className="text-muted">Your agent runs on</div>
      <div className="flex flex-wrap gap-2">
        {models.providers.map((p) => (
          <button
            key={p.id}
            className={`flex items-center gap-2 border px-2 py-1 ${p.id === models.selected ? "border-foreground font-bold" : "border-rule text-muted hover:border-foreground"} ${disabled ? "opacity-40" : ""}`}
            disabled={disabled || p.id === models.selected}
            onClick={() => {
              setDraft("");
              setEditing(null);
              void onSave(p.id);
            }}
          >
            <Image src={`/models/${p.id}.svg`} alt="" width={16} height={16} unoptimized />
            {p.name}
          </button>
        ))}
      </div>
      {open ? (
        <form
          className="flex max-w-[460px] gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) void save();
          }}
        >
          <input
            type="password"
            autoComplete="off"
            className="min-w-0 flex-1 border border-rule px-2 py-1"
            placeholder={`Paste your ${selected.name} API key`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button className="border border-foreground px-2 disabled:opacity-40" disabled={disabled || !draft.trim()}>
            Save
          </button>
          {selected.key && (
            <button type="button" className="text-muted underline underline-offset-2" onClick={() => setEditing(null)}>
              Cancel
            </button>
          )}
        </form>
      ) : (
        <div className="text-muted">
          {selected.modelName} · key <span className="text-foreground">{selected.key}</span>{" "}
          <button className="underline underline-offset-2 disabled:opacity-40" disabled={disabled} onClick={() => setEditing(selected.id)}>
            Change
          </button>
        </div>
      )}
    </div>
  );
}
