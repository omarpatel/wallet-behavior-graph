import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { connection } from "next/server";
import { getDb, schema } from "@/db/client";
import type { BrainTier } from "@/db/schema";
import { getRecentSales, type SaleRow } from "./brains";
import { brainTitle } from "@/lib/identity";
import { nowSec, type BrainFace, type BrainIdentity } from "./shared";

const { brains, seats, listings } = schema;

export interface MarketListing {
  id: string;
  asset: string;
  seller: string;
  priceLamports: number;
  seatNumber: number;
  expiresAt: number;
  createdAt: number;
  brain: BrainIdentity & {
    tier: BrainTier;
    seatSupply: number;
    seatPriceLamports: number;
    renewalPriceLamports: number;
    termDays: number;
  };
}

export interface LowestListing extends BrainFace {
  brainId: string;
  tier: BrainTier;
  activeListings: number;
  lowestLamports: number;
  mintPriceLamports: number;
  seatsLeft: number;
}

export interface MarketData {
  listings: MarketListing[];
  sales: SaleRow[];
  lowest: LowestListing[];
  now: number;
}

export async function getMarket(brainId?: string): Promise<MarketData> {
  await connection();
  const db = getDb();
  const where = brainId
    ? and(eq(listings.status, "active"), eq(listings.brainId, brainId))
    : eq(listings.status, "active");
  const [rows, sales] = await Promise.all([
    db
      .select({
        id: listings.id,
        asset: listings.asset,
        seller: listings.seller,
        priceLamports: listings.priceLamports,
        createdAt: listings.createdAt,
        seatNumber: seats.number,
        expiresAt: seats.expiresAt,
        b: {
          id: brains.id,
          brainId: brains.id,
          wallet: brains.wallet,
          codename: brains.codename,
          displayName: brains.displayName,
          xHandle: brains.xHandle,
          provenance: brains.provenance,
          provenanceSource: brains.provenanceSource,
          status: brains.status,
          avatarUrl: brains.avatarUrl,
          publicAvatarUrl: brains.publicAvatarUrl,
          tier: brains.tier,
          seatSupply: brains.seatSupply,
          renewalPriceLamports: brains.renewalPriceLamports,
          termDays: brains.termDays,
          seatPriceLamports: brains.seatPriceLamports,
        },
      })
      .from(listings)
      .innerJoin(seats, eq(seats.asset, listings.asset))
      .innerJoin(brains, eq(brains.id, listings.brainId))
      .where(where)
      .orderBy(asc(listings.priceLamports), asc(listings.createdAt))
      .limit(200),
    getRecentSales(20).then((r) => r.sales),
  ]);

  const brainIds = [...new Set(rows.map((r) => r.b.id))];
  const minted = brainIds.length
    ? await db
        .select({ brainId: seats.brainId, n: sql<number>`count(*)`.mapWith(Number) })
        .from(seats)
        .where(inArray(seats.brainId, brainIds))
        .groupBy(seats.brainId)
    : [];
  const mintedBy = new Map(minted.map((m) => [m.brainId, m.n]));

  const lowestBy = new Map<string, LowestListing>();
  for (const r of rows) {
    const cur = lowestBy.get(r.b.id);
    if (cur) {
      cur.activeListings += 1;
      cur.lowestLamports = Math.min(cur.lowestLamports, r.priceLamports);
    } else {
      const { id, codename, displayName, xHandle, provenance, status, avatarUrl, publicAvatarUrl, tier } = r.b;
      lowestBy.set(id, {
        brainId: id,
        codename,
        displayName,
        xHandle,
        provenance,
        status,
        avatarUrl: status === "claimed" ? avatarUrl : null,
        publicAvatarUrl,
        tier,
        activeListings: 1,
        lowestLamports: r.priceLamports,
        mintPriceLamports: r.b.seatPriceLamports,
        seatsLeft: Math.max(0, r.b.seatSupply - (mintedBy.get(r.b.id) ?? 0)),
      });
    }
  }

  return {
    listings: rows.map(({ b, ...l }) => ({
      ...l,
      brain: { ...b, avatarUrl: b.status === "claimed" ? b.avatarUrl : null },
    })),
    sales: brainId ? sales.filter((s) => s.brainId === brainId) : sales,
    lowest: [...lowestBy.values()].sort((a, b) => brainTitle(a).localeCompare(brainTitle(b))),
    now: nowSec(),
  };
}
