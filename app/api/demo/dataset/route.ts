import { keep, merge, uploaded } from "@/lib/demo/uploads";
import { PROBE_BYTES, sniff, type DatasetSource } from "@/lib/train";

export const dynamic = "force-dynamic";

async function fetchWhole(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`that URL answered HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function POST(request: Request) {
  try {
    const type = request.headers.get("content-type") ?? "";
    if (type.includes("multipart/form-data")) {
      const form = await request.formData();
      const files = form.getAll("file").filter((f): f is File => f instanceof File);
      if (files.length === 0) return Response.json({ error: "attach at least one file" }, { status: 400 });
      const parts = await Promise.all(files.map(async (file) => keep(file.name || "your file", Buffer.from(await file.arrayBuffer()))));
      return Response.json(parts.length === 1 ? parts[0] : merge(parts.map((p) => ({ dataset: p.dataset, bytes: uploaded(p.dataset.uploadId!)!.bytes }))));
    }

    const body = (await request.json()) as { url?: string; urls?: string[]; sources?: DatasetSource[] };

    if (Array.isArray(body.sources) && body.sources.length > 0) {
      const parts = await Promise.all(
        body.sources.map(async (dataset) => {
          const held = dataset.uploadId ? uploaded(dataset.uploadId) : null;
          if (held) return { dataset, bytes: held.bytes };
          return { dataset, bytes: await fetchWhole(dataset.url) };
        }),
      );
      return Response.json(parts.length === 1 && parts[0].dataset.origin === "upload" ? { dataset: parts[0].dataset, sampleRows: [], labels: parts[0].dataset.labels ?? [] } : merge(parts));
    }

    const urls = body.urls ?? (body.url ? [body.url] : []);
    if (urls.length === 0) return Response.json({ error: "paste a URL or add a file" }, { status: 400 });
    const sniffed = await Promise.all(urls.map((url) => sniff(url)));
    if (sniffed.length === 1) return Response.json(sniffed[0]);
    const parts = await Promise.all(
      sniffed.map(async (s) => ({ dataset: s.dataset, bytes: (await fetchWhole(s.dataset.url)).subarray(0, s.dataset.maxBytes ?? PROBE_BYTES) })),
    );
    return Response.json(merge(parts));
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
