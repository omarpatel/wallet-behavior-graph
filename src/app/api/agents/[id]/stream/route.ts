import { and, desc, eq, gt } from "drizzle-orm";
import { connection } from "next/server";
import { getDb, schema } from "@/db/client";
import { agentDTO, decisionDTO, hiddenFromPublic, latestSolUsd, orderDTO, positionDTO } from "@/server/agents/queries";
import { getSession } from "@/server/auth/session";

const POLL_MS = 2_000;
const AGENT_EVERY_MS = 10_000;
const HEARTBEAT_MS = 15_000;

/**
 * Public SSE for one agent (the DB is the bus; the runner writes, this polls every 2 s):
 *   event: decision  AgentDecisionDTO   (backlog: newest 30)
 *   event: order     AgentOrderDTO      (backlog: newest 20; re-sent when its status changes)
 *   event: position  AgentPositionDTO   (on every trade, and marks of open positions every 10 s)
 *   event: agent     AgentDTO           (status / equity, when changed, checked every 10 s)
 * Non-owners don't receive swarm-informed decisions (and their orders) until PUBLIC_DELAY_SEC has passed.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/agents/[id]/stream">) {
  await connection();
  const { id } = await ctx.params;
  const first = await agentDTO(id);
  if (!first) return Response.json({ error: "Agent not found" }, { status: 404 });
  const isOwner = (await getSession())?.wallet === first.owner;
  const db = getDb();
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
      const send = (event: string, data: unknown, eventId?: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\n${eventId ? `id: ${eventId}\n` : ""}data: ${JSON.stringify(data)}\n\n`));
        } catch {
          close();
        }
      };
      signal.addEventListener("abort", close);

      let decisionCursor = 0;
      let orderCursor = 0;
      const orderStatus = new Map<number, string>();
      const hiddenDecisions = new Set<number>();
      let positionCursor = 0;
      let lastAgent = "";

      const pushDecisions = (rows: (typeof schema.agentDecisions.$inferSelect)[]) => {
        const now = Math.floor(Date.now() / 1000);
        for (const d of rows) {
          decisionCursor = Math.max(decisionCursor, d.id);
          if (!isOwner && hiddenFromPublic(d, now)) {
            hiddenDecisions.add(d.id);
            continue;
          }
          send("decision", decisionDTO(d), `d${d.id}`);
        }
      };
      const pushOrder = (o: typeof schema.agentOrders.$inferSelect) => {
        orderCursor = Math.max(orderCursor, o.id);
        if (o.decisionId != null && hiddenDecisions.has(o.decisionId)) return;
        if (orderStatus.get(o.id) === o.status) return;
        orderStatus.set(o.id, o.status);
        send("order", orderDTO(o), `o${o.id}`);
      };
      const pushPositions = async (all: boolean) => {
        const rows = await db
          .select()
          .from(schema.agentPositions)
          .where(all ? and(eq(schema.agentPositions.agentId, id), eq(schema.agentPositions.status, "open")) : and(eq(schema.agentPositions.agentId, id), gt(schema.agentPositions.lastTradeAt, positionCursor)));
        if (!rows.length) return;
        const solUsd = await latestSolUsd();
        for (const p of rows) {
          positionCursor = Math.max(positionCursor, p.lastTradeAt);
          send("position", positionDTO(p, solUsd));
        }
      };
      const pushAgent = async () => {
        const a = await agentDTO(id);
        if (!a) return close();
        const key = JSON.stringify([a.status, a.haltedReason, a.mode, a.equityLamports, a.openPositions, a.trades, a.balanceLamports, a.markedAt]);
        if (key !== lastAgent) {
          lastAgent = key;
          send("agent", a);
        }
      };

      try {
        controller.enqueue(encoder.encode("retry: 3000\n\n"));
        await pushAgent();
        pushDecisions((await db.select().from(schema.agentDecisions).where(eq(schema.agentDecisions.agentId, id)).orderBy(desc(schema.agentDecisions.id)).limit(30)).reverse());
        for (const o of (await db.select().from(schema.agentOrders).where(eq(schema.agentOrders.agentId, id)).orderBy(desc(schema.agentOrders.id)).limit(20)).reverse()) pushOrder(o);
        await pushPositions(true);
      } catch (err) {
        console.error(`[agents/stream] ${err instanceof Error ? err.message : err}`);
        close();
        return;
      }

      let polling = false;
      timers.push(
        setInterval(async () => {
          if (closed || polling) return;
          polling = true;
          try {
            pushDecisions(await db.select().from(schema.agentDecisions).where(and(eq(schema.agentDecisions.agentId, id), gt(schema.agentDecisions.id, decisionCursor))).orderBy(schema.agentDecisions.id).limit(200));
            // new orders + orders still in flight (status changes)
            const recent = await db.select().from(schema.agentOrders).where(eq(schema.agentOrders.agentId, id)).orderBy(desc(schema.agentOrders.id)).limit(20);
            for (const o of recent.reverse()) if (o.id > orderCursor || orderStatus.has(o.id)) pushOrder(o);
            await pushPositions(false);
          } catch (err) {
            console.error(`[agents/stream] ${err instanceof Error ? err.message : err}`);
          } finally {
            polling = false;
          }
        }, POLL_MS),
        setInterval(() => {
          void pushAgent().catch(() => undefined);
          void pushPositions(true).catch(() => undefined);
        }, AGENT_EVERY_MS),
        setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            close();
          }
        }, HEARTBEAT_MS),
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
