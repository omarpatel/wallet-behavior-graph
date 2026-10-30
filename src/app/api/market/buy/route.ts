import { readJson, withApi } from "@/server/auth/http";
import { requireSession } from "@/server/auth/session";
import { buildBuyAction } from "@/server/solana/actions";

/** `{ listingId }`: build the atomic buy tx → `{ actionId, transaction }` (base64 unsigned tx; sign with the wallet, then POST /api/actions/submit). */
export const POST = withApi(async (req: Request) => {
  const { wallet } = await requireSession();
  const body = await readJson(req);
  return Response.json(await buildBuyAction(wallet, body.listingId));
});
