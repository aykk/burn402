import { VultrResource } from "@/lib/burn";
import { getSession } from "@/lib/demo/session";

export const dynamic = "force-dynamic";

const PLANS = ["vc2-1c-1gb", "vc2-1c-2gb", "vc2-2c-4gb", "vcg-a16-2c-8g-2vram"];

export async function GET() {
  const { rt } = await getSession();
  const region = rt.config.region;
  const plans = await Promise.all(
    PLANS.map(async (plan) => {
      try {
        const hourlyUsd = await rt.resource.quote({ plan, region });
        const info = rt.resource.kind === "vultr" ? await (rt.resource as VultrResource).planInfo(plan) : null;
        return {
          plan,
          provider: rt.resource.kind === "vultr" ? "Vultr" : "simulated",
          vcpus: info?.vcpus ?? null,
          ramGb: info?.ramGb ?? null,
          gpu: info?.gpu ? `${info.gpuType ?? "GPU"} ${info.gpuVramGb ?? ""} GB`.trim() : null,
          hourlyUsd,
          note: info?.gpu ? "GPU plans are not enabled on this broker's provider account yet" : null,
        };
      } catch {
        return null;
      }
    }),
  );
  return Response.json({ region, plans: plans.filter(Boolean) });
}
