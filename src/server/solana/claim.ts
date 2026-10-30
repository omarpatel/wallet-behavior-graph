// KOL claim + accrued revenue payout queue.
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { HttpError } from "@/server/auth/http";
import { updateCollectionRoyaltiesForClaim } from "./collection";
import { isValidAddress } from "./umi";

const { brains, ledger, kolPayouts } = schema;

/**
 * Accrued KOL lamports (ledger rows not paid inline) minus payouts already pending or sent.
 * Queues the difference as a pending kol_payouts row. Returns the queued amount (0 if nothing new).
 */
export async function queueKolPayout(brainId: string): Promise<number> {
  const db = getDb();
  const brain = await db.query.brains.findFirst({ where: eq(brains.id, brainId) });
  if (!brain || brain.status !== "claimed" || !brain.kolPayoutWallet) return 0;
  const [accrued] = await db
    .select({ v: sql<number>`coalesce(sum(${ledger.kolLamports}), 0)` })
    .from(ledger)
    .where(and(eq(ledger.brainId, brainId), eq(ledger.kolPaidInline, false)));
  const [queued] = await db
    .select({ v: sql<number>`coalesce(sum(${kolPayouts.amountLamports}), 0)` })
    .from(kolPayouts)
    .where(and(eq(kolPayouts.brainId, brainId), inArray(kolPayouts.status, ["pending", "sent"])));
  const due = Number(accrued.v) - Number(queued.v);
  if (due <= 0) return 0;
  await db.insert(kolPayouts).values({ brainId, wallet: brain.kolPayoutWallet, amountLamports: due });
  return due;
}

export interface ClaimResult {
  brainId: string;
  accruedLamports: number;
  royaltiesSignature: string | null;
  royaltiesError: string | null;
}

/** Claim by the brain wallet itself (SIWS session): self-verified provenance, revenue share switched on. */
export async function claimBrain(brainId: string, wallet: string, payoutWallet?: unknown): Promise<ClaimResult> {
  const db = getDb();
  const brain = await db.query.brains.findFirst({ where: eq(brains.id, brainId) });
  if (!brain) throw new HttpError(404, "Brain not found");
  if (brain.wallet !== wallet) throw new HttpError(403, "Sign in with the brain's own wallet to claim it");
  if (payoutWallet !== undefined && payoutWallet !== null && !isValidAddress(payoutWallet)) {
    throw new HttpError(400, "payoutWallet is not a valid Solana address");
  }
  const payout = (payoutWallet as string | undefined) ?? brain.kolPayoutWallet ?? wallet;
  const payoutChanged = payout !== brain.kolPayoutWallet;
  await db
    .update(brains)
    .set({
      status: "claimed",
      provenance: "self_verified",
      kolPayoutWallet: payout,
      claimedAt: brain.claimedAt ?? Math.floor(Date.now() / 1000),
    })
    .where(eq(brains.id, brainId));

  let royaltiesSignature: string | null = null;
  let royaltiesError: string | null = null;
  if (brain.collectionAddress && (brain.status !== "claimed" || payoutChanged)) {
    try {
      royaltiesSignature = await updateCollectionRoyaltiesForClaim(brainId);
    } catch (e) {
      // Not fatal: until royalties are updated, the KOL half of secondary royalties accrues in the ledger.
      royaltiesError = e instanceof Error ? e.message : String(e);
      console.error(`royalty update for ${brainId} failed:`, e);
    }
  }
  const accruedLamports = await queueKolPayout(brainId);
  return { brainId, accruedLamports, royaltiesSignature, royaltiesError };
}
