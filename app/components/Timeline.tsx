"use client";

import { useState, type ReactNode } from "react";
import type { TrainingRunView } from "@/lib/demo/train";
import type { TrainedModel } from "@/lib/train";
import { Swatch } from "./BudgetMeter";
import { NEXT_STEP } from "./copy";
import { Fold } from "./Fold";
import { PHASE_TEXT, REGIONS, clock, collapseLog, duration, money } from "./format";
import { DEAL, STAGES, stageIndex } from "./stages";

const SUB = "text-[13.5px] leading-5 font-semibold text-foreground";
const usd4 = (n: number) => `$${(Number.isFinite(n) ? Math.max(0, n) : 0).toFixed(4)}`;

/**
 * One signed message as a ledger row: sender and time on the left, then kind, signature and the text on
 * the right behind a 2px rule (ink for your agent, light rule for the broker). Stacks under 640px.
 */
function Message(props: { who: string; at: number; kind: string; signed: string; verified: boolean; text: string; mine: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-y-1 sm:grid-cols-[88px_minmax(0,1fr)] sm:gap-x-4">
      <div className="flex items-baseline gap-x-2 text-[12px] leading-4 sm:block">
        <div className={`font-semibold ${props.mine ? "text-foreground" : "text-muted"}`}>{props.who}</div>
        <div className="text-muted tabular-nums">{Number.isFinite(props.at) ? clock(props.at * 1000) : ""}</div>
      </div>
      <div className={`min-w-0 border-l-2 pl-3 ${props.mine ? "border-foreground" : "border-rule"}`}>
        <div className="flex flex-wrap items-baseline gap-x-2 text-[12px] leading-4">
          <span className="text-muted">{props.kind}</span>
          <span className="font-mono text-muted">{props.signed}…</span>
          {props.verified ? <span className="text-ok">Verified</span> : <span className="text-bad">Not verified</span>}
        </div>
        <div className={`mt-0.5 break-words whitespace-pre-wrap ${props.mine ? "text-foreground" : "text-muted"}`}>{props.text}</div>
      </div>
    </div>
  );
}

/** Backend copy still says "Vultr desk"; the UI calls it the broker. */
const brokerCopy = (text: string) => text.replace(/Vultr desk/gi, "broker");

export function Timeline({ job, result }: { job: TrainingRunView; model: TrainedModel | null; result?: ReactNode }) {
  const status = job.status;
  const progress = status?.progress ?? 0;
  const elapsed = status?.elapsed ?? null;
  const settled = job.phase === "done" || job.phase === "failed";
  // Once the server is rented the live activity leads, and the deal and plans fold away like a settled run.
  const onBox = job.phase === "booting" || job.phase === "training" || job.phase === "publishing";
  const folded = settled || onBox;
  const [openTalk, setOpenTalk] = useState(false);
  const [openPlans, setOpenPlans] = useState(false);
  const live = job.handle !== null && !settled;
  const lastDesk = [...job.messages].reverse().find((m) => m.fromLabel === "vultr") ?? null;
  const talk = folded ? openTalk : true;
  const plans = folded ? openPlans : job.plan === null;
  const near = job.quotes
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => q.plan !== (job.plan ?? job.chosen?.plan))
    .slice(0, 2)
    .map(({ q }) => q);
  const marked = job.plan ?? job.chosen?.plan ?? null;
  const shownQuotes = plans ? job.quotes : job.quotes.filter((q) => q.plan === marked || near.includes(q));
  const sender = (from: string) => (from === "company" ? "Your agent" : "Broker");
  const kind = (k: string) => k.replace(/_/g, " ");

  let heading: string = PHASE_TEXT[job.phase];
  if (job.phase === "done" && job.actualSeconds !== null) {
    heading = `Trained in ${duration(job.actualSeconds)}${job.paidUsd !== null ? ` for ${usd4(job.paidUsd)}` : ""}`;
  }
  const failedAt = job.phase === "failed" ? stageIndex(job) : null;
  if (failedAt !== null) heading = `Stopped during ${STAGES[Math.min(failedAt, STAGES.length - 1)].toLowerCase()}`;

  const deal = job.messages.length > 0 && (
    <section key="deal" className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 className={SUB}>Deal</h3>
        <span className="text-[12px] leading-4 text-muted">Both agents signed every message; ANS keys verified.</span>
        {folded && (
          <span className="ml-auto">
            <Fold label={`the full exchange (${job.messages.length} messages)`} open={openTalk} onToggle={() => setOpenTalk(!openTalk)} />
          </span>
        )}
      </div>
      {!talk && lastDesk && (
        <Message who="Broker" at={lastDesk.at} kind={kind(lastDesk.kind)} signed={lastDesk.signed} verified={lastDesk.verified} text={lastDesk.text} mine={false} />
      )}
      {talk &&
        job.messages.map((m) => (
          <Message
            key={m.seq}
            who={sender(m.fromLabel)}
            at={m.at}
            kind={kind(m.kind)}
            signed={m.signed}
            verified={m.verified}
            text={m.text}
            mine={m.fromLabel === "company"}
          />
        ))}
      {job.conversation?.url && (
        <div className="text-[12px] leading-4 text-muted">
          <a href={job.conversation.url} target="_blank" rel="noreferrer">
            This exchange on Arweave
          </a>
          {job.conversation.withheld > 0 && `, ${job.conversation.withheld} of ${job.conversation.messages} stored as hash`}
        </div>
      )}
    </section>
  );

  const planTable = job.quotes.length > 0 && (
    <section key="plans" className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 className={SUB}>Recommended plans</h3>
        <span className="text-[12px] leading-4 text-muted tabular-nums">for a budget of {money(job.budgetUsd)}</span>
        {job.quotes.length > shownQuotes.length || plans ? (
          <span className="ml-auto">
            <Fold
              label={plans ? `${job.quotes.length} plans the broker quoted` : `all ${job.quotes.length} plans the broker quoted`}
              open={plans}
              onToggle={() => setOpenPlans(!openPlans)}
            />
          </span>
        ) : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full sm:min-w-[680px] border-collapse text-[13.5px] leading-5">
          <thead>
            <tr className="border-b border-rule-strong text-left text-[12px] leading-4 text-muted">
              <th className="py-2 pr-4 pl-2.5 font-medium">Plan</th>
              <th className="hidden py-2 pr-4 sm:table-cell text-right font-medium">Cores</th>
              <th className="hidden py-2 pr-4 sm:table-cell font-medium">Type</th>
              <th className="hidden py-2 pr-4 sm:table-cell font-medium">RAM</th>
              <th className="py-2 pr-4 text-right font-medium">$/hour</th>
              <th className="py-2 pr-4 text-right font-medium">Ready in</th>
              <th className="py-2 pr-4 text-right font-medium">This run ($)</th>
              <th className="py-2 text-right font-medium">Budget covers</th>
            </tr>
          </thead>
          <tbody>
            {shownQuotes.map((q) => {
              const chosen = q.plan === marked;
              return (
                <tr
                  key={q.plan}
                  aria-current={chosen ? "true" : undefined}
                  className={`border-b border-rule ${chosen ? "font-semibold" : q.enoughRam && q.withinDeadline ? "" : "text-muted"}`}
                >
                  <td className={`border-l-2 py-2 pr-4 pl-2 ${chosen ? "border-foreground" : "border-transparent"}`}>
                    {q.plan}
                    {chosen && <span className="sr-only"> (chosen)</span>}
                  </td>
                  <td className="hidden py-2 pr-4 text-right sm:table-cell">{q.vcpus}</td>
                  <td className="hidden py-2 pr-4 font-normal text-muted sm:table-cell">{q.familyLabel}</td>
                  <td className="hidden py-2 pr-4 sm:table-cell">
                    {q.ramGb} GB{q.enoughRam ? "" : " (too small)"}
                  </td>
                  <td className="py-2 pr-4 text-right">{q.hourlyUsd.toFixed(4)}</td>
                  <td className="py-2 pr-4 text-right">
                    {duration(q.totalSeconds)}
                    {q.withinDeadline ? "" : " (over the limit)"}
                  </td>
                  <td className="py-2 pr-4 text-right">
                    {chosen ? (
                      <span
                        className="font-semibold text-foreground underline decoration-amber decoration-2 underline-offset-4"
                        title="The money this run uses, shown amber in the meter"
                      >
                        {q.jobUsd.toFixed(4)}
                      </span>
                    ) : (
                      q.jobUsd.toFixed(4)
                    )}
                  </td>
                  <td className="py-2 text-right">{q.budgetHours} h</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {job.plan && job.chosen && job.plan !== job.chosen.plan ? (
        <p className="text-muted">
          The broker recommended {job.chosen.plan}; your agent rented {job.plan}.
        </p>
      ) : (
        job.chosenReason && <p className="text-muted">{brokerCopy(job.chosenReason)}</p>
      )}
    </section>
  );

  const rented = job.plan && (
    <section key="rented" className="space-y-1 border-l-2 pl-3" style={{ borderColor: live ? "var(--foreground)" : "var(--rule)" }}>
      <h3 className={SUB}>Rented and paid</h3>
      <div>
        {job.plan} in {REGIONS[job.region] ?? job.region}
        {job.boxUrl && job.phase !== "done" && job.phase !== "failed" && (
          <>
            {", "}
            <a href={job.boxUrl} target="_blank" rel="noreferrer">
              open the box at {job.ip}
            </a>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-2">
        {job.paidUsd !== null ? (
          <>
            <Swatch />
            <span className="font-semibold tabular-nums">{usd4(job.paidUsd)} USDC</span>
            <span className="text-ok">settled</span>
          </>
        ) : (
          <span className="text-muted">Paid over x402</span>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 text-[12px] leading-4">
        {job.solscan && (
          <a href={job.solscan} target="_blank" rel="noreferrer">
            Payment on Solscan
          </a>
        )}
        {job.arweaveUrl && (
          <a href={job.arweaveUrl} target="_blank" rel="noreferrer">
            Receipt on Arweave
          </a>
        )}
      </div>
    </section>
  );

  const timing =
    job.actualSeconds !== null
      ? `Took ${duration(job.actualSeconds)}, predicted ${duration(job.predictedSeconds)}`
      : elapsed !== null
        ? `${duration(Math.round(elapsed))} of a predicted ${duration(job.predictedSeconds)}`
        : `Predicted ${duration(job.predictedSeconds)}`;
  const lines = collapseLog(status?.log ?? []).slice(-4);
  const training = (onBox || job.phase === "done") && (
    <section key="training" className="space-y-2">
      <div>
        <h3 className={SUB}>Progress</h3>
        <p className="text-[12px] leading-4 text-muted tabular-nums">
          {timing}
          {status?.vcpus ? `, ${status.vcpus} workers` : ""}
        </p>
      </div>
      <div className="h-2 w-full rounded-[1px] bg-segment">
        <div className="h-full rounded-[1px] bg-foreground transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <div className="grid grid-cols-[44px_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[12px] leading-4">
        {lines.map((l, i) => (
          <div key={i} className="contents">
            <span className="text-right text-muted tabular-nums">{l.at.toFixed(1)}s</span>
            <span className={`break-words ${i === lines.length - 1 ? "text-foreground" : "text-muted"}`}>{l.text}</span>
          </div>
        ))}
        {job.phase === "booting" && !status && <div className="col-span-2 text-muted">Waiting for the box to answer, usually under two minutes.</div>}
      </div>
    </section>
  );

  // Negotiating and paying lead with the deal; on the box the live training leads; settled runs read in order.
  const sections = onBox ? [training, rented, deal, planTable] : [deal, planTable, rented, training];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[16px] leading-[22px] font-semibold">{heading}</h2>
        <p className="mt-0.5 text-[12px] leading-4 text-muted" title={`Agent ${job.agent.ansName}, mandate ${job.mandateJti}`}>
          {job.model.name}
        </p>
        {failedAt !== null && (
          <div className="mt-3 space-y-1">
            {/* The page's live region announces the failure once; an alert here would say it twice. */}
            <p className="max-w-[64ch] text-bad">
              {job.error?.trim() || "The run failed."}
            </p>
            <p className="max-w-[64ch] text-foreground">
              {failedAt === DEAL ? NEXT_STEP.deal : NEXT_STEP.later(usd4(job.budgetUsd - (job.paidUsd ?? 0)))}
            </p>
          </div>
        )}
      </div>

      {result}

      {sections}
    </div>
  );
}
