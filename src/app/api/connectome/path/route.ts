import { z } from "zod";
import { getPath } from "@/server/connectome/queries";

const Query = z.object({
  from: z.string().trim().min(1, "from is required").max(64),
  to: z.string().trim().min(1, "to is required").max(64),
});

/** Strongest directed path between two neurons; `hops: null` when none exists. */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const parsed = Query.safeParse({ from: sp.get("from") ?? "", to: sp.get("to") ?? "" });
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid query" }, { status: 400 });
  const dto = await getPath(parsed.data.from, parsed.data.to);
  if (!dto) return Response.json({ error: "Neuron not found" }, { status: 404 });
  return Response.json(dto);
}
