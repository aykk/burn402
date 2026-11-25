"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Snapshot } from "@/lib/demo/snapshot";
import type { MarketRunView } from "@/lib/market/run";
import type { MarketId, Need } from "@/lib/market/types";
import { ActionError, failureMessage } from "./ActionError";
import { RENT_HELP } from "./copy";
import { usd2 } from "./format";
import { Help } from "./Help";
import { MARKET_NAME, hoursText, sentence } from "./market-copy";
import { Segmented } from "./Segmented";
import { BTN, INPUT, TEXT_BTN, TEXTAREA } from "./ui";

export type NeedDraft = { budgetUsd: number; rateUsdHr: number };

export type RunBody = {
  market: MarketId;
  need: Need;
  budgetUsd: number;
  rateUsdHr: number;
  askBeforePaying: boolean;
};

const START =
  "inline-flex h-10 shrink-0 items-center rounded-[3px] border border-foreground bg-foreground px-5 text-[13.5px] leading-5 font-semibold text-surface enabled:hover:bg-[#2B3644] disabled:cursor-not-allowed disabled:border-segment disabled:bg-segment disabled:text-muted";

/** Number fields with the unit inside: no spinner arrows to collide with the suffix (arrow keys still step). */
const NUMBER = "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

const REGION_RE = /^[a-z0-9:-]{2,20}$/;

const MARKET_OPTIONS = [
  { value: "test" as const, label: "Test (devnet)" },
  { value: "real" as const, label: "Real (mainnet)", danger: true },
];

const KIND_OPTIONS = [
  { value: "cpu" as const, label: "CPU" },
  { value: "gpu" as const, label: "GPU" },
];

/**
 * A form label whose text is the help trigger (dotted underline), as on the rest of the site. The field
 * keeps a real <label> for its accessible name; it is visually hidden because a button cannot sit inside a label.
 */
function Label({ children, help, id = help, htmlFor, forId = htmlFor }: { children: string; help: keyof typeof RENT_HELP; id?: string; htmlFor?: string; forId?: string }) {
  return (
    <span className="block font-medium text-foreground">
      {htmlFor && (
        <label htmlFor={htmlFor} className="sr-only">
          {children}
        </label>
      )}
      <Help id={`help-${id}`} text={RENT_HELP[help]} forId={forId}>
        {children}
      </Help>
    </span>
  );
}

/** A number field with its unit inside, on the right (or a "$" on the left). */
function NumberField(props: {
  id: string;
  label: string;
  help: keyof typeof RENT_HELP;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  step: number;
  unit?: { shown: string; spoken: string };
  dollar?: boolean;
  disabled: boolean;
}) {
  const unitId = `${props.id}-unit`;
  return (
    <div className="min-w-0 space-y-1.5">
      <Label help={props.help} id={props.id} htmlFor={props.id}>
        {props.label}
      </Label>
      <div className="relative">
        {props.dollar && (
          <span aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">
            $
          </span>
        )}
        <input
          id={props.id}
          type="number"
          inputMode="decimal"
          min={props.min}
          max={props.max}
          step={props.step}
          value={Number.isFinite(props.value) ? props.value : ""}
          disabled={props.disabled}
          aria-describedby={`${props.unit ? `${unitId} ` : ""}help-${props.id}`}
          className={`${INPUT} ${NUMBER} w-full tabular-nums ${props.dollar ? "pl-[25px]" : ""} ${props.unit ? (props.unit.shown.length > 2 ? "pr-11" : "pr-9") : ""}`}
          onChange={(e) => props.onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))}
        />
        {props.unit && (
          <span id={unitId} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted">
            <span aria-hidden>{props.unit.shown}</span>
            <span className="sr-only">{props.unit.spoken}</span>
          </span>
        )}
      </div>
    </div>
  );
}

const inRange = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;

function parseRegions(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
}

/** One-line description of a need: "CPU, 1 vCPU, 1 GB RAM". */
export function needText(n: Need): string {
  const parts = [n.kind === "gpu" ? "GPU" : "CPU", `${n.vcpus} vCPU${n.vcpus === 1 ? "" : "s"}`, `${n.ramGb} GB RAM`];
  if (n.kind === "gpu" && n.vramGb > 0) parts.push(`${n.vramGb} GB GPU memory`);
  return parts.join(", ");
}

export function NeedForm(props: {
  snap: Snapshot | null;
  run: MarketRunView | null;
  collapsed: boolean;
  running: boolean;
  resetSignal: number;
  onDraftChange: (draft: NeedDraft) => void;
  onStart: (body: RunBody) => Promise<string | null>;
  /** Opens the model picker in the header, where the key is added. */
  onAddKey: () => void;
}) {
  const { snap, run, collapsed, running, resetSignal, onDraftChange, onStart, onAddKey } = props;
  const [market, setMarket] = useState<MarketId>("test");
  const [kind, setKind] = useState<"cpu" | "gpu">("cpu");
  const [vcpus, setVcpus] = useState(1);
  const [ramGb, setRamGb] = useState(1);
  const [vramGb, setVramGb] = useState(16);
  const [hours, setHours] = useState(1);
  const [regions, setRegions] = useState("");
  const [budget, setBudget] = useState(1);
  const [rate, setRate] = useState(0.05);
  const [allowSpot, setAllowSpot] = useState(false);
  const [ask, setAsk] = useState(true);
  const [describe, setDescribe] = useState("");
  const [filling, setFilling] = useState(false);
  const [fillNote, setFillNote] = useState<string | null>(null);
  const [fillError, setFillError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // Page Reset clears what was typed into the description and any errors; the fields keep their values.
  const lastReset = useRef(resetSignal);
  useEffect(() => {
    if (lastReset.current === resetSignal) return;
    lastReset.current = resetSignal;
    setDescribe("");
    setFillNote(null);
    setFillError(null);
    setStartError(null);
  }, [resetSignal]);

  useEffect(() => {
    onDraftChange({ budgetUsd: Number.isFinite(budget) ? budget : 0, rateUsdHr: Number.isFinite(rate) ? rate : 0 });
  }, [budget, rate, onDraftChange]);

  const hasKey = Boolean(snap?.models.providers.find((p) => p.id === snap.models.selected)?.key);

  if (collapsed) {
    const n: Need = run?.need ?? { kind, vcpus, ramGb, vramGb: kind === "gpu" ? vramGb : 0, hours, regions: parseRegions(regions), allowSpot };
    const m = run?.market ?? market;
    const b = run?.limits.budgetUsd ?? budget;
    const r = run?.limits.rateUsdHr ?? rate;
    const asks = m === "real" || (run?.askBeforePaying ?? ask);
    const rows: [string, string][] = [
      ["Market", MARKET_NAME[m]],
      ["Machine", `${needText(n)}${n.allowSpot ? ", interruptible is OK" : ""}`],
      ["Time", `${hoursText(n.hours)}, ${n.regions.length > 0 ? n.regions.join(", ") : "any region"}`],
      ["Budget", `${usd2(b)}, limit ${usd2(r)} an hour`],
      ["Paying", asks ? "Asks you first" : "Pays without asking"],
    ];
    return (
      <div className="space-y-3">
        <h2 className="text-[16px] leading-[22px] font-semibold text-foreground">What you need</h2>
        <dl className="space-y-1.5">
          {rows.map(([k, v]) => (
            <div key={k} className="flex gap-3">
              <dt className="w-16 shrink-0 text-muted">{k}</dt>
              <dd className="min-w-0 break-words tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }

  const regionList = parseRegions(regions);
  const invalid: string | null = !(Number.isInteger(vcpus) && inRange(vcpus, 1, 64))
    ? "vCPUs must be a whole number from 1 to 64."
    : !inRange(ramGb, 0.5, 512)
      ? "RAM must be from 0.5 to 512 GB."
      : kind === "gpu" && !inRange(vramGb, 0, 200)
        ? "GPU memory must be from 0 to 200 GB."
        : !inRange(hours, 1 / 60, 72)
          ? "Hours must be from 1 minute to 72 hours."
          : regionList.length > 10
            ? "Pick at most 10 regions."
            : !regionList.every((x) => REGION_RE.test(x))
              ? "A region is 2 to 20 lowercase letters, digits, colons or dashes, such as ewr."
              : !inRange(budget, 0.01, 20)
                ? "The budget must be from $0.01 to $20."
                : !inRange(rate, 0.001, Math.min(budget, 20))
                  ? "The hourly limit must be from $0.001 up to the budget."
                  : null;

  const blocked = running || starting || invalid !== null;
  const asks = market === "real" || ask;

  // Shown beside the button. A missing wallet does not block the scan or the quotes, only the payment.
  const reason: ReactNode = invalid ? (
    invalid
  ) : market === "real" && snap && !snap.walletReady.real ? (
    "Fund a mainnet wallet to pay on the real market."
  ) : market === "test" && snap && !snap.walletReady.test ? (
    "Set up the devnet wallet to pay on the test market."
  ) : null;

  const start = async () => {
    setStartError(null);
    setStarting(true);
    const failed = await onStart({
      market,
      need: { kind, vcpus, ramGb, vramGb: kind === "gpu" ? vramGb : 0, hours, regions: regionList, allowSpot },
      budgetUsd: budget,
      rateUsdHr: rate,
      askBeforePaying: asks,
    });
    setStartError(failed);
    setStarting(false);
  };

  const fill = async () => {
    if (!describe.trim()) return;
    setFillError(null);
    setFillNote(null);
    setFilling(true);
    try {
      const res = await fetch("/api/market/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: describe }),
      });
      const body = (await res.json()) as { need?: Partial<Need>; note?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? `The server answered HTTP ${res.status}`);
      const n = body.need ?? {};
      if (n.kind) setKind(n.kind);
      if (n.vcpus !== undefined) setVcpus(n.vcpus);
      if (n.ramGb !== undefined) setRamGb(n.ramGb);
      if (n.vramGb !== undefined && n.vramGb > 0) setVramGb(n.vramGb);
      if (n.hours !== undefined) setHours(n.hours);
      if (n.regions) setRegions(n.regions.join(", "));
      if (n.allowSpot !== undefined) setAllowSpot(n.allowSpot);
      setFillNote(body.note ? sentence(body.note) : null);
    } catch (e) {
      setFillError(failureMessage(e));
    } finally {
      setFilling(false);
    }
  };

  const disabled = running;

  return (
    <div className="@container space-y-5">
      <h2 className="text-[16px] leading-[22px] font-semibold text-foreground">What you need</h2>

      <div className="space-y-1.5">
        <Label help="describe" htmlFor="describe-input">
          Describe what you need
        </Label>
        <textarea
          id="describe-input"
          aria-describedby="help-describe"
          className={`${TEXTAREA} block w-full resize-none`}
          rows={2}
          placeholder="A small Linux box in New Jersey for two hours"
          value={describe}
          disabled={disabled || filling || !hasKey}
          onChange={(e) => setDescribe(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button type="button" className={BTN} disabled={disabled || filling || !hasKey || !describe.trim()} aria-describedby={!hasKey ? "describe-reason" : undefined} onClick={() => void fill()}>
            {filling ? "Filling in…" : "Fill in the form"}
          </button>
          {!hasKey && (
            <span id="describe-reason" className="text-foreground">
              <button type="button" className={TEXT_BTN} onClick={onAddKey}>
                Add a model key
              </button>{" "}
              to use this.
            </span>
          )}
          {hasKey && fillNote && <span className="min-w-0 text-muted">{fillNote}</span>}
        </div>
        <ActionError what="The form wasn't filled in" message={fillError} onDismiss={() => setFillError(null)} />
      </div>

      <div className="grid grid-cols-1 gap-x-6 gap-y-5 @min-[30rem]:grid-cols-[auto_auto] @min-[30rem]:justify-start">
        <div className="space-y-1.5">
          <Label help="market" forId="market-choice">
            Market
          </Label>
          <Segmented id="market-choice" describedBy={market === "real" ? "help-market real-line" : "help-market"} label="Market" options={MARKET_OPTIONS} value={market} onChange={setMarket} disabled={disabled} />
        </div>
        <div className="space-y-1.5">
          <Label help="kind" forId="kind-choice">
            Machine
          </Label>
          <Segmented id="kind-choice" describedBy="help-kind" label="Machine" options={KIND_OPTIONS} value={kind} onChange={setKind} disabled={disabled} />
        </div>
      </div>
      {market === "real" && (
        <p id="real-line" className="-mt-2 text-foreground">
          Real money: USDC on Solana mainnet. You approve every payment.
        </p>
      )}

      {/* Units sit inside the fields. Two columns on a narrow form, up to four on a wide one. */}
      <div className={`grid grid-cols-2 gap-4 ${kind === "gpu" ? "@min-[30rem]:grid-cols-4" : "@min-[24rem]:grid-cols-3"}`}>
        <NumberField id="vcpus-input" label="vCPUs" help="size" value={vcpus} onChange={setVcpus} min={1} max={64} step={1} disabled={disabled} />
        <NumberField id="ram-input" label="RAM" help="size" value={ramGb} onChange={setRamGb} min={0.5} max={512} step={0.5} unit={{ shown: "GB", spoken: "gigabytes" }} disabled={disabled} />
        {kind === "gpu" && (
          <NumberField id="vram-input" label="GPU memory" help="size" value={vramGb} onChange={setVramGb} min={0} max={200} step={1} unit={{ shown: "GB", spoken: "gigabytes" }} disabled={disabled} />
        )}
        <NumberField id="hours-input" label="Hours" help="hours" value={hours} onChange={setHours} min={0.25} max={72} step={0.25} unit={{ shown: "h", spoken: "hours" }} disabled={disabled} />
      </div>

      <div className="grid grid-cols-2 gap-4 @min-[24rem]:grid-cols-3">
        <NumberField id="budget-input" label="Budget" help="budget" value={budget} onChange={(n) => setBudget(n)} min={0.01} max={20} step={0.25} dollar disabled={disabled} />
        <NumberField id="rate-input" label="Hourly limit" help="rate" value={rate} onChange={setRate} min={0.001} max={Number.isFinite(budget) ? budget : 20} step={0.01} dollar unit={{ shown: "/h", spoken: "an hour" }} disabled={disabled} />
        <div className="col-span-2 min-w-0 space-y-1.5 @min-[24rem]:col-span-1">
          <Label help="regions" htmlFor="regions-input">
            Regions
          </Label>
          <input
            id="regions-input"
            type="text"
            aria-describedby="help-regions"
            className={`${INPUT} w-full`}
            placeholder="Any"
            value={regions}
            disabled={disabled}
            onChange={(e) => setRegions(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-2">
        <span className="flex items-center gap-2">
          <input id="spot-input" type="checkbox" aria-labelledby="spot-label" aria-describedby="help-spot" checked={allowSpot} disabled={disabled} onChange={(e) => setAllowSpot(e.target.checked)} />
          <Help id="help-spot" text={RENT_HELP.spot} forId="spot-input">
            <span id="spot-label">Interruptible is OK</span>
          </Help>
        </span>
        <span className="flex items-center gap-2">
          <input
            id="ask-input"
            type="checkbox"
            aria-labelledby="ask-label"
            aria-describedby="help-ask"
            checked={asks}
            disabled={disabled || market === "real"}
            onChange={(e) => setAsk(e.target.checked)}
          />
          <Help id="help-ask" text={RENT_HELP.ask} forId="ask-input">
            <span id="ask-label">Ask me before paying</span>
          </Help>
        </span>
      </div>

      <div className="space-y-2">
        {/* Why Find and rent is off, or what will not work yet, sits right beside it. */}
        <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button className={START} disabled={blocked} aria-describedby={reason ? "start-reason" : undefined} onClick={() => void start()}>
            {starting ? "Starting…" : "Find and rent"}
          </button>
          {reason && !running && (
            <span id="start-reason" className="min-w-0 text-foreground">
              {reason}
            </span>
          )}
        </span>
        <ActionError what="The run didn't start" message={startError} onDismiss={() => setStartError(null)} />
      </div>
    </div>
  );
}
