/** Read-only prices from providers this app cannot buy from. They never enter the payment path. */

export type PriceSource = "vultr" | "vast" | "runpod" | "akash";

export type MarketPrice = {
  source: PriceSource;
  /** "Vultr (direct)", "Vast.ai marketplace", "RunPod (direct)", "Akash Network" */
  sourceLabel: string;
  /** plan id or GPU model as the source names it */
  name: string;
  kind: "cpu" | "gpu";
  /** 0 = the source does not state it */
  vcpus: number;
  /** 0 = the source does not state it */
  ramGb: number;
  gpu: string | null;
  vramGb: number;
  /** on-demand price per hour */
  hourlyUsd: number;
  /** interruptible / bid / preemptible price when published, else null */
  spotHourlyUsd: number | null;
  region: string | null;
  /** short plain words, e.g. "community host, 99.3% reliability", "3 of 5 available" */
  note: string | null;
  /** the provider's own page where a person can rent it (fixed per source) */
  url: string;
};

export type SourceStatus = { source: PriceSource; label: string; ok: boolean; count: number; note: string | null };

export const SOURCE_LABELS: Record<PriceSource, string> = {
  vultr: "Vultr (direct)",
  vast: "Vast.ai marketplace",
  runpod: "RunPod (direct)",
  akash: "Akash Network",
};

export const SOURCE_URLS: Record<PriceSource, string> = {
  vultr: "https://www.vultr.com/pricing/",
  vast: "https://cloud.vast.ai/create/",
  runpod: "https://www.runpod.io/pricing",
  akash: "https://console.akash.network/",
};

export const SOURCES: PriceSource[] = ["vultr", "vast", "runpod", "akash"];
