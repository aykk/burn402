"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Snapshot } from "@/lib/demo/snapshot";
import type { MarketRunView } from "@/lib/market/run";
import type { MarketId, Need } from "@/lib/market/types";
import { ActionError } from "./ActionError";
import { RENT_HELP } from "./copy";
import { usd2 } from "./format";
import { Help } from "./Help";
import { MARKET_NAME, hoursText, shortAddress } from "./market-copy";
import { draftLimits } from "./meter-model";
import { Segmented } from "./Segmented";
import { BTN, INPUT } from "./ui";
import { useWallet } from "./wallet";
import { WalletConnect } from "./WalletConnect";

/** The last valid budget and limit; `valid` is false while a field holds a value the form would refuse. */
export type NeedDraft = { budgetUsd: number; rateUsdHr: number; valid: boolean };

export type RunBody = {
  market: MarketId;
  need: Need;
  budgetUsd: number;
  rateUsdHr: number;
  askBeforePaying: boolean;
  /** the connected wallet to pay from; null for the wallet the app runs with */
  wallet: string | null;
};

/** What "Compare prices" sends: the same market and need a run would use. */
/** The limits go along so the comparison shows the plan a run with these limits would actually pick. */
export type CompareBody = { market: MarketId; need: Need; budgetUsd: number; rateUsdHr: number };

const START =
  "inline-flex h-10 shrink-0 items-center rounded-[3px] border border-foreground bg-foreground px-5 text-[14px] leading-5 font-semibold text-surface enabled:hover:bg-[#2B3644] disabled:cursor-not-allowed disabled:border-segment disabled:bg-segment disabled:text-muted";

/** Number fields with the unit inside: no spinner arrows to collide with the suffix (arrow keys still step). */
const NUMBER = "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

/** The filter rail: one filter per row, top to bottom, label on the left and its field on the right, all fields one width. */
const ROWS = "grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5";

/** Around a checkbox: padding that takes the click too, pulled back by the same margin so nothing moves. */
const CHECK_TARGET = "-m-1.5 inline-flex p-1.5";

const REGION_RE = /^[a-z0-9:-]{2,20}$/;

const MARKET_OPTIONS = [
  { value: "test" as const, label: "Test (devnet)" },
  { value: "real" as const, label: "Real (mainnet)", danger: true, spends: true },
];

const PAY_FROM_OWNER = [
  { value: "agent" as const, label: "Agent wallet" },
  { value: "wallet" as const, label: "My wallet" },
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

/** A number field with its unit inside, on the right (or a "$" on the left). Two cells of a ROWS grid: its label, then the field. */
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
    <>
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
    </>
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
  /** Reads market prices for this need; starts no run. Resolves to the failure, or null. */
  onCompare: (body: CompareBody) => Promise<string | null>;
  /** Bumped when the comparison is closed: focus goes to Compare prices once it is enabled, else to the heading. */
  compareClosed?: number;
  /** What the form asks for right now, each time it changes; null while a field holds a value the form would refuse. */
  onNeedChange?: (body: CompareBody | null) => void;
  /** Opens the model picker in the header, where the key is added. */
}) {
  const { snap, run, collapsed, running, resetSignal, onDraftChange, onStart, onCompare, compareClosed = 0, onNeedChange } = props;
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
  // Whose money pays: the wallet the app runs with, or the visitor's own wallet in this browser.
  const [payFrom, setPayFrom] = useState<"agent" | "wallet">("agent");
  const wallet = useWallet();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);

  // After Close: focus waits for Compare prices to be enabled again (its request is cancelled at once); when the
  // form blocks it for another reason, focus goes to the form's heading instead, never to the page.
  const compareButton = useRef<HTMLButtonElement>(null);
  const formHeading = useRef<HTMLHeadingElement>(null);
  const focusAfterClose = useRef(compareClosed);
  useEffect(() => {
    if (focusAfterClose.current === compareClosed || comparing) return;
    focusAfterClose.current = compareClosed;
    const button = compareButton.current;
    if (button && !button.disabled) button.focus();
    else formHeading.current?.focus();
  });

  // Page Reset clears what was typed into the description and any errors; the fields keep their values.
  const lastReset = useRef(resetSignal);
  useEffect(() => {
    if (lastReset.current === resetSignal) return;
    lastReset.current = resetSignal;
    setStartError(null);
    setCompareError(null);
  }, [resetSignal]);

  // The meter follows the budget and limit as they are typed, but only valid pairs: while a field holds a value the
  // form would refuse, the meter keeps the last valid one instead of showing it as if it were real.
  // The meter is dimmed meanwhile, so a valid prefix of what is being typed ("9" of "99999999") is not read as the budget.
  const lastValid = useRef<{ budgetUsd: number; rateUsdHr: number }>({ budgetUsd: 1, rateUsdHr: 0.05 });
  useEffect(() => {
    const valid = draftLimits(budget, rate);
    if (valid) lastValid.current = valid;
    onDraftChange({ ...lastValid.current, valid: valid !== null });
  }, [budget, rate, onDraftChange]);

  // The page lists the plans that fit as the filters change: it is told the current need, or null while the form is not valid.
  useEffect(() => {
    if (!onNeedChange) return;
    const regionList = parseRegions(regions);
    const ok =
      Number.isInteger(vcpus) && inRange(vcpus, 1, 64) && inRange(ramGb, 0.5, 512) && (kind !== "gpu" || inRange(vramGb, 0, 200)) && inRange(hours, 1 / 60, 72) &&
      regionList.length <= 10 && regionList.every((x) => REGION_RE.test(x)) && inRange(budget, 0.01, 20) && inRange(rate, 0.001, Math.min(budget, 20));
    onNeedChange(ok ? { market, need: { kind, vcpus, ramGb, vramGb: kind === "gpu" ? vramGb : 0, hours, regions: regionList, allowSpot }, budgetUsd: budget, rateUsdHr: rate } : null);
  }, [onNeedChange, market, kind, vcpus, ramGb, vramGb, hours, regions, budget, rate, allowSpot]);

  // A public visitor gets the test market only.
  const publicDemo = snap?.visitor === "public";

  if (collapsed) {
    const n: Need = run?.need ?? { kind, vcpus, ramGb, vramGb: kind === "gpu" ? vramGb : 0, hours, regions: parseRegions(regions), allowSpot };
    const m = run?.market ?? market;
    const b = run?.limits.budgetUsd ?? budget;
    const r = run?.limits.rateUsdHr ?? rate;
    const from = run ? run.wallet : payFrom === "wallet" ? (wallet.connected?.address ?? null) : null;
    const asks = m === "real" || from !== null || (run?.askBeforePaying ?? ask);
    const rows: [string, string][] = [
      ["Market", MARKET_NAME[m]],
      ["Machine", `${needText(n)}${n.allowSpot ? ", interruptible is OK" : ""}`],
      ["Time", `${hoursText(n.hours)}, ${n.regions.length > 0 ? n.regions.join(", ") : "any region"}`],
      ["Budget", `${usd2(b)}, limit ${usd2(r)} an hour`],
      ["Paying", from ? `From your wallet ${shortAddress(from)}, asks you first` : asks ? "Asks you first" : "Pays without asking"],
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
  const ownWallet = payFrom === "wallet" && !publicDemo;
  // Paying from your own wallet needs it connected; comparing prices does not.
  const needsWallet = ownWallet && !wallet.connected;
  const asks = market === "real" || ownWallet || ask;
  const need: Need = { kind, vcpus, ramGb, vramGb: kind === "gpu" ? vramGb : 0, hours, regions: regionList, allowSpot };

  // Shown beside the buttons. A missing wallet does not block the scan, the quotes or a price comparison, only the payment.
  const reason: ReactNode = invalid ? (
    invalid
  ) : running || starting ? (
    "A run is in progress"
  ) : needsWallet ? (
    "Connect a wallet to pay from it."
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
      need,
      budgetUsd: budget,
      rateUsdHr: rate,
      askBeforePaying: asks,
      wallet: ownWallet ? (wallet.connected?.address ?? null) : null,
    });
    setStartError(failed);
    setStarting(false);
  };

  const compare = async () => {
    setCompareError(null);
    setComparing(true);
    setCompareError(await onCompare({ market, need, budgetUsd: budget, rateUsdHr: rate }));
    setComparing(false);
  };

  const disabled = running;

  return (
    <div className="max-w-[24rem] space-y-4 lg:max-w-none">
      <h2 ref={formHeading} tabIndex={-1} className="text-[16px] leading-[22px] font-semibold text-foreground focus:outline-none">
        What you need
      </h2>

      <div className="space-y-1.5">
        <Label help="market" forId="market-choice">
          Market
        </Label>
        {/* The public demo has one market; the real one spends the owner's wallet and is not offered there. */}
        {publicDemo ? (
          <p id="market-choice" className="text-foreground">
            <span className="font-medium">Test (devnet)</span>
            <span className="text-muted">: test money and simulated machines. Nothing here costs real money.</span>
          </p>
        ) : (
          <Segmented id="market-choice" describedBy={market === "real" ? "help-market real-line" : "help-market"} label="Market" options={MARKET_OPTIONS} value={market} onChange={setMarket} disabled={disabled} fill />
        )}
        {/* Under the Market choice it belongs to. */}
        {market === "real" && (
          <p id="real-line" className="text-foreground">
            Real money: USDC on Solana mainnet. You approve every payment.
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label help="kind" forId="kind-choice">
          Machine
        </Label>
        <Segmented id="kind-choice" describedBy="help-kind" label="Machine" options={KIND_OPTIONS} value={kind} onChange={setKind} disabled={disabled} fill />
      </div>

      {/* The machine: one filter per row. Units sit inside the fields. */}
      <div className={ROWS}>
        <NumberField id="vcpus-input" label="vCPUs" help="size" value={vcpus} onChange={setVcpus} min={1} max={64} step={1} disabled={disabled} />
        <NumberField id="ram-input" label="RAM" help="size" value={ramGb} onChange={setRamGb} min={0.5} max={512} step={0.5} unit={{ shown: "GB", spoken: "gigabytes" }} disabled={disabled} />
        {kind === "gpu" && (
          <NumberField id="vram-input" label="GPU memory" help="size" value={vramGb} onChange={setVramGb} min={0} max={200} step={1} unit={{ shown: "GB", spoken: "gigabytes" }} disabled={disabled} />
        )}
        <NumberField id="hours-input" label="Hours" help="hours" value={hours} onChange={setHours} min={0.25} max={72} step={0.25} unit={{ shown: "h", spoken: "hours" }} disabled={disabled} />
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
        <span className="col-span-2 flex items-center gap-2 pt-0.5">
          {/* The label is only a larger place to click or tap (25px); the box takes its name from the text beside it. */}
          <label className={CHECK_TARGET}>
            <input id="spot-input" type="checkbox" aria-labelledby="spot-label" aria-describedby="help-spot" checked={allowSpot} disabled={disabled} onChange={(e) => setAllowSpot(e.target.checked)} />
          </label>
          <Help id="help-spot" text={RENT_HELP.spot} forId="spot-input">
            <span id="spot-label">Interruptible is OK</span>
          </Help>
        </span>
      </div>

      {/* The spending limits, set apart from the machine by a rule. */}
      <div className={`${ROWS} border-t border-rule pt-4`}>
        <NumberField id="budget-input" label="Budget" help="budget" value={budget} onChange={(n) => setBudget(n)} min={0.01} max={20} step={0.25} dollar disabled={disabled} />
        <NumberField id="rate-input" label="Hourly limit" help="rate" value={rate} onChange={setRate} min={0.001} max={Number.isFinite(budget) ? budget : 20} step={0.01} dollar unit={{ shown: "/h", spoken: "an hour" }} disabled={disabled} />
        {/* Whose money pays. Your own wallet approves each payment itself, so that choice always asks first.
            The public demo pays from its shared devnet wallet only. */}
        {!publicDemo && (
          <div className="col-span-2 space-y-2 pt-1">
            <Label help="payFrom" forId="pay-from-choice">
              Pay from
            </Label>
            <Segmented
              id="pay-from-choice"
              describedBy={ownWallet ? "help-payFrom pay-from-wallet" : "help-payFrom"}
              label="Pay from"
              options={PAY_FROM_OWNER}
              value={payFrom}
              onChange={setPayFrom}
              disabled={disabled}
              fill
            />
            {ownWallet && <WalletConnect id="pay-from-wallet" disabled={disabled} />}
          </div>
        )}
        <span className="col-span-2 flex items-center gap-2 pt-0.5">
          <label className={CHECK_TARGET}>
            <input
              id="ask-input"
              type="checkbox"
              aria-labelledby="ask-label"
              aria-describedby="help-ask"
              checked={asks}
              disabled={disabled || market === "real" || ownWallet}
              onChange={(e) => setAsk(e.target.checked)}
            />
          </label>
          <Help id="help-ask" text={RENT_HELP.ask} forId="ask-input">
            <span id="ask-label">Ask me before paying</span>
          </Help>
        </span>
      </div>

      <div className="space-y-2 pt-1">
        {/* Why Find and rent or Compare prices is off, or what will not work yet, sits right under them. */}
        <span className="flex flex-col gap-2">
          <button className={`${START} w-full justify-center`} disabled={blocked || needsWallet} aria-describedby={reason ? "start-reason" : undefined} onClick={() => void start()}>
            {starting ? "Starting…" : "Find and rent"}
          </button>
          {/* Reads prices only: starts no run and spends nothing. */}
          <button ref={compareButton} id="compare-button" type="button" className={`${BTN} w-full`} disabled={blocked || comparing} aria-describedby={reason ? "start-reason" : undefined} onClick={() => void compare()}>
            {comparing ? "Comparing…" : "Compare prices"}
          </button>
          {reason && (
            <span id="start-reason" className="min-w-0 text-foreground">
              {reason}
            </span>
          )}
        </span>
        <ActionError what="The run didn't start" message={startError} onDismiss={() => setStartError(null)} />
        <ActionError what="Prices weren't read" message={compareError} onDismiss={() => setCompareError(null)} />
      </div>
    </div>
  );
}
