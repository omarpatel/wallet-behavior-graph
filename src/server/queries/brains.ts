import "server-only";
import { and, asc, desc, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import { connection } from "next/server";
import { getDb, schema } from "@/db/client";
import type { BrainTier, Provenance } from "@/db/schema";
import { brainTitle } from "@/lib/identity";
import type { AlertDTO, AlertFacts } from "@/server/alerts/types";
import type { DirectorySource, ExternalStats } from "@/server/directory/types";
import type { ArchetypeId, BrainProfile } from "@/server/profile/types";
import { faceColumns, nowSec, parseJson, parseProfile, TIERS, type BrainFace, type BrainIdentity } from "./shared";

const { brains, seats, listings, trades, tokens, shillEvents, tweets, alerts, ledger, kolPayouts } = schema;

/** Public trade log shows only trades older than this: the real-time edge belongs to seat holders. */
export const PUBLIC_TRADE_DELAY_SEC = 3600;

const seatsMintedSql = sql<number>`(select count(*) from ${seats} where ${seats.brainId} = ${brains.id})`.mapWith(Number);
const pj = (path: string) => sql`json_extract(${brains.profileJson}, ${path})`;

const cardColumns = {
  id: brains.id,
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
  trackScore: brains.trackScore,
  seatSupply: brains.seatSupply,
  seatPriceLamports: brains.seatPriceLamports,
  renewalPriceLamports: brains.renewalPriceLamports,
  termDays: brains.termDays,
  backfillStatus: brains.backfillStatus,
  seatsMinted: seatsMintedSql,
  archetypeId: sql<ArchetypeId | null>`${pj("$.archetype.id")}`,
  archetypeLabel: sql<string | null>`${pj("$.archetype.label")}`,
  archetypeReason: sql<string | null>`${pj("$.archetype.reason")}`,
  realizedUsd: sql<number | null>`${pj("$.pnl.realizedUsd")}`,
  winRate: sql<number | null>`${pj("$.pnl.winRate")}`,
  medianHoldSec: sql<number | null>`${pj("$.hold.medianHoldSec")}`,
  medianEntryMcUsd: sql<number | null>`${pj("$.entryMc.medianUsd")}`,
  sampleTokens: sql<number | null>`${pj("$.sample.tokens")}`,
};

export interface BrainCard extends BrainIdentity {
  tier: BrainTier;
  trackScore: number | null;
  seatSupply: number;
  seatsMinted: number;
  seatPriceLamports: number;
  renewalPriceLamports: number;
  termDays: number;
  backfillStatus: "pending" | "running" | "done" | "error";
  archetype: { id: ArchetypeId; label: string; reason: string } | null;
  realizedUsd: number | null;
  winRate: number | null;
  medianHoldSec: number | null;
  medianEntryMcUsd: number | null;
  sampleTokens: number | null;
}

type CardRow = { [K in keyof typeof cardColumns]: unknown };

function toCard(r: CardRow): BrainCard {
  const num = (v: unknown) => (v == null ? null : Number(v));
  return {
    id: r.id as string,
    brainId: r.id as string,
    wallet: r.wallet as string,
    codename: r.codename as string,
    displayName: r.displayName as string | null,
    xHandle: r.xHandle as string | null,
    provenance: r.provenance as Provenance,
    provenanceSource: r.provenanceSource as string | null,
    status: r.status as "unclaimed" | "claimed",
    avatarUrl: r.avatarUrl as string | null,
    publicAvatarUrl: r.publicAvatarUrl as string | null,
    tier: r.tier as BrainTier,
    trackScore: num(r.trackScore),
    seatSupply: Number(r.seatSupply),
    seatsMinted: Number(r.seatsMinted),
    seatPriceLamports: Number(r.seatPriceLamports),
    renewalPriceLamports: Number(r.renewalPriceLamports),
    termDays: Number(r.termDays),
    backfillStatus: r.backfillStatus as BrainCard["backfillStatus"],
    archetype: r.archetypeId
      ? { id: r.archetypeId as ArchetypeId, label: String(r.archetypeLabel ?? r.archetypeId), reason: String(r.archetypeReason ?? "") }
      : null,
    realizedUsd: num(r.realizedUsd),
    winRate: num(r.winRate),
    medianHoldSec: num(r.medianHoldSec),
    medianEntryMcUsd: num(r.medianEntryMcUsd),
    sampleTokens: num(r.sampleTokens),
  };
}

export const BRAIN_SORTS = {
  score: "Track score",
  pnl: "Realized PnL (90d)",
  seats: "Seats left",
  price: "Mint price",
} as const;
export type BrainSort = keyof typeof BRAIN_SORTS;

export interface BrainFilters {
  q?: string;
  tier?: BrainTier;
  archetype?: ArchetypeId;
  claimed?: "claimed" | "unclaimed";
  openSeats?: boolean;
  sort?: BrainSort;
}

/** Normalises untrusted `searchParams` into typed filters. */
export function parseBrainFilters(sp: Record<string, string | string[] | undefined>): BrainFilters {
  const one = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  };
  const tier = one("tier");
  const claimed = one("claimed");
  const sort = one("sort");
  return {
    q: one("q")?.slice(0, 64),
    tier: TIERS.includes(tier as BrainTier) ? (tier as BrainTier) : undefined,
    archetype: one("archetype") as ArchetypeId | undefined,
    claimed: claimed === "claimed" || claimed === "unclaimed" ? claimed : undefined,
    openSeats: one("open") === "1",
    sort: sort && sort in BRAIN_SORTS ? (sort as BrainSort) : "score",
  };
}

export async function listBrains(f: BrainFilters = {}, limit = 120): Promise<BrainCard[]> {
  await connection();
  const where: SQL[] = [eq(brains.listed, true)];
  if (f.tier) where.push(eq(brains.tier, f.tier));
  if (f.archetype) where.push(sql`${pj("$.archetype.id")} = ${f.archetype}`);
  if (f.claimed) where.push(eq(brains.status, f.claimed));
  if (f.openSeats) where.push(sql`${brains.seatSupply} > ${seatsMintedSql}`);
  if (f.q) {
    const like = `%${f.q.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(
      sql`(lower(${brains.codename}) like ${like} escape '\\' or lower(coalesce(${brains.displayName}, '')) like ${like} escape '\\' or lower(coalesce(${brains.xHandle}, '')) like ${like} escape '\\' or lower(${brains.wallet}) like ${like} escape '\\' or lower(${brains.id}) like ${like} escape '\\')`,
    );
  }
  const order: SQL[] =
    f.sort === "pnl"
      ? [sql`${pj("$.pnl.realizedUsd")} is null`, sql`${pj("$.pnl.realizedUsd")} desc`]
      : f.sort === "seats"
        ? [sql`(${brains.seatSupply} - ${seatsMintedSql}) desc`, sql`${brains.trackScore} desc`]
        : f.sort === "price"
          ? [asc(brains.seatPriceLamports), sql`${brains.trackScore} desc`]
          : [sql`${brains.trackScore} is null`, desc(brains.trackScore)];
  const rows = await getDb()
    .select(cardColumns)
    .from(brains)
    .where(and(...where))
    .orderBy(...order, asc(brains.codename))
    .limit(limit);
  return rows.map(toCard);
}

/** Archetypes present among listed brains (for the filter control). */
export async function listArchetypes(): Promise<{ id: ArchetypeId; label: string }[]> {
  await connection();
  const rows = await getDb()
    .selectDistinct({ id: sql<string>`${pj("$.archetype.id")}`, label: sql<string>`${pj("$.archetype.label")}` })
    .from(brains)
    .where(and(eq(brains.listed, true), sql`${pj("$.archetype.id")} is not null`));
  return rows
    .map((r) => ({ id: r.id as ArchetypeId, label: String(r.label ?? r.id) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export async function getTopBrains(limit = 6): Promise<BrainCard[]> {
  return listBrains({ sort: "score" }, limit);
}

export interface ListingRow {
  id: string;
  asset: string;
  brainId: string;
  seller: string;
  priceLamports: number;
  seatNumber: number;
  expiresAt: number;
  createdAt: number;
}

export interface SaleRow extends BrainFace {
  id: string;
  brainId: string;
  seatNumber: number;
  priceLamports: number;
  buyer: string | null;
  seller: string;
  saleSignature: string | null;
  soldAt: number;
}

export interface PublicTrade {
  id: number;
  signature: string;
  blockTime: number;
  side: "buy" | "sell";
  mint: string;
  symbol: string | null;
  name: string | null;
  icon: string | null;
  solValue: number | null;
  usdValue: number | null;
  mcUsd: number | null;
  entryDelaySec: number | null;
  venue: string | null;
}

export interface ShillEvidence {
  id: number;
  tweetId: string;
  tweetText: string | null;
  tweetAtMs: number | null;
  mint: string;
  symbol: string | null;
  strong: boolean;
  prePositionUsd: number | null;
  leadTimeSec: number | null;
  entryDiscount: number | null;
  soldFrac1h: number | null;
  soldFrac24h: number | null;
  firstSellAfterSec: number | null;
  signatures: string[];
}

export interface RevenueSummary {
  accruedLamports: number;
  paidInlineLamports: number;
  paidOutLamports: number;
  pendingPayoutLamports: number;
}

export interface BrainDetail extends BrainIdentity {
  bio: string | null;
  claimedAt: number | null;
  xLinked: boolean;
  telegram: string | null;
  followers: number | null;
  sources: DirectorySource[];
  externalStats: ExternalStats;
  tracking: "live" | "standard";
  lastReconciledAt: number | null;
  tier: BrainTier;
  trackScore: number | null;
  profile: BrainProfile | null;
  profileUpdatedAt: number | null;
  playbookMd: string | null;
  /** Playbook was written for an older profile version (refresh queued by the worker). */
  playbookStale: boolean;
  seatSupply: number;
  seatsMinted: number;
  seatPriceLamports: number;
  renewalPriceLamports: number;
  termDays: number;
  kolShareBps: number;
  royaltyBps: number;
  collectionAddress: string | null;
  alertDelaySec: number;
  revenueHeld: boolean;
  revenueHeldReason: string | null;
  backfillStatus: BrainCard["backfillStatus"];
  backfillError: string | null;
  tradeCount: number;
  listed: boolean;
  createdAt: number;
  listings: ListingRow[];
  sales: SaleRow[];
  publicTrades: PublicTrade[];
  shillEvidence: ShillEvidence[];
  now: number;
}

export async function getBrainMeta(id: string): Promise<{ title: string; codename: string } | null> {
  await connection();
  const [b] = await getDb()
    .select({
      codename: brains.codename,
      displayName: brains.displayName,
      xHandle: brains.xHandle,
      provenance: brains.provenance,
      status: brains.status,
    })
    .from(brains)
    .where(eq(brains.id, id))
    .limit(1);
  if (!b) return null;
  return { title: brainTitle(b), codename: b.codename };
}

export async function getBrainDetail(id: string): Promise<BrainDetail | null> {
  await connection();
  const db = getDb();
  const [b] = await db.select().from(brains).where(eq(brains.id, id)).limit(1);
  if (!b) return null;
  const now = nowSec();
  const xLinked = b.status === "claimed" && !!b.xUserId;

  const [minted, tradeCount, activeListings, sales, publicTrades, shill] = await Promise.all([
    db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(seats).where(eq(seats.brainId, id)),
    db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(trades).where(eq(trades.brainId, id)),
    db
      .select({
        id: listings.id,
        asset: listings.asset,
        brainId: listings.brainId,
        seller: listings.seller,
        priceLamports: listings.priceLamports,
        seatNumber: seats.number,
        expiresAt: seats.expiresAt,
        createdAt: listings.createdAt,
      })
      .from(listings)
      .innerJoin(seats, eq(seats.asset, listings.asset))
      .where(and(eq(listings.brainId, id), eq(listings.status, "active")))
      .orderBy(asc(listings.priceLamports)),
    db
      .select({
        id: listings.id,
        ...faceColumns,
        seatNumber: seats.number,
        priceLamports: listings.priceLamports,
        buyer: listings.buyer,
        seller: listings.seller,
        saleSignature: listings.saleSignature,
        soldAt: listings.updatedAt,
      })
      .from(listings)
      .innerJoin(seats, eq(seats.asset, listings.asset))
      .innerJoin(brains, eq(brains.id, listings.brainId))
      .where(and(eq(listings.brainId, id), eq(listings.status, "sold")))
      .orderBy(desc(listings.updatedAt))
      .limit(10),
    db
      .select({
        id: trades.id,
        signature: trades.signature,
        blockTime: trades.blockTime,
        side: trades.side,
        mint: trades.mint,
        symbol: tokens.symbol,
        name: tokens.name,
        icon: tokens.icon,
        solValue: trades.solValue,
        usdValue: trades.usdValue,
        mcUsd: trades.mcUsd,
        entryDelaySec: trades.entryDelaySec,
        venue: trades.venue,
      })
      .from(trades)
      .leftJoin(tokens, eq(tokens.mint, trades.mint))
      .where(and(eq(trades.brainId, id), lt(trades.blockTime, now - PUBLIC_TRADE_DELAY_SEC)))
      .orderBy(desc(trades.blockTime), desc(trades.id))
      .limit(60),
    // Say-vs-do evidence exists only for claimed + X-linked brains (X Developer Policy).
    xLinked
      ? db
          .select({
            id: shillEvents.id,
            tweetId: shillEvents.tweetId,
            tweetText: tweets.text,
            tweetAtMs: tweets.createdAtMs,
            mint: shillEvents.mint,
            symbol: tokens.symbol,
            strong: shillEvents.strong,
            prePositionUsd: shillEvents.prePositionUsd,
            leadTimeSec: shillEvents.leadTimeSec,
            entryDiscount: shillEvents.entryDiscount,
            soldFrac1h: shillEvents.soldFrac1h,
            soldFrac24h: shillEvents.soldFrac24h,
            firstSellAfterSec: shillEvents.firstSellAfterSec,
            evidenceJson: shillEvents.evidenceJson,
          })
          .from(shillEvents)
          .leftJoin(tweets, eq(tweets.id, shillEvents.tweetId))
          .leftJoin(tokens, eq(tokens.mint, shillEvents.mint))
          .where(eq(shillEvents.brainId, id))
          .orderBy(desc(shillEvents.createdAt))
          .limit(30)
      : Promise.resolve([]),
  ]);

  return {
    id: b.id,
    brainId: b.id,
    wallet: b.wallet,
    codename: b.codename,
    displayName: b.displayName,
    xHandle: b.xHandle,
    provenance: b.provenance,
    provenanceSource: b.provenanceSource,
    status: b.status,
    avatarUrl: b.status === "claimed" ? b.avatarUrl : null,
    publicAvatarUrl: b.publicAvatarUrl,
    telegram: b.telegram,
    followers: b.followers,
    sources: parseJson<DirectorySource[]>(b.sourcesJson, []),
    externalStats: parseJson<ExternalStats>(b.externalStatsJson, {}),
    tracking: b.tracking,
    lastReconciledAt: b.lastReconciledAt,
    bio: b.status === "claimed" ? b.bio : null,
    claimedAt: b.claimedAt,
    xLinked,
    tier: b.tier,
    trackScore: b.trackScore,
    profile: parseProfile(b.profileJson),
    profileUpdatedAt: b.profileUpdatedAt,
    playbookMd: b.playbookMd,
    playbookStale: b.playbookMd != null && b.playbookProfileVersion !== b.profileVersion,
    seatSupply: b.seatSupply,
    seatsMinted: minted[0]?.n ?? 0,
    seatPriceLamports: b.seatPriceLamports,
    renewalPriceLamports: b.renewalPriceLamports,
    termDays: b.termDays,
    kolShareBps: b.kolShareBps,
    royaltyBps: b.royaltyBps,
    collectionAddress: b.collectionAddress,
    alertDelaySec: b.alertDelaySec,
    revenueHeld: b.revenueHeld,
    revenueHeldReason: b.revenueHeldReason,
    backfillStatus: b.backfillStatus,
    backfillError: b.backfillError,
    tradeCount: tradeCount[0]?.n ?? 0,
    listed: b.listed,
    createdAt: b.createdAt,
    listings: activeListings,
    sales,
    publicTrades,
    shillEvidence: shill.map(({ evidenceJson, ...e }) => {
      const ev = parseJson<{ signatures?: unknown }>(evidenceJson, {});
      const signatures = Array.isArray(ev.signatures) ? ev.signatures.filter((s): s is string => typeof s === "string") : [];
      return { ...e, signatures };
    }),
    now,
  };
}

/** Latest published alerts for the initial render of the holder-only Live tab. Caller must check access. */
export async function getRecentAlerts(brainId: string, limit = 20): Promise<AlertDTO[]> {
  await connection();
  const rows = await getDb()
    .select()
    .from(alerts)
    .where(and(eq(alerts.brainId, brainId), sql`${alerts.publishAt} <= ${nowSec()}`))
    .orderBy(desc(alerts.publishAt), desc(alerts.id))
    .limit(limit);
  return rows.map((a) => ({
    id: a.id,
    brainId: a.brainId,
    headline: a.headline,
    facts: JSON.parse(a.factsJson) as AlertFacts,
    explanation: a.explanation,
    publishAt: a.publishAt,
  }));
}

/** KOL-only revenue summary for one brain (shown to the brain wallet on its own page). */
export async function getRevenueSummary(brainId: string): Promise<RevenueSummary> {
  await connection();
  const db = getDb();
  const [[l], payouts] = await Promise.all([
    db
      .select({
        accrued: sql<number>`coalesce(sum(case when ${ledger.kolPaidInline} = 0 then ${ledger.kolLamports} else 0 end), 0)`.mapWith(Number),
        inline: sql<number>`coalesce(sum(case when ${ledger.kolPaidInline} = 1 then ${ledger.kolLamports} else 0 end), 0)`.mapWith(Number),
      })
      .from(ledger)
      .where(eq(ledger.brainId, brainId)),
    db
      .select({ status: kolPayouts.status, total: sql<number>`coalesce(sum(${kolPayouts.amountLamports}), 0)`.mapWith(Number) })
      .from(kolPayouts)
      .where(and(eq(kolPayouts.brainId, brainId), inArray(kolPayouts.status, ["pending", "sent"])))
      .groupBy(kolPayouts.status),
  ]);
  return {
    accruedLamports: l?.accrued ?? 0,
    paidInlineLamports: l?.inline ?? 0,
    paidOutLamports: payouts.find((p) => p.status === "sent")?.total ?? 0,
    pendingPayoutLamports: payouts.find((p) => p.status === "pending")?.total ?? 0,
  };
}

/** Recent sold listings across all brains (landing + market), with the server time they were read at. */
export async function getRecentSales(limit = 10): Promise<{ sales: SaleRow[]; now: number }> {
  await connection();
  const sales = await getDb()
    .select({
      id: listings.id,
      ...faceColumns,
      seatNumber: seats.number,
      priceLamports: listings.priceLamports,
      buyer: listings.buyer,
      seller: listings.seller,
      saleSignature: listings.saleSignature,
      soldAt: listings.updatedAt,
    })
    .from(listings)
    .innerJoin(seats, eq(seats.asset, listings.asset))
    .innerJoin(brains, eq(brains.id, listings.brainId))
    .where(eq(listings.status, "sold"))
    .orderBy(desc(listings.updatedAt))
    .limit(limit);
  return { sales, now: nowSec() };
}

export async function countBrains(): Promise<{ brains: number; rated: number; seatsMinted: number }> {
  await connection();
  const db = getDb();
  const [[b], [s]] = await Promise.all([
    db
      .select({
        n: sql<number>`count(*)`.mapWith(Number),
        rated: sql<number>`sum(case when ${brains.tier} != 'unrated' then 1 else 0 end)`.mapWith(Number),
      })
      .from(brains)
      .where(eq(brains.listed, true)),
    db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(seats),
  ]);
  return { brains: b?.n ?? 0, rated: b?.rated ?? 0, seatsMinted: s?.n ?? 0 };
}
