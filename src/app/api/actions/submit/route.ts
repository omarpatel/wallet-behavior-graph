import { readJson, withApi } from "@/server/auth/http";
import { requireSession } from "@/server/auth/session";
import { submitAction } from "@/server/solana/actions";

/** `{ actionId, signedTransaction }` → validate intent, co-sign, send, confirm → `{ signature, kind, asset? }`. */
export const POST = withApi(async (req: Request) => {
  const { wallet } = await requireSession();
  const body = await readJson(req);
  return Response.json(await submitAction(body.actionId, body.signedTransaction, wallet));
});
