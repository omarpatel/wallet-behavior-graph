import "server-only";
import { asc, desc, sql } from "drizzle-orm";
import { connection } from "next/server";
import { getDb, schema } from "@/db/client";
import type { BrainTier, Provenance } from "@/db/schema";

const { brains, seats, disputes } = schema;

export interface AdminBrainRow {
  id: string;
  wallet: string;
  codename: string;
  displayName: string | null;
  provenance: Provenance;
  status: "unclaimed" | "claimed";
  tier: BrainTier;
  trackScore: number | null;
  listed: boolean;
  priceOverride: boolean;
  seatSupply: number;
  seatsMinted: number;
  seatPriceLamports: number;
  renewalPriceLamports: number;
  alertDelaySec: number;
  revenueHeld: boolean;
  revenueHeldReason: string | null;
  backfillStatus: "pending" | "running" | "done" | "error";
  backfillError: string | null;
}

export interface AdminDispute {
  id: number;
  brainId: string | null;
  contact: string;
  kind: "correction" | "opt_out" | "other";
  message: string;
  status: "open" | "resolved";
  createdAt: number;
}

export async function getAdmin(): Promise<{ brains: AdminBrainRow[]; disputes: AdminDispute[]; now: number }> {
  await connection();
  const db = getDb();
  const [rows, ds] = await Promise.all([
    db
      .select({
        id: brains.id,
        wallet: brains.wallet,
        codename: brains.codename,
        displayName: brains.displayName,
        provenance: brains.provenance,
        status: brains.status,
        tier: brains.tier,
        trackScore: brains.trackScore,
        listed: brains.listed,
        priceOverride: brains.priceOverride,
        seatSupply: brains.seatSupply,
        seatsMinted: sql<number>`(select count(*) from ${seats} where ${seats.brainId} = ${brains.id})`.mapWith(Number),
        seatPriceLamports: brains.seatPriceLamports,
        renewalPriceLamports: brains.renewalPriceLamports,
        alertDelaySec: brains.alertDelaySec,
        revenueHeld: brains.revenueHeld,
        revenueHeldReason: brains.revenueHeldReason,
        backfillStatus: brains.backfillStatus,
        backfillError: brains.backfillError,
      })
      .from(brains)
      .orderBy(desc(brains.revenueHeld), asc(brains.codename)),
    db
      .select()
      .from(disputes)
      .orderBy(sql`case when ${disputes.status} = 'open' then 0 else 1 end`, desc(disputes.createdAt))
      .limit(200),
  ]);
  return { brains: rows, disputes: ds, now: Math.floor(Date.now() / 1000) };
}
