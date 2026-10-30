/**
 * Profile engine entry points: recomputeProfile (DB → computeProfile → brains row) and tier pricing.
 */
import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { WINDOW_DAYS } from "@/server/ingest/constants";
import { detectPromoteThenSell, promoteThenSellLabel } from "@/server/x/shill";
import { computeProfile } from "./compute";
import type { ProfileToken } from "./metrics";
import { DEFAULT_WIN_RATE_BASE, MIN_POPULATION_CLOSED, TIER_PRICING } from "./score";
import type { BrainProfile } from "./types";

export { computeProfile } from "./compute";

/**
 * Population win rate for the shrinkage prior: closed-position wins / closed positions pooled over every stored
 * profile (sniper smart.rs base_rate). DEFAULT_WIN_RATE_BASE until MIN_POPULATION_CLOSED positions exist.
 */
export async function populationWinRate(): Promise<number> {
  const wr = sql`json_extract(${schema.brains.profileJson}, '$.pnl.winRate')`;
  const closed = sql`json_extract(${schema.brains.profileJson}, '$.pnl.closedPositions')`;
  const [row] = await getDb()
    .select({ wins: sql<number | null>`sum(${wr} * ${closed})`, closed: sql<number | null>`sum(${closed})` })
    .from(schema.brains)
    .where(sql`${wr} is not null`);
  const n = Number(row?.closed ?? 0);
  return n >= MIN_POPULATION_CLOSED ? Number(row.wins) / n : DEFAULT_WIN_RATE_BASE;
}

/** Loads trailing-90d trades, computes the profile, stores it (version bump) and applies tier pricing. */
export async function recomputeProfile(brainId: string): Promise<BrainProfile> {
  const db = getDb();
  const [brain] = await db.select().from(schema.brains).where(eq(schema.brains.id, brainId));
  if (!brain) throw new Error(`Unknown brain ${brainId}`);
  const now = Math.floor(Date.now() / 1000);
  const trades = await db
    .select()
    .from(schema.trades)
    .where(and(eq(schema.trades.brainId, brainId), gte(schema.trades.blockTime, now - WINDOW_DAYS * 86_400)));

  const mints = [...new Set(trades.map((t) => t.mint))];
  const tokens: ProfileToken[] = [];
  for (let i = 0; i < mints.length; i += 500) {
    tokens.push(...(await db.select().from(schema.tokens).where(inArray(schema.tokens.mint, mints.slice(i, i + 500)))));
  }

  const promoteThenSell = brain.status === "claimed" && brain.xUserId ? await detectPromoteThenSell(brainId) : null;
  const profile = computeProfile(trades, tokens, now, {
    wallet: brain.wallet,
    promoteThenSell,
    promoteThenSellFlag: promoteThenSellLabel(promoteThenSell),
    winRateBase: await populationWinRate(),
  });

  await db
    .update(schema.brains)
    .set({
      profileJson: JSON.stringify(profile),
      profileVersion: brain.profileVersion + 1,
      profileUpdatedAt: now,
      tier: profile.tier,
      trackScore: profile.trackScore,
    })
    .where(eq(schema.brains.id, brainId));
  await applyTierPricing(brainId);
  return profile;
}

/** Tier table → seat supply/price/renewal, unless priceOverride. Supply never below seats already minted. */
export async function applyTierPricing(brainId: string): Promise<void> {
  const db = getDb();
  const [brain] = await db
    .select({ tier: schema.brains.tier, priceOverride: schema.brains.priceOverride })
    .from(schema.brains)
    .where(eq(schema.brains.id, brainId));
  if (!brain || brain.priceOverride) return;
  const [{ minted }] = await db.select({ minted: count() }).from(schema.seats).where(eq(schema.seats.brainId, brainId));
  const p = TIER_PRICING[brain.tier];
  await db
    .update(schema.brains)
    .set({
      seatSupply: Math.max(p.supply, minted),
      seatPriceLamports: p.priceLamports,
      renewalPriceLamports: p.renewalLamports,
    })
    .where(eq(schema.brains.id, brainId));
}
