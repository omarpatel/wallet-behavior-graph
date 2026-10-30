import { connection } from "next/server";
import { getAgentDetail } from "@/server/agents/queries";
import { patchAgent } from "@/server/agents/service";
import type { StrategyOverrides } from "@/server/agents/types";
import { HttpError, readJson, withApi } from "@/server/auth/http";
import { getSession, requireSession } from "@/server/auth/session";

/** AgentDetailDTO. Public read-only for non-owners (ledger omitted, fresh swarm-informed entries held back). */
export async function GET(_req: Request, ctx: RouteContext<"/api/agents/[id]">) {
  return withApi(async () => {
    await connection();
    const { id } = await ctx.params;
    const viewer = (await getSession())?.wallet ?? null;
    const detail = await getAgentDetail(id, viewer);
    if (!detail) throw new HttpError(404, "Agent not found");
    return Response.json(detail);
  })();
}

/**
 * `{ status?: 'running'|'paused', mode?: 'paper'|'live', useLlm?, strategyOverrides?, acknowledgeCustodialRisk? }`
 * → AgentDTO. Owner only. mode→live needs AGENTS_LIVE_ENABLED and acknowledgeCustodialRisk: true.
 */
export async function PATCH(req: Request, ctx: RouteContext<"/api/agents/[id]">) {
  return withApi(async () => {
    const { wallet } = await requireSession();
    const { id } = await ctx.params;
    const b = await readJson(req);
    if (b.status !== undefined && b.status !== "running" && b.status !== "paused") throw new HttpError(400, "status must be 'running' or 'paused'");
    if (b.mode !== undefined && b.mode !== "paper" && b.mode !== "live") throw new HttpError(400, "mode must be 'paper' or 'live'");
    if (b.useLlm !== undefined && typeof b.useLlm !== "boolean") throw new HttpError(400, "useLlm must be a boolean");
    if (b.strategyOverrides !== undefined && (typeof b.strategyOverrides !== "object" || b.strategyOverrides === null))
      throw new HttpError(400, "strategyOverrides must be an object");
    return Response.json(
      await patchAgent(id, wallet, {
        status: b.status,
        mode: b.mode,
        useLlm: b.useLlm,
        strategyOverrides: b.strategyOverrides as StrategyOverrides | undefined,
        acknowledgeCustodialRisk: b.acknowledgeCustodialRisk === true,
      }),
    );
  })();
}
