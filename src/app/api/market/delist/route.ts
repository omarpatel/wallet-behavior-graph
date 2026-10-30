import { readJson, withApi } from "@/server/auth/http";
import { requireSession } from "@/server/auth/session";
import { buildDelistAction } from "@/server/solana/actions";

/** `{ listingId }`: build the delist tx (transaction null when the listing was simply cancelled) → `{ actionId, transaction }` (base64 unsigned tx; sign with the wallet, then POST /api/actions/submit). */
export const POST = withApi(async (req: Request) => {
  const { wallet } = await requireSession();
  const body = await readJson(req);
  return Response.json(await buildDelistAction(wallet, body.listingId));
});
