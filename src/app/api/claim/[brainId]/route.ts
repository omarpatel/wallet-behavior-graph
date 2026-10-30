import { readJson, withApi } from "@/server/auth/http";
import { requireSession } from "@/server/auth/session";
import { claimBrain } from "@/server/solana/claim";

/** Claim a brain with its own wallet session. Body: `{ payoutWallet? }` (defaults to the brain wallet). */
export const POST = withApi(async (req: Request, { params }: { params: Promise<{ brainId: string }> }) => {
  const { brainId } = await params;
  const { wallet } = await requireSession();
  const body = await readJson(req);
  const result = await claimBrain(brainId, wallet, body.payoutWallet);
  return Response.json({ ok: true, ...result });
});
