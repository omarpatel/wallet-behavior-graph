import { z } from "zod";
import { getConnectome } from "@/server/connectome/queries";

const Query = z.object({
  minWeight: z.coerce.number().min(0).max(1e6).optional(),
  region: z.coerce.number().int().min(0).optional(),
});

/** Public trading connectome: neurons, synapses (samples delayed by PUBLIC_DELAY_SEC), regions. */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const parsed = Query.safeParse({
    minWeight: sp.get("minWeight") || undefined,
    region: sp.get("region") || undefined,
  });
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid query" }, { status: 400 });
  return Response.json(await getConnectome(parsed.data));
}
