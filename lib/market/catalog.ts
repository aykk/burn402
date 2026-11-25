import { DEFAULT_RULES, type HourlyRules, type Offer } from "./types";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pos = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

const defaultRules = (): HourlyRules => ({
  ...DEFAULT_RULES,
  minHours: { ...DEFAULT_RULES.minHours },
  surchargePct: { ...DEFAULT_RULES.surchargePct },
});

function parseRules(raw: unknown): HourlyRules {
  if (!isObj(raw)) return defaultRules();
  const by = isObj(raw.min_hours_by_kind) ? raw.min_hours_by_kind : {};
  const pct = isObj(raw.surcharge_pct) ? raw.surcharge_pct : {};
  const minAll = num(raw.min_hours);
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_RULES.enabled,
    minHours: {
      machine: num(by.machine) ?? minAll ?? DEFAULT_RULES.minHours.machine,
      gpu: num(by.gpu) ?? DEFAULT_RULES.minHours.gpu,
    },
    surchargeBelowHours: num(raw.surcharge_below_hours) ?? DEFAULT_RULES.surchargeBelowHours,
    surchargePct: {
      machine: num(pct.machine) ?? DEFAULT_RULES.surchargePct.machine,
      gpu: num(pct.gpu) ?? DEFAULT_RULES.surchargePct.gpu,
    },
  };
}

function parsePlan(row: unknown, seller: string): Offer | null {
  if (!isObj(row)) return null;
  const id = str(row.id);
  const provider = str(row.provider);
  const hourly = pos(row.our_hourly);
  const ram = pos(row.ram);
  const vcpus = pos(row.vcpu_count);
  if (!id || !provider || hourly === null || ram === null || vcpus === null) return null;

  let regions: string[];
  if (Array.isArray(row.locations)) {
    regions = row.locations.filter((l): l is string => typeof l === "string");
  } else if (row.locations == null && provider === "runpod") {
    regions = ["runpod"];
  } else {
    return null;
  }

  const vram = pos(row.gpu_vram_gb) ?? 0;
  const gpuType = str(row.gpu_type);
  const isGpu = gpuType !== null || vram > 0 || id.startsWith("vcg-") || id.startsWith("runpod-");

  return {
    seller,
    id,
    provider,
    kind: isGpu ? "gpu" : "cpu",
    vcpus,
    ramGb: ram / 1024,
    vramGb: vram,
    gpu: isGpu ? (gpuType ?? id) : null,
    regions,
    hourlyUsd: hourly,
    listHourlyUsd: pos(row.vultr_hourly),
    inStock: row.in_stock !== false,
    spot: false,
    rentable: true,
  };
}

export function parsePlansFeed(raw: unknown, seller: string): { offers: Offer[]; rules: HourlyRules; skipped: number } {
  if (!isObj(raw) || !Array.isArray(raw.plans)) return { offers: [], rules: defaultRules(), skipped: 0 };
  const offers: Offer[] = [];
  let skipped = 0;
  for (const row of raw.plans) {
    const o = parsePlan(row, seller);
    if (o) offers.push(o);
    else skipped++;
  }
  return { offers, rules: parseRules(raw.hourly), skipped };
}

export function parseNuzaFeed(raw: unknown): Offer[] {
  if (!isObj(raw) || !Array.isArray(raw.gpus)) return [];
  const offers: Offer[] = [];
  for (const g of raw.gpus) {
    if (!isObj(g)) continue;
    const model = str(g.model);
    const region = str(g.region);
    const spot = pos(g.spot_usd_per_hour);
    const vram = pos(g.vram_gb);
    if (!model || !region || spot === null || vram === null) continue;
    offers.push({
      seller: "nuza",
      id: `${model}-${region}`,
      provider: "nuza",
      kind: "gpu",
      vcpus: 0,
      ramGb: 0,
      vramGb: vram,
      gpu: model,
      regions: [region],
      hourlyUsd: spot,
      listHourlyUsd: pos(g.on_demand_usd_per_hour),
      inStock: (num(g.available) ?? 0) > 0,
      spot: true,
      rentable: false,
    });
  }
  return offers;
}
