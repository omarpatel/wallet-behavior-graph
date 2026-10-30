import { setTimeout as sleep } from "node:timers/promises";
import { and, eq, gte } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { orderDTO } from "@/server/agents/queries";
import { requestCloseAll } from "@/server/agents/service";
import { withApi } from "@/server/auth/http";
import { requireSession } from "@/server/auth/session";

const WAIT_MS = 30_000;

/**
 * Sell every open position. The agents runner is the only executor (no double-sell race with its own exits), so this
 * flags the agent and waits up to 30 s for the sells → `{ orders: AgentOrderDTO[], pending }`; pending = positions
 * still open (their orders keep going and arrive on the SSE stream).
 */
export async function POST(_req: Request, ctx: RouteContext<"/api/agents/[id]/close-all">) {
  return withApi(async () => {
    const { wallet } = await requireSession();
    const { id } = await ctx.params;
    const at = await requestCloseAll(id, wallet);
    const db = getDb();
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const open = await db
        .select({ mint: schema.agentPositions.mint })
        .from(schema.agentPositions)
        .where(and(eq(schema.agentPositions.agentId, id), eq(schema.agentPositions.status, "open")));
      if (!open.length || Date.now() > deadline) {
        const orders = await db
          .select()
          .from(schema.agentOrders)
          .where(and(eq(schema.agentOrders.agentId, id), eq(schema.agentOrders.side, "sell"), gte(schema.agentOrders.createdAt, at)));
        return Response.json({ orders: orders.map(orderDTO), pending: open.length > 0 });
      }
      await sleep(1_500);
    }
  })();
}
