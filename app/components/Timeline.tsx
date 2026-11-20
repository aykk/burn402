"use client";

import { useState } from "react";
import type { TrainingRunView } from "@/lib/demo/train";
import type { TrainedModel } from "@/lib/train";
import { Fold } from "./Fold";
import { PHASE_TEXT, REGIONS, collapseLog, duration, kb, money } from "./format";

const SUB = "text-[13.5px] leading-5 font-semibold text-foreground";

/** One signed message: sender, kind, signature, then the text (ink for your agent, muted for the broker). */
function Message(props: { who: string; kind: string; signed: string; verified: boolean; text: string; mine: boolean }) {
  return (
    <div className={`max-w-[80%] border-l-2 pl-3 ${props.mine ? "border-foreground" : "border-rule"}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 text-[12px] leading-4">
        <span className="font-semibold text-foreground">{props.who}</span>
        <span className="text-muted">{props.kind}</span>
        <span className="font-mono text-muted">{props.signed}…</span>
        {props.verified ? <span className="text-ok">Verified</span> : <span className="text-bad">Not verified</span>}
      </div>
      <div className={`mt-0.5 whitespace-pre-wrap ${props.mine ? "text-foreground" : "text-muted"}`}>{props.text}</div>
    </div>
  );
}

/** Backend copy still says "Vultr desk"; the UI calls it the broker. */
const brokerCopy = (text: string) => text.replace(/Vultr desk/gi, "broker");

export function Timeline({ job, model }: { job: TrainingRunView; model: TrainedModel | null }) {
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
    .filter(({ q }) => q.plan !== (job.plan ?? job.chosen?.plan))
    .slice(0, 2)
    .map(({ q }) => q);
  const marked = job.plan ?? job.chosen?.plan ?? null;
  const shownQuotes = plans ? job.quotes : job.quotes.filter((q) => q.plan === marked || near.includes(q));
  const sender = (from: string) => (from === "company" ? "Your agent" : "Broker");
  const kind = (k: string) => k.replace(/_/g, " ");
  return (
    <div className="space-y-6 border-t border-rule pt-8">
      <div>
        <h2 className="text-[16px] leading-[22px] font-semibold">{PHASE_TEXT[job.phase]}</h2>
        <p className="mt-0.5 text-[12px] leading-4 text-muted" title={`Agent ${job.agent.ansName}, mandate ${job.mandateJti}`}>
          {job.model.name}, limit {money(job.rateUsdHr)} an hour, {job.deadlineMinutes} minutes
        </p>
      </div>

      {job.messages.length > 0 && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h3 className={SUB}>Deal</h3>
            <span className="text-[12px] leading-4 text-muted">Both agents signed every message; ANS keys verified.</span>
            {settled && (
              <span className="ml-auto">
                <Fold label={`the full exchange (${job.messages.length} messages)`} open={openTalk} onToggle={() => setOpenTalk(!openTalk)} />
              </span>
            )}
          </div>
          {!talk && lastDesk && <Message who="Broker" kind={kind(lastDesk.kind)} signed={lastDesk.signed} verified text={lastDesk.text} mine={false} />}
          {talk &&
            job.messages.map((m) => (
              <div key={m.seq} className={`flex ${m.fromLabel === "company" ? "justify-start" : "justify-end"}`}>
                <Message who={sender(m.fromLabel)} kind={kind(m.kind)} signed={m.signed} verified={m.verified} text={m.text} mine={m.fromLabel === "company"} />
              </div>
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
      )}

      {job.quotes.length > 0 && (
        <section className="space-y-2">
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
            <table className="w-full min-w-[640px] border-collapse text-[13.5px] leading-5">
              <thead>
                <tr className="border-b border-rule-strong text-left text-[12px] leading-4 text-muted">
                  <th className="py-2 pr-4 pl-2.5 font-medium">Plan</th>
                  <th className="py-2 pr-4 font-medium">Cores</th>
                  <th className="py-2 pr-4 font-medium">RAM</th>
                  <th className="py-2 pr-4 text-right font-medium">$/hour</th>
                  <th className="py-2 pr-4 text-right font-medium">Ready in</th>
                  <th className="py-2 pr-4 text-right font-medium">This run</th>
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
                      <td className="py-2 pr-4">
                        {q.vcpus} {q.familyLabel}
                      </td>
                      <td className="py-2 pr-4">
                        {q.ramGb} GB{q.enoughRam ? "" : " (too small)"}
                      </td>
                      <td className="py-2 pr-4 text-right">{q.hourlyUsd.toFixed(4)}</td>
                      <td className="py-2 pr-4 text-right">
                        {duration(q.totalSeconds)}
                        {q.withinDeadline ? "" : " (over the limit)"}
                      </td>
                      <td className={`py-2 pr-4 text-right ${chosen ? "font-semibold text-amber" : ""}`}>{q.jobUsd.toFixed(4)}</td>
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
      )}

      {job.plan && (
        <section className="space-y-1 border-l-2 pl-3" style={{ borderColor: live ? "var(--foreground)" : "var(--rule)" }}>
          <h3 className={SUB}>Rented and paid</h3>
          <div>
            <span className="font-semibold">{job.plan}</span> in {REGIONS[job.region] ?? job.region},{" "}
            <span className="text-ok">{job.paidUsd !== null ? `${money(job.paidUsd)} USDC settled` : "paid over x402"}</span>
            {job.boxUrl && job.phase !== "done" && (
              <>
                {", "}
                <a href={job.boxUrl} target="_blank" rel="noreferrer">
                  open the box at {job.ip}
                </a>
              </>
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
      )}

      {(job.phase === "booting" || job.phase === "training" || job.phase === "publishing" || job.phase === "done") && (
        <section className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h3 className={SUB}>Training</h3>
            <span className="tabular-nums">
              Predicted {duration(job.predictedSeconds)}
              {job.actualSeconds !== null
                ? `, took ${duration(job.actualSeconds)}`
                : elapsed !== null
                  ? `, ${duration(Math.round(elapsed))} on the box so far`
                  : ""}
            </span>
            {status?.vcpus ? <span className="text-[12px] leading-4 text-muted">{status.vcpus} workers</span> : null}
          </div>
          <div className="h-2 w-full max-w-[520px] rounded-[1px] bg-segment">
            <div className="h-full rounded-[1px] bg-foreground transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <div className="space-y-0.5 text-[12px] leading-4 text-muted tabular-nums">
            {collapseLog(status?.log ?? [])
              .slice(-4)
              .map((l, i) => (
                <div key={i}>
                  {l.at.toFixed(1)}s {l.text}
                </div>
              ))}
            {job.phase === "booting" && !status && <div>Waiting for the box to answer, usually under two minutes.</div>}
          </div>
        </section>
      )}

      {job.phase === "done" && model && (
        <p className="text-ok">The model is {kb(job.modelBytes)} and the server was shut down. It is below, running in your browser.</p>
      )}
    </div>
  );
}
