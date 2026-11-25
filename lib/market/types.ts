export type MarketId = "test" | "real";

/** regions [] = any */
export type Need = {
  kind: "cpu" | "gpu";
  vcpus: number;
  ramGb: number;
  vramGb: number;
  hours: number;
  regions: string[];
  allowSpot: boolean;
};

export type Limits = { budgetUsd: number; rateUsdHr: number };

export type HourlyRules = {
  enabled: boolean;
  minHours: { machine: number; gpu: number };
  surchargeBelowHours: number;
  surchargePct: { machine: number; gpu: number };
};

export type Offer = {
  seller: string;
  id: string;
  provider: string;
  kind: "cpu" | "gpu";
  vcpus: number;
  ramGb: number;
  vramGb: number;
  gpu: string | null;
  regions: string[];
  hourlyUsd: number;
  listHourlyUsd: number | null;
  inStock: boolean;
  spot: boolean;
  rentable: boolean;
};

export const DEFAULT_RULES: HourlyRules = {
  enabled: true,
  minHours: { machine: 1, gpu: 2 },
  surchargeBelowHours: 24,
  surchargePct: { machine: 15, gpu: 20 },
};
