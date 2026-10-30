import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { connection } from "next/server";
import { getDb, schema } from "@/db/client";
import type { BrainTier } from "@/db/schema";
import { faceColumns, nowSec, type BrainFace } from "./shared";

const { brains, seats, listings, ledger, kolPayouts } = schema;

export interface MySeat extends BrainFace {
  asset: string;
  number: number;
  expiresAt: number;
  mintedAt: number;
  brainId: string;
  tier: BrainTier;
  termDays: number;
  renewalPriceLamports: number;
  seatSupply: number;
  listing: { id: string; priceLamports: number; status: "pending" | "active" } | null;
}

export async function getMySeats(wallet: string): Promise<{ seats: MySeat[]; now: number }> {
  await connection();
  const db = getDb();
  const rows = await db
    .select({
      asset: seats.asset,
      number: seats.number,
      expiresAt: seats.expiresAt,
      mintedAt: seats.mintedAt,
      ...faceColumns,
      tier: brains.tier,
      termDays: brains.termDays,
      renewalPriceLamports: brains.renewalPriceLamports,
      seatSupply: brains.seatSupply,
    })
    .from(seats)
    .innerJoin(brains, eq(brains.id, seats.brainId))
    .where(eq(seats.owner, wallet))
    .orderBy(desc(seats.expiresAt));

  const assets = rows.map((r) => r.asset);
  const open = assets.length
    ? await db
        .select({ id: listings.id, asset: listings.asset, priceLamports: listings.priceLamports, status: listings.status })
        .from(listings)
        .where(and(inArray(listings.asset, assets), eq(listings.seller, wallet), inArray(listings.status, ["pending", "active"])))
        .orderBy(desc(listings.createdAt))
    : [];
  const byAsset = new Map<string, MySeat["listing"]>();
  for (const l of open) {
    if (!byAsset.has(l.asset)) byAsset.set(l.asset, { id: l.id, priceLamports: l.priceLamports, status: l.status as "pending" | "active" });
  }
  return { seats: rows.map((r) => ({ ...r, listing: byAsset.get(r.asset) ?? null })), now: nowSec() };
}

export interface MyListing {
  id: string;
  asset: string;
  priceLamports: number;
  status: "pending" | "active" | "sold" | "cancelled";
  buyer: string | null;
  saleSignature: string | null;
  updatedAt: number;
  seatNumber: number;
  brainId: string;
  brain: BrainFace;
}

export async function getMyListings(wallet: string, limit = 50): Promise<MyListing[]> {
  await connection();
  return getDb()
    .select({
      id: listings.id,
      asset: listings.asset,
      priceLamports: listings.priceLamports,
      status: listings.status,
      buyer: listings.buyer,
      saleSignature: listings.saleSignature,
      updatedAt: listings.updatedAt,
      seatNumber: seats.number,
      brainId: brains.id,
      brain: faceColumns,
    })
    .from(listings)
    .innerJoin(seats, eq(seats.asset, listings.asset))
    .innerJoin(brains, eq(brains.id, listings.brainId))
    .where(eq(listings.seller, wallet))
    .orderBy(desc(listings.updatedAt))
    .limit(limit);
}

export type LedgerKind = "primary" | "renewal" | "royalty";

export interface OwnerBrainSummary extends BrainFace {
  id: string;
  claimedAt: number | null;
  xLinked: boolean;
  kolShareBps: number;
  royaltyBps: number;
  alertDelaySec: number;
  revenueHeld: boolean;
  revenueHeldReason: string | null;
  kolPayoutWallet: string | null;
  /** KOL share per ledger kind, split into paid inline at sale time vs accrued for a later payout. */
  totals: Record<LedgerKind, { count: number; grossLamports: number; kolInlineLamports: number; kolAccruedLamports: number }>;
  payouts: { id: number; amountLamports: number; status: "pending" | "sent" | "failed"; signature: string | null; error: string | null; createdAt: number }[];
}

/** Brains whose wallet is the signed-in wallet (claimed or claimable). */
export async function getKolDashboard(wallet: string): Promise<OwnerBrainSummary[]> {
  await connection();
  const db = getDb();
  const own = await db.select().from(brains).where(eq(brains.wallet, wallet));
  if (own.length === 0) return [];
  const ids = own.map((b) => b.id);
  const [totals, payouts] = await Promise.all([
    db
      .select({
        brainId: ledger.brainId,
        kind: ledger.kind,
        count: sql<number>`count(*)`.mapWith(Number),
        gross: sql<number>`coalesce(sum(${ledger.amountLamports}), 0)`.mapWith(Number),
        inline: sql<number>`coalesce(sum(case when ${ledger.kolPaidInline} = 1 then ${ledger.kolLamports} else 0 end), 0)`.mapWith(Number),
        accrued: sql<number>`coalesce(sum(case when ${ledger.kolPaidInline} = 0 then ${ledger.kolLamports} else 0 end), 0)`.mapWith(Number),
      })
      .from(ledger)
      .where(and(inArray(ledger.brainId, ids), inArray(ledger.kind, ["primary", "renewal", "royalty"])))
      .groupBy(ledger.brainId, ledger.kind),
    db.select().from(kolPayouts).where(inArray(kolPayouts.brainId, ids)).orderBy(desc(kolPayouts.createdAt)).limit(100),
  ]);

  return own.map((b) => {
    const empty = () => ({ count: 0, grossLamports: 0, kolInlineLamports: 0, kolAccruedLamports: 0 });
    const t: OwnerBrainSummary["totals"] = { primary: empty(), renewal: empty(), royalty: empty() };
    for (const r of totals) {
      if (r.brainId !== b.id || !(r.kind in t)) continue;
      t[r.kind as LedgerKind] = { count: r.count, grossLamports: r.gross, kolInlineLamports: r.inline, kolAccruedLamports: r.accrued };
    }
    return {
      id: b.id,
      brainId: b.id,
      codename: b.codename,
      displayName: b.displayName,
      xHandle: b.xHandle,
      provenance: b.provenance,
      status: b.status,
      avatarUrl: b.status === "claimed" ? b.avatarUrl : null,
      publicAvatarUrl: b.publicAvatarUrl,
      claimedAt: b.claimedAt,
      xLinked: !!b.xUserId,
      kolShareBps: b.kolShareBps,
      royaltyBps: b.royaltyBps,
      alertDelaySec: b.alertDelaySec,
      revenueHeld: b.revenueHeld,
      revenueHeldReason: b.revenueHeldReason,
      kolPayoutWallet: b.kolPayoutWallet,
      totals: t,
      payouts: payouts
        .filter((p) => p.brainId === b.id)
        .map((p) => ({ id: p.id, amountLamports: p.amountLamports, status: p.status, signature: p.signature, error: p.error, createdAt: p.createdAt })),
    };
  });
}
