import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db/client";
import { getSession } from "@/server/auth/session";

const Body = z.object({ status: z.enum(["open", "resolved"]) }).strict();

/** Admin-only: mark a dispute resolved / reopen it. */
export async function POST(req: Request, ctx: RouteContext<"/api/admin/disputes/[id]">) {
  const session = await getSession();
  if (!session) return Response.json({ error: "Sign in required" }, { status: 401 });
  if (!session.isAdmin) return Response.json({ error: "Admin only" }, { status: 403 });

  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Invalid dispute id" }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Body must be { status: 'open' | 'resolved' }" }, { status: 400 });

  const rows = await getDb()
    .update(schema.disputes)
    .set({ status: parsed.data.status })
    .where(eq(schema.disputes.id, id))
    .returning({ id: schema.disputes.id, status: schema.disputes.status });
  if (rows.length === 0) return Response.json({ error: "Dispute not found" }, { status: 404 });
  return Response.json(rows[0]);
}
