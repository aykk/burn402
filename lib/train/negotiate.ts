import type { CatalogPlan } from "../burn";
import { pick, preferenceLabel, quotes, why, type PlanQuote } from "./estimate";
import type { JobKind, JobSpec } from "./types";

export function jobDescription(kind: JobKind): string {
  if (kind === "classifier") return "text classifier";
  if (kind === "generator") return "character language model";
  return "tf-idf search index over documents";
}

export const A2A_TYP = "a2a+jws";

export type Brief = {
  request: string;
  kind: JobSpec["kind"];
  dataset: { name: string; note: string; rows: number; bytes: number };
  foldJobs: number;
  budgetUsd: number;
  rateUsdHr: number;
  deadlineMinutes: number;
  preference: number;
  region: string;
};

export type QuoteRequest = { conv: string; kind: "quote_request"; iss: string; aud: string; at: number; brief: Brief; note: string };
export type Counter = { conv: string; kind: "counter"; iss: string; aud: string; at: number; ask: string; maxSeconds: number | null; maxUsd: number | null };
export type A2ARequest = QuoteRequest | Counter;

export type Offer = {
  conv: string;
  kind: "quote" | "revised_quote";
  iss: string;
  aud: string;
  at: number;
  quotes: PlanQuote[];
  recommend: string | null;
  reason: string;
  text: string;
};

export function filterQuotes(list: PlanQuote[], limits: { maxSeconds: number | null; maxUsd: number | null }): PlanQuote[] {
  return list.filter((q) => (limits.maxSeconds === null || q.totalSeconds <= limits.maxSeconds) && (limits.maxUsd === null || q.jobUsd <= limits.maxUsd));
}

export function planNamed(list: PlanQuote[], text: string): PlanQuote | null {
  const named = list
    .filter((q) => new RegExp(`\\b${q.plan.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text))
    .sort((a, b) => text.indexOf(a.plan) - text.indexOf(b.plan));
  return named[0] ?? null;
}

export function offerFor(options: {
  spec: JobSpec;
  plans: CatalogPlan[];
  brief: Brief;
  prepayHours: number;
  limits?: { maxSeconds: number | null; maxUsd: number | null };
}): { quotes: PlanQuote[]; chosen: PlanQuote | null; reason: string } {
  const all = quotes(options.spec, options.plans, {
    budgetUsd: options.brief.budgetUsd,
    rateUsdHr: options.brief.rateUsdHr,
    deadlineSeconds: Number.isFinite(options.brief.deadlineMinutes) && options.brief.deadlineMinutes > 0 ? options.brief.deadlineMinutes * 60 : undefined,
    prepayHours: options.prepayHours,
  });
  const narrowed = options.limits ? filterQuotes(all, options.limits) : all;
  const chosen = pick(narrowed.length > 0 ? narrowed : all, options.brief.preference);
  const reason = chosen ? why(chosen, narrowed.length > 0 ? narrowed : all) : "nothing in the catalogue fits those limits";
  return { quotes: all, chosen, reason };
}

export function vultrSystemPrompt(region: string): string {
  return [
    `You are the Vultr desk. You sell compute in ${region} and you know the catalogue better than the buyer does.`,
    "You are given every plan that fits the buyer's hourly ceiling, with its real price and a predicted time for their exact job.",
    "Choose the plan you would actually sell them, given what they asked for in their own words. The choice is yours, not theirs.",
    "Name it exactly as it appears in the list, say what it costs for this job and when the model would be ready, and give the one reason you picked it over the nearest alternative.",
    "If they push back, answer the constraint they raised. Change your recommendation if their constraint makes a different plan better, and say so plainly if it does not.",
    "Never name a plan that is not in the list, never invent a price or a timing, and never recommend one marked as not fitting.",
    "Three or four sentences. No preamble, no bullet points.",
  ].join(" ");
}

export function vultrTask(brief: Brief, list: PlanQuote[], ask: string | null): string {
  const line = (q: PlanQuote) => {
    const flags = [q.withinRate ? null : "over their hourly ceiling", q.enoughRam ? null : "not enough RAM for this job", q.withinDeadline ? null : "too slow for their deadline"].filter(
      Boolean,
    );
    return `${q.plan}: ${q.vcpus} vCPU, ${q.ramGb} GB, ${q.familyLabel} cores, $${q.hourlyUsd.toFixed(4)} an hour. Ready in ${Math.round(q.totalSeconds / 6) / 10} min. This job costs $${q.jobUsd.toFixed(4)}. Their budget would cover ${q.budgetHours} hours of it.${flags.length > 0 ? ` DOES NOT FIT: ${flags.join(", ")}.` : ""}`;
  };
  return [
    ask ? `The buyer is pushing back: "${ask}"` : `A buyer asks for a quote. What they told their own agent, word for word: "${brief.request}"`,
    "",
    `The job: ${jobDescription(brief.kind)} over ${brief.dataset.name} (${brief.dataset.note}), which splits into ${brief.foldJobs} pieces that run in parallel, one per vCPU.`,
    `Their limits: $${brief.budgetUsd} in total, at most $${brief.rateUsdHr} an hour, and it has to be ready inside ${brief.deadlineMinutes} minutes. They said they lean ${preferenceLabel(brief.preference)}.`,
    "",
    "Your catalogue for this job:",
    list.map(line).join("\n"),
  ].join("\n");
}

export function companySystemPrompt(name: string, budgetUsd: number, rateUsdHr: number): string {
  return [
    `You are a company's own agent, registered as ${name}.`,
    `You hold a mandate worth $${budgetUsd} in total with a ceiling of $${rateUsdHr} an hour. You spend it through a broker over x402 and you never hold a provider key.`,
    "Your operator has told you what they want in their own words. Read it and decide what actually matters to them before you talk to anyone.",
    "Use ask_vultr to get a quote from the Vultr desk. Open by saying what your operator actually wants, in their words, before any of the technical detail. The desk already knows the job size; it does not know what this is for.",
    "Then push back once, on whatever is weakest about the desk's answer for your operator: the price, the timing, the headroom, or the fit. Be specific about what you want instead.",
    "Then rent one plan with rent_server. You may take the desk's recommendation or overrule it, but only from the plans it quoted.",
    "Two sentences per message. Finish with one sentence saying what you rented, what it costs and when the model will be ready.",
  ].join(" ");
}

export function companyTask(brief: Brief): string {
  return [
    `Your operator's request, word for word: "${brief.request}". Lead with this when you talk to the desk.`,
    `The dataset is ${brief.dataset.name} (${brief.dataset.note}), and the job is a ${jobDescription(brief.kind)} with ${brief.foldJobs} cross-validation jobs.`,
    `Your mandate: $${brief.budgetUsd} in total, a ceiling of $${brief.rateUsdHr} per hour, and it expires in ${brief.deadlineMinutes} minutes, so the model has to be ready before then.`,
    `Your operator's preference is ${preferenceLabel(brief.preference)}.`,
    "Work out what that request implies about speed against cost, then get a quote, push back once, and rent.",
  ].join("\n");
}
