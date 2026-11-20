"use client";

import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "@/lib/demo/snapshot";
import type { DatasetSource } from "@/lib/train";
import { DatasetCard, type Detected } from "./DatasetCard";
import { HELP } from "./copy";
import { size } from "./format";
import { Help } from "./Help";
import { Segmented } from "./Segmented";
import { BTN, INPUT, MONO, TEXT_BTN, TEXTAREA } from "./ui";

export type JobDraft = { budgetUsd: number; rateUsdHr: number };

type JobBody = {
  request: string;
  dataset: DatasetSource;
  budgetUsd: number;
  rateUsdHr: number;
  deadlineMinutes: number;
  preference: number;
};

const START =
  "inline-flex h-10 shrink-0 items-center rounded-[3px] border border-foreground bg-foreground px-5 text-[13.5px] leading-5 font-semibold text-surface enabled:hover:bg-[#2B3644] disabled:cursor-not-allowed disabled:border-segment disabled:bg-segment disabled:text-muted";

/**
 * A form label whose text is the help trigger (dotted underline). Inputs keep a real <label> for
 * their accessible name; it is visually hidden because a button cannot sit inside a label.
 */
function Label({ children, help, id, htmlFor }: { children: string; help: keyof typeof HELP; id: string; htmlFor?: string }) {
  return (
    <span className="block font-medium text-foreground">
      {htmlFor && (
        <label htmlFor={htmlFor} className="sr-only">
          {children}
        </label>
      )}
      <Help id={`help-${id}`} text={HELP[help]}>
        {children}
      </Help>
    </span>
  );
}

/** Number fields with the unit inside: no spinner arrows to collide with the suffix (arrow keys still step). */
const NUMBER = "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

const PLAN_OPTIONS = [
  { value: 0, label: "Cheapest" },
  { value: 0.5, label: "Balanced" },
  { value: 1, label: "Fastest" },
] as const;

export function JobForm(props: {
  snap: Snapshot | null;
  running: boolean;
  collapsed: boolean;
  onDraftChange: (draft: JobDraft) => void;
  onStart: (body: JobBody) => Promise<void>;
  reload: () => Promise<void>;
  post: (path: string, body?: unknown) => Promise<void>;
  resetSignal: number;
}) {
  const { resetSignal, snap, running, collapsed, onDraftChange, onStart, reload, post } = props;
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
  // "Use a different agent" is rarely needed, so its form stays closed until asked for.
  const [otherAgent, setOtherAgent] = useState(false);
  const [budget, setBudget] = useState(5);
  const [rate, setRate] = useState(1.25);
  const [deadline, setDeadline] = useState(30);
  const [preference, setPreference] = useState(0.5);
  const fileRef = useRef<HTMLInputElement>(null);

  // Page Reset: clear only what the old inline form cleared; budget, rate, deadline and preference stay.
  const gen = useRef(0);
  const lastReset = useRef(resetSignal);
  useEffect(() => {
    if (lastReset.current === resetSignal) return;
    lastReset.current = resetSignal;
    gen.current += 1; // an upload still in flight must not re-add its file
    setSources([]);
    setDetected(null);
    setDatasetError(null);
    setUrl("");
    setRequest("");
    setAgentName("");
    setRegisterError(null);
    setOtherAgent(false);
  }, [resetSignal]);

  useEffect(() => {
    onDraftChange({ budgetUsd: budget, rateUsdHr: rate });
  }, [budget, rate, onDraftChange]);

  const hasKey = snap?.models.providers.find((p) => p.id === snap.models.selected)?.key;

  const combineSources = async (list: DatasetSource[]) => {
    if (list.length === 0) {
      setDetected(null);
      return;
    }
    const mine = gen.current;
    const res = await fetch("/api/demo/dataset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sources: list }),
    });
    const body = await res.json();
    // A Reset while this was in flight must not bring the old dataset card back.
    if (gen.current !== mine) return;
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    setDetected(body as Detected);
  };

  const addSources = async (init: RequestInit) => {
    setDatasetError(null);
    setReading(true);
    const mine = gen.current;
    try {
      const res = await fetch("/api/demo/dataset", init);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      if (gen.current !== mine) return;
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
    const j = snap?.job ?? null;
    // Up to 4 decimals, trailing zeros trimmed, never fewer than 2.
    const usd = (n: number) => {
      const t = String(parseFloat(n.toFixed(4)));
      const dec = t.includes(".") ? t.split(".")[1].length : 0;
      return `$${dec >= 2 ? t : n.toFixed(2)}`;
    };
    const b = j ? j.budgetUsd : budget;
    const r = j ? j.rateUsdHr : rate;
    const ans = j?.agent.ansName ?? snap?.company?.ansName ?? undefined;
    const rows: [string, string, string?][] = [
      ["Agent", j?.agent.name ?? snap?.company?.name ?? (agentName.trim() || "Not registered"), ans],
      ["Data", j ? j.dataset.name : sources.length > 0 ? sources.map((x) => x.name).join(", ") : "None"],
      ["Task", (j ? j.request : request).trim() || "None"],
      ["Budget", `${usd(b)}, limit ${usd(r)} an hour`],
    ];
    return (
      <dl className="space-y-1.5">
        {rows.map(([k, v, title]) => (
          <div key={k} className="flex gap-3">
            <dt className="w-16 shrink-0 text-muted">{k}</dt>
            <dd className="min-w-0 break-words tabular-nums" title={title}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  const blocked = running || !hasKey || !detected || !snap?.company;
  const reason = !hasKey
    ? "Add a model key first, top right."
    : !snap?.company
      ? "Name and register your agent first."
      : !detected
        ? "Add the data it should learn from."
        : null;

  return (
    <div className="@container space-y-6">
      <div className="space-y-1.5">
        <Label help="agent" id="agent">
          Your agent
        </Label>
        {snap?.company && (
          <div>
            <div className="text-[16px] leading-[22px] font-semibold text-foreground">{snap.company.name}</div>
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className={`break-all text-muted ${MONO}`}>{snap.company.ansName}</span>
              <span className="text-[12px] leading-4 font-medium text-ok">Registered</span>
            </div>
            <div className="mt-0.5 text-[12px] leading-4 text-muted">Its key is sealed in the transparency log.</div>
            {!otherAgent && (
              <button
                type="button"
                className={`mt-1.5 text-[12px] leading-4 ${TEXT_BTN}`}
                aria-expanded={false}
                aria-controls="agent-name-form"
                disabled={running}
                onClick={() => setOtherAgent(true)}
              >
                Use a different agent
              </button>
            )}
          </div>
        )}
        {snap?.company && otherAgent && (
          <label htmlFor="agent-name" className="block pt-1.5 text-[12px] leading-4 text-muted">
            Register a different agent
          </label>
        )}
        {(!snap?.company || otherAgent) && (
          <form
            id="agent-name-form"
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void registerAgent();
            }}
          >
            <input
              id="agent-name"
              aria-label={snap?.company ? undefined : "Agent name"}
              className={`${INPUT} flex-1 basis-40`}
              placeholder="agent-name"
              value={agentName}
              disabled={running || registering}
              onChange={(e) => setAgentName(e.target.value)}
            />
            <button className={BTN} disabled={running || registering || !agentName.trim()}>
              {registering ? "Registering…" : "Register agent"}
            </button>
          </form>
        )}
        {registerError && <div className="text-bad">{registerError}</div>}
      </div>

      <div className="space-y-1.5">
        <Label help="data" id="data">
          Training data
        </Label>
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
        <div
          className={`flex h-16 items-center rounded-[3px] border border-dashed px-4 text-muted transition-colors ${dragging ? "border-foreground bg-surface" : "border-rule-strong"}`}
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
          {dragging ? (
            <span className="text-foreground">Drop them here</span>
          ) : (
            <span>
              {sources.length > 0 ? "Drop more files here or " : "Drop files here or "}
              <button type="button" className={TEXT_BTN} disabled={running || reading} onClick={() => fileRef.current?.click()}>
                choose files
              </button>
            </span>
          )}
        </div>
        <div className="flex gap-2 pt-0.5">
          <input
            aria-label="Data URL"
            className={`${INPUT} flex-1`}
            placeholder="Or paste a URL"
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
          <div className="space-y-1 pt-1">
            {sources.map((src, i) => (
              <div key={`${src.uploadId ?? src.url}-${i}`} className="flex items-baseline gap-3">
                <span className="truncate">{src.name}</span>
                <span className="shrink-0 text-[12px] text-muted">{size(src)}</span>
                <button className={`ml-auto shrink-0 text-[12px] ${TEXT_BTN}`} disabled={running} onClick={() => void dropSource(i)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        {reading && <div className="text-muted">Reading it…</div>}
        {datasetError && <div className="text-bad">{datasetError}</div>}
        {detected && <DatasetCard detected={detected} />}
      </div>

      <div className="space-y-1.5">
        <Label help="task" id="task" htmlFor="task-input">
          What should the custom model learn to do?
        </Label>
        <textarea
          id="task-input"
          className={`${TEXTAREA} block w-full resize-none`}
          rows={4}
          placeholder="Sort product reviews into positive, negative and mixed"
          value={request}
          disabled={running}
          onChange={(e) => setRequest(e.target.value)}
        />
      </div>

      {/* On a wide form the plan picker joins the budget row, which keeps Start run above the fold. */}
      <div className="grid grid-cols-1 gap-x-6 gap-y-6 @min-[36rem]:grid-cols-[minmax(0,1fr)_auto]">
        {/* Units sit inside the fields; three equal columns, two (time limit on the second row) at 20rem and below. */}
        <div className="grid grid-cols-2 gap-4 @min-[20.0625rem]:grid-cols-3">
          <div className="min-w-0 space-y-1.5">
            <Label help="budget" id="form-budget" htmlFor="budget-input">
              Total budget
            </Label>
            <div className="relative">
              <span aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">
                $
              </span>
              <input
                id="budget-input"
                type="number"
                min={0.05}
                max={20}
                step={0.25}
                value={budget}
                disabled={running}
                className={`${INPUT} ${NUMBER} w-full pl-[25px] tabular-nums`}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setBudget(next);
                  if (rate > next) setRate(next);
                }}
              />
            </div>
          </div>
          <div className="min-w-0 space-y-1.5">
            <Label help="rate" id="rate" htmlFor="rate-input">
              Hourly limit
            </Label>
            <div className="relative">
              <span aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">
                $
              </span>
              <input
                id="rate-input"
                type="number"
                min={0.003}
                max={budget}
                step={0.005}
                value={rate}
                disabled={running}
                aria-describedby="rate-unit"
                className={`${INPUT} ${NUMBER} w-full pr-9 pl-[25px] tabular-nums`}
                onChange={(e) => setRate(Number(e.target.value))}
              />
              <span id="rate-unit" className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted">
                <span aria-hidden>/h</span>
                <span className="sr-only">an hour</span>
              </span>
            </div>
          </div>
          <div className="min-w-0 space-y-1.5">
            <Label help="deadline" id="deadline" htmlFor="deadline-input">
              Time limit
            </Label>
            <div className="relative">
              <input
                id="deadline-input"
                type="number"
                min={3}
                max={120}
                step={1}
                value={deadline}
                disabled={running}
                aria-describedby="deadline-unit"
                className={`${INPUT} ${NUMBER} w-full pr-11 tabular-nums`}
                onChange={(e) => setDeadline(Number(e.target.value))}
              />
              <span id="deadline-unit" className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted">
                <span aria-hidden>min</span>
                <span className="sr-only">minutes</span>
              </span>
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label help="preference" id="preference">
            Pick a plan that is
          </Label>
          <Segmented label="Plan preference" options={PLAN_OPTIONS} value={preference} onChange={setPreference} disabled={running} />
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <button
            className={START}
            disabled={blocked}
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
          <span className="flex items-center gap-2">
            <input
              id="publish-input"
              type="checkbox"
              aria-label="Publish my side of the negotiation"
              checked={snap?.disclosure === "full"}
              disabled={running}
              onChange={(e) => post("/api/demo/network", { disclosure: e.target.checked ? "full" : "desk-only" })}
            />
            <Help id="help-publish" text={HELP.publish} className="text-muted">
              Publish my side of the negotiation
            </Help>
          </span>
        </div>
        {reason && <p className="text-[12px] leading-4 text-foreground">{reason}</p>}
      </div>
    </div>
  );
}
