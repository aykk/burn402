import { getSession } from "@/lib/demo/session";
import { uploaded } from "@/lib/demo/uploads";
import type { DatasetSource } from "@/lib/train";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  return Response.json({ job: session.job?.view() ?? null, previous: session.previous });
}

export async function POST(request: Request) {
  const session = await getSession();
  const body = (await request.json()) as {
    request?: string;
    dataset?: DatasetSource;
    budgetUsd?: number;
    rateUsdHr?: number;
    deadlineMinutes?: number;
    preference?: number;
  };
  try {
    const dataset = body.dataset;
    if (!dataset?.url) throw new Error("upload a file or paste a URL to one first");
    if (dataset.origin === "upload" && !uploaded(dataset.uploadId ?? "")) throw new Error("that upload has expired; add the file again");
    const view = await session.startJob({
      request: String(body.request ?? ""),
      dataset,
      budgetUsd: Number(body.budgetUsd ?? 5),
      rateUsdHr: body.rateUsdHr === undefined ? undefined : Number(body.rateUsdHr),
      deadlineMinutes: body.deadlineMinutes === undefined ? undefined : Number(body.deadlineMinutes),
      preference: Number(body.preference ?? 0.5),
    });
    return Response.json({ job: view });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
