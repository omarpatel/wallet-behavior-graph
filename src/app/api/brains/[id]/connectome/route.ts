import { z } from "zod";
import { getSession } from "@/server/auth/session";
import { getTokenGraph } from "@/server/connectome/queries";

const Id = z.string().trim().min(1).max(64);

/** A brain's token connectome. Realtime for viewers with access; otherwise trades older than PUBLIC_DELAY_SEC. */
export async function GET(_req: Request, ctx: RouteContext<"/api/brains/[id]/connectome">) {
  const parsed = Id.safeParse((await ctx.params).id);
  if (!parsed.success) return Response.json({ error: "Invalid brain id" }, { status: 400 });
  const session = await getSession();
  const dto = await getTokenGraph(parsed.data, session?.wallet ?? null);
  if (!dto) return Response.json({ error: "Brain not found" }, { status: 404 });
  return Response.json(dto, { headers: { "Cache-Control": "private, no-store" } });
}
