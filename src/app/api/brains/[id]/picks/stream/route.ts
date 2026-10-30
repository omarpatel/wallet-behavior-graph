import { and, desc, eq, gt, gte, or } from "drizzle-orm";
import { connection } from "next/server";
import { getDb, schema } from "@/db/client";
import { hasBrainAccess } from "@/server/access";
import { getSession } from "@/server/auth/session";
import { pickDTO } from "@/server/picks/queries";

const POLL_MS = 3_000;
const HEARTBEAT_MS = 15_000;
const ACCESS_RECHECK_MS = 60_000;
const BACKLOG = 50;

/**
 * Seat-gated SSE of a brain's picks (the DB is the bus: the agents runner writes brain_picks, this polls every 3 s):
 *   event: pick  PickDTO   backlog = newest 50 (oldest first); then every new pick, and every change of an existing
 *                          one (paper marks ~every 15 s, exit-plan sales, close). Clients upsert by PickDTO.id.
 * 401 signed out, 403 without a seat (the public reads GET /api/brains/[id]/picks, delayed).
 */
export async function GET(req: Request, ctx: RouteContext<"/api/brains/[id]/picks/stream">) {
  await connection();
  const { id: brainId } = await ctx.params;
  const db = getDb();
  const [brain] = await db.select({ id: schema.brains.id }).from(schema.brains).where(eq(schema.brains.id, brainId)).limit(1);
  if (!brain) return Response.json({ error: "Brain not found" }, { status: 404 });
  const wallet = (await getSession())?.wallet ?? null;
  const access = await hasBrainAccess(wallet, brainId);
  if (!wallet || access.reason === "signed_out") return Response.json({ error: "Sign in with your wallet first" }, { status: 401 });
  if (!access.ok) return Response.json({ error: "A valid seat is required for real-time picks", reason: access.reason }, { status: 403 });

  const encoder = new TextEncoder();
  const signal = req.signal;
  let timers: NodeJS.Timeout[] = [];
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        for (const t of timers) clearInterval(t);
        timers = [];
        try {
          controller.close();
        } catch {}
      };
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          close();
        }
      };
      signal.addEventListener("abort", close);

      let maxId = 0;
      /** Last updated_at sent per pick; a pick is re-sent when the runner writes it again. */
      const sent = new Map<number, number>();
      let since = 0;
      const push = (rows: (typeof schema.brainPicks.$inferSelect)[]) => {
        const now = Math.floor(Date.now() / 1000);
        for (const r of rows) {
          maxId = Math.max(maxId, r.id);
          since = Math.max(since, r.updatedAt);
          if (sent.get(r.id) === r.updatedAt) continue;
          sent.set(r.id, r.updatedAt);
          write(`event: pick\ndata: ${JSON.stringify(pickDTO(r, false, now))}\n\n`);
        }
      };

      try {
        write("retry: 3000\n\n");
        push((await db.select().from(schema.brainPicks).where(eq(schema.brainPicks.brainId, brainId)).orderBy(desc(schema.brainPicks.id)).limit(BACKLOG)).reverse());
      } catch (err) {
        console.error(`[picks/stream] ${brainId}: ${err instanceof Error ? err.message : err}`);
        close();
        return;
      }

      let polling = false;
      timers.push(
        setInterval(async () => {
          if (closed || polling) return;
          polling = true;
          try {
            // updated_at has 1 s resolution: re-read the last second; `sent` drops what was already delivered
            const rows = await db
              .select()
              .from(schema.brainPicks)
              .where(and(eq(schema.brainPicks.brainId, brainId), or(gt(schema.brainPicks.id, maxId), gte(schema.brainPicks.updatedAt, since))))
              .orderBy(schema.brainPicks.id)
              .limit(500);
            push(rows);
          } catch (err) {
            console.error(`[picks/stream] ${brainId}: ${err instanceof Error ? err.message : err}`);
          } finally {
            polling = false;
          }
        }, POLL_MS),
        setInterval(() => write(": ping\n\n"), HEARTBEAT_MS),
        setInterval(async () => {
          const again = await hasBrainAccess(wallet, brainId).catch(() => null);
          if (again && !again.ok) close();
        }, ACCESS_RECHECK_MS),
      );
    },
    cancel() {
      closed = true;
      for (const t of timers) clearInterval(t);
      timers = [];
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
