import { and, asc, desc, eq, gt, inArray, isNotNull, lte } from "drizzle-orm";
import { connection } from "next/server";
import { getDb } from "@/db/client";
import { alerts, brains } from "@/db/schema";
import { hasBrainAccess } from "@/server/access";
import type { AlertDTO, AlertFacts } from "@/server/alerts/types";
import { getSession } from "@/server/auth/session";

const POLL_MS = 2_000;
const HEARTBEAT_MS = 15_000;
const ACCESS_RECHECK_MS = 60_000;
const BACKLOG = 20;
const SCAN = 200;
/** Explanations are only generated for alerts created in the last 2h; stop watching after that. */
const EXPLAIN_WATCH_SEC = 2 * 3600;

type AlertRow = typeof alerts.$inferSelect;

function toDTO(a: AlertRow): AlertDTO {
  return {
    id: a.id,
    brainId: a.brainId,
    headline: a.headline,
    facts: JSON.parse(a.factsJson) as AlertFacts,
    explanation: a.explanation,
    publishAt: a.publishAt,
  };
}

/**
 * Seat-gated SSE feed of a brain's alerts. The DB is the bus: every 2s we read alerts above the
 * cursor. The cursor is the highest id below which every alert has been published, so alerts whose
 * publishAt lies in the future (alertDelaySec) are delivered later even if newer ids went out first.
 * The SSE `id:` field carries that cursor (≤ the sent alert's id); clients dedupe by AlertDTO.id.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/brains/[id]/stream">) {
  await connection();
  const { id: brainId } = await ctx.params;
  const db = getDb();

  const [brain] = await db.select({ id: brains.id }).from(brains).where(eq(brains.id, brainId)).limit(1);
  if (!brain) return Response.json({ error: "Brain not found" }, { status: 404 });

  const session = await getSession();
  const wallet = session?.wallet ?? null;
  const access = await hasBrainAccess(wallet, brainId);
  if (!wallet || access.reason === "signed_out") {
    return Response.json({ error: "Sign in with your wallet first" }, { status: 401 });
  }
  if (!access.ok) {
    return Response.json({ error: "A valid seat is required for live alerts", reason: access.reason }, { status: 403 });
  }

  const lastEventId = Number(req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("lastEventId"));
  const resumeFrom = Number.isInteger(lastEventId) && lastEventId >= 0 ? lastEventId : null;

  const encoder = new TextEncoder();
  const signal = req.signal;
  let timers: NodeJS.Timeout[] = [];
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          close();
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        for (const t of timers) clearInterval(t);
        timers = [];
        signal.removeEventListener("abort", close);
        try {
          controller.close();
        } catch {}
      };
      signal.addEventListener("abort", close);

      let cursor = 0;
      const sent = new Set<number>(); // ids > cursor already delivered
      const awaitingExplanation = new Map<number, number>(); // id → createdAt

      const send = (event: "alert" | "alert-update", a: AlertRow) => {
        write(`event: ${event}\nid: ${cursor}\ndata: ${JSON.stringify(toDTO(a))}\n\n`);
        if (a.explanation == null) awaitingExplanation.set(a.id, a.createdAt);
        else awaitingExplanation.delete(a.id);
      };

      /** Deliver published alerts above the cursor and advance it past the contiguous published run. */
      const scan = async () => {
        const now = Math.floor(Date.now() / 1000);
        const rows = await db
          .select()
          .from(alerts)
          .where(and(eq(alerts.brainId, brainId), gt(alerts.id, cursor)))
          .orderBy(asc(alerts.id))
          .limit(SCAN);
        let floorBlocked = false;
        for (const a of rows) {
          if (a.publishAt > now) {
            floorBlocked = true;
            continue;
          }
          if (!floorBlocked) cursor = a.id;
          if (sent.has(a.id)) continue;
          sent.add(a.id);
          send("alert", a);
        }
        for (const id of sent) if (id <= cursor) sent.delete(id);
      };

      const refreshExplanations = async () => {
        const now = Math.floor(Date.now() / 1000);
        for (const [id, createdAt] of awaitingExplanation) {
          if (createdAt < now - EXPLAIN_WATCH_SEC) awaitingExplanation.delete(id);
        }
        if (!awaitingExplanation.size) return;
        const filled = await db
          .select()
          .from(alerts)
          .where(and(inArray(alerts.id, [...awaitingExplanation.keys()]), isNotNull(alerts.explanation)));
        for (const a of filled) send("alert-update", a);
      };

      try {
        write(`retry: 3000\n\n`);
        if (resumeFrom != null) {
          cursor = resumeFrom;
        } else {
          const now = Math.floor(Date.now() / 1000);
          const backlog = await db
            .select()
            .from(alerts)
            .where(and(eq(alerts.brainId, brainId), lte(alerts.publishAt, now)))
            .orderBy(desc(alerts.publishAt), desc(alerts.id))
            .limit(BACKLOG);
          // Start the cursor below the oldest still-unpublished alert (or at the newest id).
          const [pendingRow] = await db
            .select({ id: alerts.id })
            .from(alerts)
            .where(and(eq(alerts.brainId, brainId), gt(alerts.publishAt, now)))
            .orderBy(asc(alerts.id))
            .limit(1);
          const [newest] = await db
            .select({ id: alerts.id })
            .from(alerts)
            .where(eq(alerts.brainId, brainId))
            .orderBy(desc(alerts.id))
            .limit(1);
          cursor = pendingRow ? pendingRow.id - 1 : (newest?.id ?? 0);
          for (const a of backlog.reverse()) {
            if (a.id > cursor) sent.add(a.id);
            send("alert", a);
          }
        }
        await scan();
      } catch (err) {
        console.error(`[stream] ${brainId}: ${err instanceof Error ? err.message : err}`);
        close();
        return;
      }

      let polling = false;
      timers.push(
        setInterval(async () => {
          if (closed || polling) return;
          polling = true;
          try {
            await scan();
            await refreshExplanations();
          } catch (err) {
            console.error(`[stream] ${brainId}: ${err instanceof Error ? err.message : err}`);
          } finally {
            polling = false;
          }
        }, POLL_MS),
        setInterval(() => write(`: ping\n\n`), HEARTBEAT_MS),
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
