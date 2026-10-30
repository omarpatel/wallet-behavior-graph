import { z } from "zod";
import { getSession } from "@/server/auth/session";
import { getBrainPicks } from "@/server/picks/queries";

const Id = z.string().trim().min(1).max(64);
const Cursor = z.string().regex(/^\d{1,12}$/).nullable();

/**
 * BrainPicksDTO: tokens that matched this brain's style, with their paper outcomes and the brain's pick track record.
 * Seat holders / the claimed KOL / admins get every pick in real time; everyone else sees picks younger than
 * PUBLIC_DELAY_SEC as hidden placeholders, and stats over older picks only. `?cursor=` pages to older picks.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/brains/[id]/picks">) {
  const parsed = Id.safeParse((await ctx.params).id);
  const cursor = Cursor.safeParse(new URL(req.url).searchParams.get("cursor"));
  if (!parsed.success || !cursor.success) return Response.json({ error: "Invalid brain id or cursor" }, { status: 400 });
  const session = await getSession();
  const dto = await getBrainPicks(parsed.data, session?.wallet ?? null, { cursor: cursor.data });
  if (!dto) return Response.json({ error: "Brain not found" }, { status: 404 });
  return Response.json(dto, { headers: { "Cache-Control": "private, no-store" } });
}
