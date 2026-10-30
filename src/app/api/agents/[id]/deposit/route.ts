import { depositInfo, relayDeposit } from "@/server/agents/funds";
import { ownedAgent } from "@/server/agents/service";
import { HttpError, readJson, withApi } from "@/server/auth/http";
import { requireSession } from "@/server/auth/session";

/** Owner: AgentDepositInfoDTO (agent wallet, mainnet blockhash, deposit limit left) to build a SystemProgram transfer. */
export async function GET(_req: Request, ctx: RouteContext<"/api/agents/[id]/deposit">) {
  return withApi(async () => {
    const { wallet } = await requireSession();
    const { id } = await ctx.params;
    return Response.json(await depositInfo(await ownedAgent(id, wallet)));
  })();
}

/**
 * `{ signedTransaction: base64 }` signed by the owner's wallet: verified (single SOL transfer owner → agent wallet,
 * ≤ remaining limit), relayed to mainnet, confirmed, recorded → `{ signature, lamports }`.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/agents/[id]/deposit">) {
  return withApi(async () => {
    const { wallet } = await requireSession();
    const { id } = await ctx.params;
    const b = await readJson(req);
    if (typeof b.signedTransaction !== "string" || !b.signedTransaction) throw new HttpError(400, "signedTransaction (base64) is required");
    return Response.json(await relayDeposit(await ownedAgent(id, wallet), wallet, b.signedTransaction));
  })();
}
