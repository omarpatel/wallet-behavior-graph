import { withdraw } from "@/server/agents/funds";
import { ownedAgent } from "@/server/agents/service";
import { HttpError, readJson, withApi } from "@/server/auth/http";
import { requireSession } from "@/server/auth/session";

/**
 * `{ lamports: number | 'all' }` → `{ signature, lamports }`. Always allowed (any status/mode), only ever to the owner
 * wallet. Sells nothing: close positions first (POST …/close-all) to withdraw their value.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/agents/[id]/withdraw">) {
  return withApi(async () => {
    const { wallet } = await requireSession();
    const { id } = await ctx.params;
    const b = await readJson(req);
    const request = b.lamports === "all" ? "all" : typeof b.lamports === "number" && Number.isInteger(b.lamports) && b.lamports > 0 ? b.lamports : null;
    if (request == null) throw new HttpError(400, "lamports must be a positive integer or 'all'");
    const agent = await ownedAgent(id, wallet);
    return Response.json(await withdraw(agent, request));
  })();
}
