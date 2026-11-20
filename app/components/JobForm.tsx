"use client";

import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "@/lib/demo/snapshot";
import type { DatasetSource } from "@/lib/train";
import { DatasetCard, type Detected } from "./DatasetCard";
import { HELP } from "./copy";
import { size } from "./format";
import { Help } from "./Help";

export type JobDraft = { budgetUsd: number; rateUsdHr: number };

type JobBody = {
  request: string;
  dataset: DatasetSource;
  budgetUsd: number;
  rateUsdHr: number;
  deadlineMinutes: number;
  preference: number;
};

const INPUT = "min-w-0 rounded-[3px] border border-rule bg-surface px-2.5 py-1 disabled:opacity-60";
const BTN = "rounded-[3px] border border-rule-strong px-3 py-1 hover:border-foreground disabled:opacity-40";
const BTN_PRIMARY = "rounded-[3px] border border-foreground bg-foreground px-3 py-1 text-surface hover:opacity-85 disabled:opacity-30";

function Label({ children, help, id }: { children: React.ReactNode; help: keyof typeof HELP; id: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className="font-medium text-foreground">{children}</span>
      <Help id={`help-${id}`} label={`About ${String(children).toLowerCase()}`} text={HELP[help]} />
    </span>
  );
}

export function JobForm(props: {
  snap: Snapshot | null;
  running: boolean;
  collapsed: boolean;
  onDraftChange: (draft: JobDraft) => void;
  onStart: (body: JobBody) => Promise<void>;
  reload: () => Promise<void>;
  post: (path: string, body?: unknown) => Promise<void>;
}) {
  const { snap, running, collapsed, onDraftChange, onStart, reload, post } = props;
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
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    onDraftChange({ budgetUsd: budget, rateUsdHr: rate });
  }, [budget, rate, onDraftChange]);

  const hasKey = snap?.models.providers.find((p) => p.id === snap.models.selected)?.key;

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
      await reload();
    } catch (e) {
      setRegisterError((e as Error).message);
    } finally {
      setRegistering(false);
    }
  };

  if (collapsed) {
    const rows: [string, string][] = [
      ["Agent", snap?.company?.ansName ?? (agentName.trim() || "not registered")],
      ["Data", sources.length > 0 ? sources.map((s) => s.name).join(", ") : "none"],
      ["Task", request.trim() || "none"],
      ["Budget", `$${budget.toFixed(2)}, limit $${rate.toFixed(2)} an hour`],
    ];
    return (
      <dl className="space-y-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-3">
            <dt className="w-16 shrink-0 text-muted">{k}</dt>
            <dd className="min-w-0 break-words tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    );
  }

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Label help="agent" id="agent">
          Your agent
        </Label>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void registerAgent();
          }}
        >
          <input
            aria-label="Agent name"
            className={`${INPUT} flex-1`}
            placeholder="agent-name"
            value={agentName}
            disabled={running || registering}
            onChange={(e) => setAgentName(e.target.value)}
          />
          <button className={BTN} disabled={running || registering || !agentName.trim()}>
            {registering ? "Registering…" : "Register agent"}
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
        <Label help="data" id="data">
          Training data
        </Label>
        <div
          className={`flex flex-wrap items-center gap-3 rounded-[3px] border border-dashed p-4 transition-colors ${dragging ? "border-foreground bg-surface" : "border-rule-strong"}`}
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
          <button className={BTN_PRIMARY} disabled={running || reading} onClick={() => fileRef.current?.click()}>
            {sources.length > 0 ? "Add more files" : "Choose files"}
          </button>
          <span className="text-muted">{dragging ? "drop them here" : "or drop them here, or"}</span>
          <input
            aria-label="Data URL"
            className={`${INPUT} flex-1`}
            placeholder="paste a URL"
            value={url}
            disabled={running}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") readUrl();
            }}
          />
          <button className={BTN} disabled={running || reading || !url.trim()} onClick={readUrl}>
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
        <Label help="task" id="task">
          What should the custom model learn to do?
        </Label>
        <textarea
          aria-label="Task"
          className={`${INPUT} w-full resize-none py-2.5 leading-relaxed`}
          rows={3}
          placeholder="Take our company documentation and datasets and spin up a custom chatbot that attributes our documentation and data for relevant responses, and refuses questions that are not about our company."
          value={request}
          disabled={running}
          onChange={(e) => setRequest(e.target.value)}
        />
      </div>

      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1">
            <Label help="budget" id="form-budget">
              Total budget
            </Label>
            <div className="flex items-baseline gap-1.5">
              <span className="shrink-0 text-muted">$</span>
              <input
                aria-label="Total budget in dollars"
                type="number"
                min={0.05}
                max={20}
                step={0.25}
                value={budget}
                disabled={running}
                className={`${INPUT} flex-1 tabular-nums`}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setBudget(next);
                  if (rate > next) setRate(next);
                }}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label help="rate" id="rate">
              Hourly limit
            </Label>
            <div className="flex items-baseline gap-1.5">
              <span className="shrink-0 text-muted">$</span>
              <input
                aria-label="Hourly limit in dollars"
                type="number"
                min={0.003}
                max={budget}
                step={0.005}
                value={rate}
                disabled={running}
                className={`${INPUT} flex-1 tabular-nums`}
                onChange={(e) => setRate(Number(e.target.value))}
              />
              <span className="shrink-0 text-muted">an hour</span>
            </div>
          </div>
          <div className="space-y-1">
            <Label help="deadline" id="deadline">
              Time limit
            </Label>
            <div className="flex items-baseline gap-1.5">
              <input
                aria-label="Time limit in minutes"
                type="number"
                min={3}
                max={120}
                step={1}
                value={deadline}
                disabled={running}
                className={`${INPUT} flex-1 tabular-nums`}
                onChange={(e) => setDeadline(Number(e.target.value))}
              />
              <span className="shrink-0 text-muted">minutes</span>
            </div>
          </div>
        </div>

        <div className="space-y-1">
          <Label help="preference" id="preference">
            Pick a plan that is
          </Label>
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
                aria-pressed={preference === value}
                className={`rounded-[3px] border px-4 py-1.5 ${preference === value ? "border-foreground bg-foreground text-surface" : "border-rule-strong text-muted hover:border-foreground hover:text-foreground"} disabled:opacity-40`}
                disabled={running}
                onClick={() => setPreference(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <button
          className="rounded-[3px] border border-foreground bg-foreground px-6 py-2.5 font-semibold text-surface hover:opacity-85 disabled:opacity-30"
          disabled={running || !hasKey || !detected || !snap?.company}
          onClick={() =>
            void onStart({
              request,
              dataset: detected!.dataset,
              budgetUsd: budget,
              rateUsdHr: rate,
              deadlineMinutes: deadline,
              preference,
            })
          }
        >
          Start run
        </button>
        <span className="flex items-center gap-2 text-muted">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={snap?.disclosure === "full"}
              disabled={running}
              onChange={(e) => post("/api/demo/network", { disclosure: e.target.checked ? "full" : "desk-only" })}
            />
            Publish my side of the negotiation
          </label>
          <Help id="help-publish" label="About publishing" text={HELP.publish} />
        </span>
        {!hasKey && <span className="text-muted">pick a model and add its key, top right</span>}
        {hasKey && !snap?.company && <span className="text-muted">name and register your agent first</span>}
        {hasKey && snap?.company && !detected && <span className="text-muted">add the data it should learn from</span>}
      </div>
    </div>
  );
}
