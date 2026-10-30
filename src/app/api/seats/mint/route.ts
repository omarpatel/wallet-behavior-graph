import { readJson, withApi } from "@/server/auth/http";
import { requireSession } from "@/server/auth/session";
import { buildMintAction } from "@/server/solana/actions";

/** `{ brainId }`: reserve the next seat and build the mint tx → `{ actionId, transaction }` (base64 unsigned tx; sign with the wallet, then POST /api/actions/submit). */
export const POST = withApi(async (req: Request) => {
  const { wallet } = await requireSession();
  const body = await readJson(req);
  return Response.json(await buildMintAction(wallet, String(body.brainId ?? "")));
});
