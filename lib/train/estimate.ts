import type { CatalogPlan } from "../burn";
import { foldJobs } from "./datasets";
import type { JobSpec } from "./types";

export const CALIBRATION = {
  classifier: { foldSecondsPerRowEpoch: 8.25e-9, charsPerRowExponent: 1.5, baseGb: 0.3, perWorkerGb: 0.03 },
  generator: { foldSecondsPerChar: 2.3e-6, baseGb: 0.1, perWorkerGb: 0.26 },
  retrieval: { foldSecondsPerPassageProbe: 4.3e-6, baseGb: 0.25, perWorkerGb: 0.08 },
  serialShare: 0.03,
  parallelFraction: 0.8,
  poolSecondsPerWorker: 0.15,
  downloadBytesPerSecond: 25000000,
  uploadBytesPerSecond: 1200000,
  publishSeconds: 4,
  systemGb: 0.35,
  fallbackCharsPerRow: 120,
};

export const FAMILIES: Record<string, { label: string; coreSpeed: number; bootSeconds: number }> = {
  vc2: { label: "regular", coreSpeed: 0.36, bootSeconds: 100 },
  vhf: { label: "high frequency", coreSpeed: 1, bootSeconds: 72 },
  vhp: { label: "high performance", coreSpeed: 1.06, bootSeconds: 72 },
};

export type PlanQuote = {
  plan: string;
  family: string;
  familyLabel: string;
  vcpus: number;
  ramGb: number;
  hourlyUsd: number;
  coreSpeed: number;
  workers: number;
  ramNeededGb: number;
  trainSeconds: number;
  totalSeconds: number;
  jobUsd: number;
  budgetHours: number;
  withinRate: boolean;
  withinBudget: boolean;
  withinDeadline: boolean;
  enoughRam: boolean;
};

function rowsOf(spec: JobSpec): number {
  return Math.min(spec.maxRows, spec.dataset.rows || spec.maxRows);
}

function charsOf(spec: JobSpec): number {
  return Math.min(spec.maxChars, spec.dataset.bytes || spec.maxChars);
}

export function coreSecondsPerFoldJob(spec: JobSpec): number {
  if (spec.kind === "generator") return charsOf(spec) * CALIBRATION.generator.foldSecondsPerChar;
  if (spec.kind === "retrieval") {
    const passages = Math.min(spec.maxPassages, spec.dataset.rows || spec.maxPassages);
    const probesPerFold = Math.max(1, spec.probeCount / spec.folds);
    return passages * probesPerFold * CALIBRATION.retrieval.foldSecondsPerPassageProbe;
  }
  const charsPerRow = spec.dataset.charsPerRow || CALIBRATION.fallbackCharsPerRow;
  return rowsOf(spec) * spec.epochs * CALIBRATION.classifier.foldSecondsPerRowEpoch * Math.pow(charsPerRow, CALIBRATION.classifier.charsPerRowExponent);
}

function gridCoreSeconds(spec: JobSpec): number {
  return foldJobs(spec) * coreSecondsPerFoldJob(spec);
}

export function ramNeededGb(spec: JobSpec, workers: number): number {
  if (spec.kind === "retrieval") {
    const passages = Math.min(spec.maxPassages, spec.dataset.rows || spec.maxPassages);
    const c = CALIBRATION.retrieval;
    const share = (passages / 4000) * c.baseGb;
    return Math.round((CALIBRATION.systemGb + share + (c.perWorkerGb + share) * workers) * 100) / 100;
  }
  const c = spec.kind === "classifier" ? CALIBRATION.classifier : CALIBRATION.generator;
  const dataShare = spec.kind === "classifier" ? (rowsOf(spec) / 20000) * c.baseGb : (charsOf(spec) / 1050000) * c.baseGb;
  const perWorker = spec.kind === "classifier" ? c.perWorkerGb : (charsOf(spec) / 1050000) * c.perWorkerGb;
  return Math.round((CALIBRATION.systemGb + dataShare + perWorker * workers) * 100) / 100;
}

export function quote(
  spec: JobSpec,
  plan: CatalogPlan,
  limits: { budgetUsd: number; rateUsdHr: number; prepayHours: number; deadlineSeconds?: number },
): PlanQuote {
  const family = FAMILIES[plan.family] ?? { label: plan.family, coreSpeed: 0.36, bootSeconds: 100 };
  const workers = Math.min(plan.vcpus, foldJobs(spec));
  const grid = gridCoreSeconds(spec) / family.coreSpeed;
  const serial = grid * CALIBRATION.serialShare;
  const effective = 1 + (workers - 1) * CALIBRATION.parallelFraction;
  const transferBytes = spec.dataset.maxBytes ?? spec.dataset.bytes;
  const download =
    spec.dataset.origin === "upload"
      ? Math.max(2, transferBytes / CALIBRATION.uploadBytesPerSecond)
      : Math.max(1, transferBytes / CALIBRATION.downloadBytesPerSecond);
  const trainSeconds = serial + grid / effective + workers * CALIBRATION.poolSecondsPerWorker;
  const totalSeconds = family.bootSeconds + download + trainSeconds + CALIBRATION.publishSeconds;
  const billedHours = Math.max(limits.prepayHours, totalSeconds / 3600);
  const jobUsd = plan.hourlyUsd * billedHours;
  const needed = ramNeededGb(spec, workers);
  return {
    plan: plan.id,
    family: plan.family,
    familyLabel: family.label,
    vcpus: plan.vcpus,
    ramGb: plan.ramGb,
    hourlyUsd: plan.hourlyUsd,
    coreSpeed: family.coreSpeed,
    workers,
    ramNeededGb: needed,
    trainSeconds: Math.round(trainSeconds),
    totalSeconds: Math.round(totalSeconds),
    jobUsd: Math.round(jobUsd * 1e6) / 1e6,
    budgetHours: Math.round((limits.budgetUsd / plan.hourlyUsd) * 10) / 10,
    withinRate: plan.hourlyUsd <= limits.rateUsdHr,
    withinBudget: jobUsd <= limits.budgetUsd,
    withinDeadline: limits.deadlineSeconds === undefined || totalSeconds <= limits.deadlineSeconds,
    enoughRam: plan.ramGb >= needed,
  };
}

export function shortlist(plans: CatalogPlan[], limits: { rateUsdHr: number; maxPlans?: number }): CatalogPlan[] {
  const usable = plans.filter(
    (p) => p.family in FAMILIES && p.hourlyUsd <= limits.rateUsdHr && p.vcpus <= 16 && p.ramGb >= 1 && !p.id.endsWith("-v6"),
  );
  const best = new Map<number, CatalogPlan[]>();
  for (const plan of usable) {
    const row = best.get(plan.vcpus) ?? [];
    row.push(plan);
    best.set(plan.vcpus, row);
  }
  const perCount = [...best.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, row]) => row.sort((a, b) => a.hourlyUsd - b.hourlyUsd || b.ramGb - a.ramGb).slice(0, 2))
    .flat();
  const max = limits.maxPlans ?? 9;
  if (perCount.length <= max) return perCount;
  const step = (perCount.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => perCount[Math.round(i * step)]).filter((p, i, list) => list.indexOf(p) === i);
}

export function quotes(
  spec: JobSpec,
  plans: CatalogPlan[],
  limits: { budgetUsd: number; rateUsdHr: number; prepayHours: number; deadlineSeconds?: number },
): PlanQuote[] {
  return shortlist(plans, { rateUsdHr: limits.rateUsdHr })
    .map((plan) => quote(spec, plan, limits))
    .sort((a, b) => a.totalSeconds - b.totalSeconds);
}

export function pick(list: PlanQuote[], preference: number): PlanQuote | null {
  const viable = list.filter((q) => q.withinRate && q.withinBudget && q.enoughRam && q.withinDeadline);
  if (viable.length === 0) return null;
  const fastest = Math.min(...viable.map((q) => q.totalSeconds));
  const slowest = Math.max(...viable.map((q) => q.totalSeconds));
  const cheapest = Math.min(...viable.map((q) => q.jobUsd));
  const dearest = Math.max(...viable.map((q) => q.jobUsd));
  const norm = (value: number, low: number, high: number) => (high === low ? 0 : (value - low) / (high - low));
  return viable
    .map((q) => ({ q, cost: preference * norm(q.totalSeconds, fastest, slowest) + (1 - preference) * norm(q.jobUsd, cheapest, dearest) }))
    .sort((a, b) => a.cost - b.cost)[0].q;
}

export function why(chosen: PlanQuote, list: PlanQuote[]): string {
  const viable = list.filter((q) => q.withinRate && q.withinBudget && q.enoughRam && q.withinDeadline);
  const fastest = [...viable].sort((a, b) => a.totalSeconds - b.totalSeconds)[0];
  const cheapest = [...viable].sort((a, b) => a.jobUsd - b.jobUsd)[0];
  const minutes = (q: PlanQuote) => `${Math.round(q.totalSeconds / 6) / 10} min`;
  if (chosen.plan === fastest.plan && chosen.plan === cheapest.plan) return `${chosen.plan} is both the fastest and the cheapest option that fits`;
  if (chosen.plan === fastest.plan) {
    return `${chosen.plan} finishes in ${minutes(chosen)} against ${minutes(cheapest)} on the cheapest plan, for ${(chosen.jobUsd - cheapest.jobUsd).toFixed(4)} USDC more`;
  }
  if (chosen.plan === cheapest.plan) {
    return `${chosen.plan} costs ${chosen.jobUsd.toFixed(4)} USDC against ${fastest.jobUsd.toFixed(4)} on the fastest plan, and takes ${minutes(chosen)} instead of ${minutes(fastest)}`;
  }
  return `${chosen.plan} sits between the two: ${minutes(chosen)} at ${chosen.jobUsd.toFixed(4)} USDC, against ${minutes(fastest)} at ${fastest.jobUsd.toFixed(4)} and ${minutes(cheapest)} at ${cheapest.jobUsd.toFixed(4)}`;
}

export function preferenceLabel(preference: number): string {
  if (preference <= 0.2) return "cheapest";
  if (preference <= 0.45) return "leaning cheap";
  if (preference < 0.55) return "balanced";
  if (preference < 0.8) return "leaning fast";
  return "fastest";
}
