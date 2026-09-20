import { keep } from "@/lib/demo/uploads";
import { sniff } from "@/lib/train";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const type = request.headers.get("content-type") ?? "";
    if (type.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return Response.json({ error: "attach a file called file" }, { status: 400 });
      return Response.json(keep(file.name || "your dataset", Buffer.from(await file.arrayBuffer())));
    }
    const body = (await request.json()) as { url?: string };
    return Response.json(await sniff(String(body.url ?? "")));
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
