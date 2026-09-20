"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Nav } from "@/app/nav";
import type { Snapshot } from "@/lib/demo/snapshot";
import type { TrainingRunView } from "@/lib/demo/train";
import type { DatasetSource, Metric, TrainedModel } from "@/lib/train";
import { formatMetric, headlineMetric, run as runModel, runnerFor } from "@/lib/train/infer";

const REGIONS: Record<string, string> = { ewr: "New Jersey", ord: "Chicago", atl: "Atlanta", lax: "Los Angeles", sjc: "Silicon Valley" };

const PIPELINE = [
  { step: "your agent", detail: "ANS" },
  { step: "Vultr desk", detail: "A2A" },
  { step: "mandate", detail: "budget, rate, deadline" },
  { step: "x402", detail: "Solana" },
  { step: "Vultr box", detail: "trains, then dies" },
  { step: "Arweave", detail: "receipt" },
];

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

function size(dataset: DatasetSource): string {
  if (dataset.rows > 0) return `about ${dataset.rows.toLocaleString()} rows`;
  return `${Math.round(dataset.bytes / 1024).toLocaleString()} KB`;
}

function kb(bytes: number | null): string {
  return bytes === null ? "-" : bytes > 900000 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

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
          onClick={() => post("/api/demo/reset")}
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
              <h2 className="text-[15px] font-bold">What should it learn to do?</h2>
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
                  <div className="text-muted">faucet cap is $20</div>
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
                  <div className="text-muted">the broker refuses dearer servers</div>
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
                  <div className="text-muted">the mandate expires, the server dies</div>
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

      <div
        className={`fixed right-0 top-0 z-10 flex h-full w-full max-w-[620px] flex-col border-l border-rule bg-background shadow-xl transition-transform duration-200 ${drawer ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-center border-b border-rule p-3">
          <span className="font-bold">Log</span>
          <button
            className="ml-auto border border-rule-strong px-2.5 py-0.5 text-muted hover:border-foreground hover:text-foreground"
            aria-label="Close the log"
            onClick={() => setDrawer(false)}
          >
            ✕
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
    <div className="text-muted">
      {d.kind === "classifier" ? "sorts text" : d.kind === "retrieval" ? "answers from documents" : "writes more text"} · {d.note}
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

function toneOf(a: { ok: boolean; blocked: boolean | null }): string {
  if (a.blocked === null) return a.ok ? "var(--ok)" : "var(--bad)";
  return a.blocked ? "var(--bad)" : "var(--ok)";
}

function StressTest({ snap, post }: { snap: Snapshot | null; post: (path: string, body?: unknown) => Promise<void> }) {
  const stress = snap?.stress;
  const target = stress?.target;
  const attempts = stress?.attempts.length ?? 0;
  const tries = attempts > 0 ? `${attempts} ways` : "every way it can";
  const before = stress?.trustBefore?.behavior ?? null;
  const after = stress?.trustAfter?.behavior ?? null;
  return (
    <div className="space-y-3 border-t border-rule pt-8">
      <div className="flex flex-wrap items-baseline gap-x-4">
        <h2 className="text-[15px] font-bold">Limit testing:</h2>
        <button
          className="border border-charcoal bg-charcoal px-3.5 py-1.5 text-background hover:opacity-85 disabled:opacity-40"
          disabled={stress?.status === "running" || snap?.busy}
          onClick={() => post("/api/demo/stress")}
        >
          {stress?.status === "running" ? "Trying…" : stress?.status === "done" ? "Start test" : "Send a second agent to break them"}
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
          {stress.attempts.map((a, i) => (
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
                    background: after >= 70 ? "var(--ok)" : after >= 40 ? "var(--warn)" : "var(--bad)",
                  }}
                />
              </span>
              <span className="text-muted">
                {stress.trustAfter?.profile} · {before !== null && before !== after ? `${before} → ${after}` : after}
              </span>
              {(stress.trustAfter?.riskFactors ?? []).length > 0 && (
                <span className="text-muted">{stress.trustAfter!.riskFactors.join(", ")}</span>
              )}
            </div>
          )}
          {stress.verdictUrl && (
            <a href={stress.verdictUrl} target="_blank" rel="noreferrer">
              Verdict (Stored on Arweave)
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function BurnMeter({ spent, budget }: { spent: number | null; budget: number }) {
  const used = spent === null || budget <= 0 ? 0 : Math.min(1, spent / budget);
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-block h-1.5 w-24 shrink-0 border border-rule-strong align-middle">
        <span
          className="block h-full transition-all"
          style={{ width: `${Math.max(used > 0 ? 3 : 0, Math.round(used * 100))}%`, background: `linear-gradient(90deg, var(--mark), var(--burn))` }}
        />
      </span>
      <span className="text-muted">
        {money(spent ?? 0)} of {money(budget)} spent
      </span>
    </span>
  );
}

function Fold({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button className="text-muted hover:text-foreground" onClick={onToggle} style={{ background: "none", border: "none", padding: 0 }}>
      {label} {open ? "\u25b4" : "\u25be"}
    </button>
  );
}

function collapseLog(log: { at: number; text: string }[]): { at: number; text: string }[] {
  const out: { at: number; text: string }[] = [];
  for (const line of log) {
    const step = /^(.*?)\s(\d+)\s+of\s+(\d+)$/.exec(line.text);
    const last = out[out.length - 1];
    if (step && last) {
      const prior = /^(.*?)\s(\d+)\s+of\s+(\d+)$/.exec(last.text);
      if (prior && prior[1] === step[1]) {
        out[out.length - 1] = { at: line.at, text: `${step[1]} ${step[2]}/${step[3]}` };
        continue;
      }
    }
    out.push(step ? { at: line.at, text: `${step[1]} ${step[2]}/${step[3]}` } : line);
  }
  return out;
}

function Timeline({
  job,
  model,
  snap,
  post,
}: {
  job: TrainingRunView;
  model: TrainedModel | null;
  snap: Snapshot | null;
  post: (path: string, body?: unknown) => Promise<void>;
}) {
  const status = job.status;
  const progress = status?.progress ?? 0;
  const elapsed = status?.elapsed ?? null;
  const settled = job.phase === "done" || job.phase === "failed";
  const [openTalk, setOpenTalk] = useState(false);
  const [openPlans, setOpenPlans] = useState(false);
  const live = job.handle !== null && !settled;
  const lastDesk = [...job.messages].reverse().find((m) => m.fromLabel === "vultr") ?? null;
  const talk = settled ? openTalk : true;
  const plans = settled ? openPlans : job.plan === null;
  const near = job.quotes
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => q.plan !== job.chosen?.plan)
    .slice(0, 2)
    .map(({ q }) => q);
  const shownQuotes = plans ? job.quotes : job.quotes.filter((q) => q.plan === job.chosen?.plan || near.includes(q));
  return (
    <div className="space-y-9 border-t border-rule pt-8">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <h2 className="text-[15px] font-bold">{PHASE_TEXT[job.phase]}</h2>
        <span className="text-muted">
          {job.agent.ansName} · running on {job.model.name} · mandate {job.mandateJti} · {money(job.rateUsdHr)}/hour cap, expires in {job.deadlineMinutes} min
        </span>
        <span className="ml-auto">
          <BurnMeter spent={job.paidUsd} budget={job.budgetUsd} />
        </span>
      </div>
      {job.error && <div className="text-bad">{job.error}</div>}
      <div className="text-muted">
        what you asked for: <span className="text-foreground">{job.request}</span>
      </div>

      {job.messages.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-4">
            <span className="text-muted">Agents have signed both ways, ANS keys verified.</span>
            {settled && (
              <span className="ml-auto">
                <Fold label={`read the full exchange (${job.messages.length} messages)`} open={openTalk} onToggle={() => setOpenTalk(!openTalk)} />
              </span>
            )}
          </div>
          {!talk && lastDesk && (
            <div className="border-l-2 pl-3" style={{ borderColor: "var(--warn)" }}>
              <div className="text-muted">
                <span style={{ color: "var(--warn)" }}>Vultr desk</span> · {lastDesk.kind.replace(/_/g, " ")} · sig {lastDesk.signed}…{" "}
                <span className="text-ok">verified</span>
              </div>
              <div className="whitespace-pre-wrap">{lastDesk.text}</div>
            </div>
          )}
          {talk &&
            job.messages.map((m) => (
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
          {job.conversation?.url && (
            <div className="text-muted">
              <a href={job.conversation.url} target="_blank" rel="noreferrer">
                this exchange on Arweave
              </a>
              {job.conversation.withheld > 0 && ` · ${job.conversation.withheld} of ${job.conversation.messages} stored as hash`}
            </div>
          )}
        </div>
      )}

      {job.quotes.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-4">
            <span className="text-muted">Recommended plans with budget of {money(job.budgetUsd)}:</span>
            {job.quotes.length > shownQuotes.length || plans ? (
              <span className="ml-auto">
                <Fold
                  label={plans ? `${job.quotes.length} plans the desk quoted` : `all ${job.quotes.length} plans the desk quoted`}
                  open={plans}
                  onToggle={() => setOpenPlans(!openPlans)}
                />
              </span>
            ) : null}
          </div>
          <table className="w-full border-collapse">
            <thead className="text-muted">
              <tr className="border-b border-rule-strong text-left">
                <th className="py-2 pr-4 font-normal">plan</th>
                <th className="py-2 pr-4 font-normal">cores</th>
                <th className="py-2 pr-4 font-normal">RAM</th>
                <th className="py-2 pr-4 text-right font-normal">$/hour</th>
                <th className="py-2 pr-4 text-right font-normal">model ready in</th>
                <th className="py-2 pr-4 text-right font-normal">cost of this run</th>
                <th className="py-2 text-right font-normal">hours your budget covers</th>
              </tr>
            </thead>
            <tbody>
              {shownQuotes.map((q) => {
                const chosen = q.plan === job.chosen?.plan;
                return (
                  <tr key={q.plan} className={`border-b border-rule ${chosen ? "font-bold" : q.enoughRam && q.withinDeadline ? "" : "text-muted"}`}>
                    <td className="py-1.5 pr-4">
                      {chosen ? <span style={{ color: "var(--mark)" }}>→ </span> : ""}
                      {q.plan}
                    </td>
                    <td className="py-1.5 pr-4">
                      {q.vcpus} {q.familyLabel}
                    </td>
                    <td className="py-1.5 pr-4">
                      {q.ramGb} GB{q.enoughRam ? "" : " (too small)"}
                    </td>
                    <td className="py-1.5 pr-4 text-right">{q.hourlyUsd.toFixed(4)}</td>
                    <td className="py-1.5 pr-4 text-right">
                      {duration(q.totalSeconds)}
                      {q.withinDeadline ? "" : " (over the limit)"}
                    </td>
                    <td className="py-1.5 pr-4 text-right">{q.jobUsd.toFixed(4)}</td>
                    <td className="py-1.5 text-right">{q.budgetHours} h</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {job.chosenReason && <div>{job.chosenReason}</div>}
        </div>
      )}

      {job.plan && (
        <div className="space-y-1 border-l-2 pl-3" style={{ borderColor: live ? "var(--mark)" : "var(--rule)" }}>
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
              {job.actualSeconds !== null
                ? ` · took ${duration(job.actualSeconds)}`
                : elapsed !== null
                  ? ` · ${duration(Math.round(elapsed))} on the box so far`
                  : ""}
            </span>
            {status?.vcpus ? <span className="text-muted">{status.vcpus} workers</span> : null}
          </div>
          <div className="h-2 w-full max-w-[520px] border border-foreground">
            <div
              className="h-full transition-all"
              style={{
                width: `${Math.round(progress * 100)}%`,
                background: job.phase === "done" ? "var(--ok)" : "linear-gradient(90deg, var(--mark), var(--burn))",
              }}
            />
          </div>
          <div className="space-y-0.5 text-muted">
            {collapseLog(status?.log ?? [])
              .slice(-4)
              .map((l, i) => (
                <div key={i}>
                  {l.at.toFixed(1)}s {l.text}
                </div>
              ))}
            {job.phase === "booting" && !status && <div>waiting for the box to answer, usually under two minutes</div>}
          </div>
        </div>
      )}

      {job.phase === "done" && <StressTest snap={snap} post={post} />}

      {job.phase === "done" && model && (
        <div className="text-ok">The model is {kb(job.modelBytes)} and the server was shut down. It is on the right, running in your browser.</div>
      )}
    </div>
  );
}

function TryIt({ title, job, model, models }: { title: string; job: TrainingRunView; model: TrainedModel; models: Snapshot["models"] | undefined }) {
  const [input, setInput] = useState("");
  const [controls, setControls] = useState<Record<string, number>>(() =>
    Object.fromEntries((model.interface.output.controls ?? []).map((c) => [c.key, c.value])),
  );
  const [produced, setProduced] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [answer, setAnswer] = useState<{
    answer: string;
    model: { name: string; company: string };
    cited: { n: number; title: string; url: string }[];
  } | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [answerWith, setAnswerWith] = useState<string>("");
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
    <div className="space-y-5 rounded-lg border border-rule p-5">
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
          trained on {job.dataset.name} · {job.plan} · {money(job.paidUsd)} · {kb(job.modelBytes)}
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
              className="border border-charcoal bg-charcoal px-3.5 py-1.5 text-background hover:opacity-85"
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
              <div className="flex flex-wrap items-center gap-2">
                <button
                  className="border border-charcoal bg-charcoal px-3 py-1 text-background hover:opacity-85 disabled:cursor-not-allowed disabled:border-rule-strong disabled:bg-surface disabled:text-muted"
                  disabled={asking || !input.trim() || !result || result.type !== "passages" || !runner}
                  onClick={async () => {
                    if (!result || result.type !== "passages") return;
                    setAsking(true);
                    setAskError(null);
                    setAnswer(null);
                    try {
                      const res = await fetch("/api/demo/ask", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ question: input, passages: result.passages, provider: answerWith || undefined }),
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
                  {asking ? "Asking…" : "Submit"}
                </button>
                <span className="text-muted">
                  answered by{" "}
                  <select
                    className="border border-rule px-1.5 py-0.5"
                    value={answerWith || (models?.selected ?? "")}
                    onChange={(e) => setAnswerWith(e.target.value)}
                  >
                    {(models?.providers ?? [])
                      .filter((p) => p.key)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.modelName}
                        </option>
                      ))}
                  </select>
                </span>
              </div>
              {askError && <div className="text-bad">{askError}</div>}
              {answer && (
                <div className="border-l-2 pl-3" style={{ borderColor: "var(--paid)" }}>
                  <div className="whitespace-pre-wrap">{answer.answer}</div>
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
                  <div className="break-words text-muted">{p.text}</div>
                </div>
              ))}
            </div>
          )}

          {live && model.interface.output.type === "passages" && !result && (
            <div className="text-muted">
              {input.trim() ? "none of those words appear in your file, so it found no passage to answer from" : model.interface.output.label}
            </div>
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
              <div className="text-muted">
                {input.trim() ? "none of those words appear in your data, so it has nothing to go on" : model.interface.output.label}
              </div>
            ))}

          {!live && produced && <pre className="max-h-[320px] overflow-y-auto whitespace-pre-wrap border-l-2 border-rule pl-3">{produced}</pre>}
        </div>
      ) : (
        <div className="text-muted">
          This model needs a runtime this page does not have ({model.runtime}), so it cannot run here. Its scores are below and you can download it and
          run it yourself.
        </div>
      )}

      <div className="border-t border-rule pt-3">
        <button className="text-muted underline underline-offset-2" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Hide the details" : "How it scored and what it chose"}
        </button>
        {expanded && (
          <div className="mt-2 space-y-3">
            <MetricList metrics={model.metrics} />
            {model.settings && model.settings.length > 0 && (
              <div>
                <div className="text-muted">the settings it landed on</div>
                <MetricList metrics={model.settings} />
              </div>
            )}
            {model.candidates && model.candidates.rows.length > 0 && (
              <div>
                <div className="text-muted">every setting it tried, and how each scored</div>
                <table className="w-full border-collapse">
                  <thead className="text-muted">
                    <tr className="border-b border-rule-strong text-left">
                      {model.candidates.columns.map((c) => (
                        <th key={c.key} className="py-2 pr-4 font-normal">
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {model.candidates.rows.map((row, i) => (
                      <tr key={i} className="border-b border-rule">
                        {model.candidates!.columns.map((c) => (
                          <td key={c.key} className="py-1.5 pr-4">
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
      </div>
    </div>
  );
}

function ModelPicker({
  models,
  disabled,
  onSave,
}: {
  models: Snapshot["models"];
  disabled: boolean;
  onSave: (provider: string, key?: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const selected = models.providers.find((p) => p.id === models.selected)!;
  const missingKey = !selected.key;

  const save = async () => {
    await onSave(selected.id, draft);
    setDraft("");
  };

  return (
    <span className="relative">
      <button
        className={`flex items-center gap-2 border px-3 py-1 ${missingKey ? "border-bad text-bad" : "border-charcoal bg-charcoal text-background hover:opacity-85"}`}
        onClick={() => setOpen(!open)}
      >
        <Image src={`/models/${selected.id}.svg`} alt="" width={14} height={14} unoptimized />
        {selected.modelName}
        {missingKey ? " · needs a key" : ""}
      </button>

      {open && (
        <span className="absolute right-0 top-9 z-20 block w-[380px] space-y-3 rounded-lg border border-rule bg-background p-4 shadow-lg">
          <span className="block">
            <span className="block font-bold">Agent model</span>
            <span className="block text-muted">
              This model will read your request and communicate with the Vultr agent to decide what to rent and pay it.
            </span>
          </span>
          <span className="flex flex-wrap gap-2">
            {models.providers.map((p) => (
              <button
                key={p.id}
                className={`flex items-center gap-2 border px-3 py-1.5 ${p.id === models.selected ? "border-charcoal" : "border-rule-strong text-muted hover:border-charcoal hover:text-foreground"} ${disabled ? "opacity-40" : ""}`}
                disabled={disabled || p.id === models.selected}
                onClick={() => {
                  setDraft("");
                  void onSave(p.id);
                }}
              >
                <Image src={`/models/${p.id}.svg`} alt="" width={16} height={16} unoptimized />
                {p.name}
                {p.key && <span className="text-ok">✓</span>}
              </button>
            ))}
          </span>
          <span className="block">
            {selected.key ? (
              <>
                <span className="text-ok">key loaded</span>{" "}
                <span className="text-muted">
                  {selected.key} · {selected.company} {selected.modelName}
                </span>
              </>
            ) : (
              <span className="text-bad">no {selected.name} key yet, paste one below</span>
            )}
          </span>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim()) void save();
            }}
          >
            <input
              type="password"
              autoComplete="off"
              className="min-w-0 flex-1 border border-rule px-2 py-1"
              placeholder={selected.key ? "paste a different key to replace it" : `paste your ${selected.name} API key`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button className="border border-charcoal bg-charcoal px-3 text-background disabled:opacity-40" disabled={disabled || !draft.trim()}>
              Save
            </button>
          </form>
          <button className="text-muted underline underline-offset-2" onClick={() => setOpen(false)}>
            close
          </button>
        </span>
      )}
    </span>
  );
}
