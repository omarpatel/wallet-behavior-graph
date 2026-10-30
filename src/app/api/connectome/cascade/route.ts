import { z } from "zod";
import { getCascade } from "@/server/connectome/queries";

const Query = z.object({
  source: z.string().trim().min(1, "source is required").max(64),
  depth: z.coerce.number().int().min(1).max(6).default(3),
});

/** Signal cascade from one neuron: who typically enters after it, layer by layer. */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const parsed = Query.safeParse({ source: sp.get("source") ?? "", depth: sp.get("depth") || undefined });
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid query" }, { status: 400 });
  const dto = await getCascade(parsed.data.source, parsed.data.depth);
  if (!dto) return Response.json({ error: "Neuron not found" }, { status: 404 });
  return Response.json(dto);
}
