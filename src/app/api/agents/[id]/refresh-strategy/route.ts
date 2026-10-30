import { refreshStrategy } from "@/server/agents/service";
import { withApi } from "@/server/auth/http";
import { requireSession } from "@/server/auth/session";

/** Re-derive the strategy from the brain's latest profile (owner overrides kept) → AgentDTO. */
export async function POST(_req: Request, ctx: RouteContext<"/api/agents/[id]/refresh-strategy">) {
  return withApi(async () => {
    const { wallet } = await requireSession();
    const { id } = await ctx.params;
    return Response.json(await refreshStrategy(id, wallet));
  })();
}
