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
    "You are the Vultr desk: an agent that knows one thing well, which Vultr instance suits a job.",
    `Every plan you quote is a real Vultr plan available in ${region}, with its real hourly price.`,
    "The timings you are given come from a measured model of this exact training job: a hyperparameter grid search cross-validated across a process pool, one worker per vCPU.",
    "Answer in at most four short sentences. Name the plan you recommend, say what it costs for this job and how long it takes, and name the one plan a buyer might pick instead and why they might not.",
    "Never invent a plan, a price or a timing. Never recommend a plan that does not have enough RAM.",
  ].join(" ");
}

export function vultrTask(brief: Brief, list: PlanQuote[], chosen: PlanQuote | null, reason: string, ask: string | null): string {
  return [
    ask ? `The company agent is pushing back: "${ask}"` : `The company agent asks for a quote: "${brief.request}"`,
    "",
    `Job: ${jobDescription(brief.kind)} on ${brief.dataset.name} (${brief.dataset.note}).`,
    `Work: ${brief.foldJobs} cross-validation jobs, which spread across vCPUs.`,
    `Limits: budget $${brief.budgetUsd} in total, at most $${brief.rateUsdHr} per hour, and the model must be ready within ${brief.deadlineMinutes} minutes. Preference ${preferenceLabel(brief.preference)}.`,
    "",
    "Plans, timings and costs for this job:",
    list
      .map(
        (q) =>
          `${q.plan}: ${q.vcpus} vCPU, ${q.ramGb} GB, ${q.familyLabel} cores, $${q.hourlyUsd.toFixed(4)}/hour. Ready in ${Math.round(q.totalSeconds / 6) / 10} min (${q.trainSeconds}s training after an 80s boot). This job costs $${q.jobUsd.toFixed(4)}. The budget would last ${q.budgetHours} hours. Needs ${q.ramNeededGb} GB${q.enoughRam ? "" : " - NOT ENOUGH RAM ON THIS PLAN"}.`,
      )
      .join("\n"),
    "",
    chosen ? `The measured pick for this preference is ${chosen.plan}: ${reason}.` : "No plan fits those limits.",
  ].join("\n");
}

export function companySystemPrompt(name: string, budgetUsd: number, rateUsdHr: number): string {
  return [
    `You are the company's own agent, ANS identity ${name}.`,
    `You hold a mandate worth $${budgetUsd} in total with a ceiling of $${rateUsdHr} per hour, and you spend it through a broker over x402. You never hold a Vultr key.`,
    "Your job: get the model your operator asked for, trained, for a sensible price.",
    "Talk to the Vultr desk with ask_vultr. Ask for a quote first. Push back exactly once, with a concrete constraint, then rent with rent_server.",
    "Rent one server only. Keep every message to two sentences. When you are done, say in one sentence what you rented, what it costs, and when the model will be ready.",
  ].join(" ");
}

export function companyTask(brief: Brief): string {
  return [
    `Your operator asked for: "${brief.request}"`,
    `The dataset is ${brief.dataset.name} (${brief.dataset.note}), and the job is a ${jobDescription(brief.kind)} with ${brief.foldJobs} cross-validation jobs.`,
    `Your mandate: $${brief.budgetUsd} in total, a ceiling of $${brief.rateUsdHr} per hour, and it expires in ${brief.deadlineMinutes} minutes, so the model has to be ready before then.`,
    `Your operator's preference is ${preferenceLabel(brief.preference)}.`,
    "Ask the Vultr desk what to rent, push back once on price or speed, then rent it.",
  ].join("\n");
}
