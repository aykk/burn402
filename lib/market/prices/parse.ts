import { usdPlain } from "../money";
import { SOURCE_LABELS, SOURCE_URLS, type MarketPrice, type PriceSource } from "./types";

/**
 * One parser per provider, each a pure function over the raw JSON. Bad rows are skipped and
 * nothing throws: a feed that changes shape yields fewer prices, never a crash.
 */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pos = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const oneDecimal = (n: number) => Math.round(n * 10) / 10;

/** Provider text shown to the owner is capped, so a feed cannot flood the page. */
const MAX_TEXT = 80;
const cap = (s: string | null): string | null => (s !== null && s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s);
const capped = (p: MarketPrice): MarketPrice => ({ ...p, name: cap(p.name)!, gpu: cap(p.gpu), region: cap(p.region), note: cap(p.note) });

function base(source: PriceSource): Pick<MarketPrice, "source" | "sourceLabel" | "url"> {
  return { source, sourceLabel: SOURCE_LABELS[source], url: SOURCE_URLS[source] };
}

/**
 * Vultr `GET /v2/plans`: `ram` in MB, `hourly_cost` on demand. Plans priced 0 (the free tier) and
 * plans whose `locations` list is empty (offered nowhere right now) are skipped. Bare-metal GPU
 * plans leave `gpu_type`/`gpu_vram_gb` null; their id ("vcg-a16-6c-60g-16vram") names both.
 */
export function parseVultr(raw: unknown): MarketPrice[] {
  if (!isObj(raw)) return [];
  const out: MarketPrice[] = [];
  for (const row of rows(raw.plans)) {
    if (!isObj(row)) continue;
    const id = str(row.id);
    const hourly = pos(row.hourly_cost);
    if (!id || hourly === null) continue;
    let region: string | null = null;
    if (Array.isArray(row.locations)) {
      const locs = row.locations.filter((l): l is string => typeof l === "string" && l !== "");
      if (locs.length === 0) continue;
      region = locs[0];
    }
    const gpuType = str(row.gpu_type);
    const brand = str(row.gpu_brand);
    const idVram = /-(\d+)vram\b/.exec(id);
    const vram = pos(row.gpu_vram_gb) ?? (idVram ? Number(idVram[1]) : 0);
    const isGpu = gpuType !== null || vram > 0 || (brand !== null && brand.toLowerCase() !== "none") || id.startsWith("vcg-");
    const model = /^vcg-([a-z0-9]+)-/i.exec(id)?.[1]?.toUpperCase() ?? null;
    const gpu = !isGpu ? null : (gpuType ?? ([brand && brand.toLowerCase() !== "none" ? brand : null, model].filter(Boolean).join(" ") || id));
    const preemptible = pos(row.hourly_cost_preemptible);
    out.push(capped({
      ...base("vultr"),
      name: id,
      kind: isGpu ? "gpu" : "cpu",
      vcpus: pos(row.vcpu_count) ?? 0,
      ramGb: oneDecimal((pos(row.ram) ?? 0) / 1024),
      gpu,
      vramGb: isGpu ? vram : 0,
      hourlyUsd: hourly,
      spotHourlyUsd: preemptible !== null && row.deploy_preemptible !== false ? preemptible : null,
      region,
      note: null,
    }));
  }
  return out;
}

/**
 * Vast.ai `bundles`: `gpu_ram` and `cpu_ram` in MB, `dph_total` on demand, `min_bid` interruptible.
 * GPU memory is rounded to whole GB, as Vast itself shows it (16380 MB is a 16 GB card).
 */
export function parseVast(raw: unknown): MarketPrice[] {
  if (!isObj(raw)) return [];
  const out: MarketPrice[] = [];
  for (const row of rows(raw.offers)) {
    if (!isObj(row)) continue;
    const name = str(row.gpu_name);
    const hourly = pos(row.dph_total);
    if (!name || hourly === null) continue;
    const reliability = num(row.reliability2);
    out.push(capped({
      ...base("vast"),
      name,
      kind: "gpu",
      vcpus: oneDecimal(pos(row.cpu_cores_effective) ?? 0),
      ramGb: oneDecimal((pos(row.cpu_ram) ?? 0) / 1024),
      gpu: name,
      vramGb: Math.round((pos(row.gpu_ram) ?? 0) / 1024),
      hourlyUsd: hourly,
      spotHourlyUsd: pos(row.min_bid),
      region: str(row.geolocation),
      note: reliability !== null && reliability >= 0 && reliability <= 1 ? `community host, ${(reliability * 100).toFixed(1)}% reliability` : null,
    }));
  }
  return out;
}

const RUNPOD_TIERS = [
  { price: "communityPrice", spot: "communitySpotPrice", offered: "communityCloud", stock: "community", other: "securePrice", note: "RunPod community cloud" },
  { price: "securePrice", spot: "secureSpotPrice", offered: "secureCloud", stock: "secure", other: "communityPrice", note: "RunPod secure cloud" },
] as const;

const UNCONFIRMED = "listed price, availability not confirmed";

/**
 * RunPod `gpuTypes`: one price per GPU type per tier that RunPod actually offers. RunPod lists
 * placeholder prices ($0.50 for an MI300X) for tiers it does not offer, so a tier is kept only when:
 * - the stock answer for one GPU in that tier is present and names a status (the note gives it); or,
 *   when no stock answer came back, the tier's own flag (`communityCloud`/`secureCloud`) is true; or,
 *   with neither signal, its price is not under a third of the other tier's price.
 * The last two say "listed price, availability not confirmed". 0 or null = not offered.
 */
export function parseRunpod(raw: unknown): MarketPrice[] {
  if (!isObj(raw) || !isObj(raw.data)) return [];
  const out: MarketPrice[] = [];
  for (const row of rows(raw.data.gpuTypes)) {
    if (!isObj(row)) continue;
    const name = str(row.displayName) ?? str(row.id);
    if (!name) continue;
    for (const tier of RUNPOD_TIERS) {
      const hourly = pos(row[tier.price]);
      if (hourly === null) continue;
      const stockAnswer = row[tier.stock];
      const flag = row[tier.offered];
      let note: string;
      if (isObj(stockAnswer) && "stockStatus" in stockAnswer) {
        const status = str(stockAnswer.stockStatus);
        if (status === null || flag === false) continue;
        note = `${tier.note}, ${status.toLowerCase()} stock`;
      } else if (typeof flag === "boolean") {
        if (!flag) continue;
        note = `${tier.note}; ${UNCONFIRMED}`;
      } else {
        const other = pos(row[tier.other]);
        if (other !== null && hourly < other / 3) continue;
        note = `${tier.note}; ${UNCONFIRMED}`;
      }
      out.push(capped({
        ...base("runpod"),
        name,
        kind: "gpu",
        vcpus: 0,
        ramGb: 0,
        gpu: str(row.id) ?? name,
        vramGb: pos(row.memoryInGb) ?? 0,
        hourlyUsd: hourly,
        spotHourlyUsd: pos(row[tier.spot]),
        region: null,
        note,
      }));
    }
  }
  return out;
}

/** "40Gi" → 40 (GB of GPU memory); anything else → 0 (not stated). */
function giToGb(v: unknown): number {
  const m = typeof v === "string" ? /^(\d+(?:\.\d+)?)\s*G(?:i|B)?$/i.exec(v.trim()) : null;
  return m ? Number(m[1]) : 0;
}

/**
 * Akash `gpu-prices`: one price per GPU model across the network's providers. The price is the
 * minimum (the cheapest listed) when positive, else the average; the note gives the average and
 * the top of the range. Models with nothing available are skipped.
 */
export function parseAkash(raw: unknown): MarketPrice[] {
  if (!isObj(raw)) return [];
  const out: MarketPrice[] = [];
  for (const row of rows(raw.models)) {
    if (!isObj(row) || !isObj(row.price)) continue;
    const model = str(row.model);
    const avail = isObj(row.availability) ? row.availability : {};
    const available = num(avail.available) ?? 0;
    const total = num(avail.total);
    const min = pos(row.price.min);
    const max = pos(row.price.max);
    const avg = pos(row.price.avg);
    // the cheapest listed price, as the other sources give theirs; the average goes in the note
    const hourly = min ?? avg;
    if (!model || hourly === null || !(available > 0)) continue;
    const ram = str(row.ram);
    const iface = str(row.interface);
    const vendor = str(row.vendor);
    const notes: string[] = [];
    const stock = total !== null && total >= available ? `${available} of ${total} available` : `${available} available`;
    if (max !== null && max !== hourly) notes.push(`${avg !== null ? `average ${usdPlain(avg)} an hour, ` : ""}up to ${usdPlain(max)} an hour across providers`);
    notes.push(stock);
    out.push(capped({
      ...base("akash"),
      name: [model, ram, iface].filter(Boolean).join(" "),
      kind: "gpu",
      vcpus: 0,
      ramGb: 0,
      gpu: vendor ? `${vendor} ${model}` : model,
      vramGb: giToGb(row.ram),
      hourlyUsd: hourly,
      spotHourlyUsd: null,
      region: null,
      note: notes.join("; "),
    }));
  }
  return out;
}
