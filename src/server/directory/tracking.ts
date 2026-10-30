/**
 * Tracking tiers. `live` brains are in the Helius webhook (real-time alerts) and polled every reconcile pass;
 * `standard` brains are reconciled every 6 h via Helius `since` (staggered across the window).
 *
 * Live selection (LIVE_TRACKED_MAX slots):
 *   priority = directoryScore (0–100; unknown → 30) + 25 · min(1, log10(1 + trades₇d) / log10(101))
 * where trades₇d counts our own ingested trades in the last 7 days (activity on-chain, not leaderboard claims).
 * Claimed brains and brains with seats are always live. Brains ranked in the top half of LIVE_TRACKED_MAX always get a
 * slot (a top newcomer can't be locked out by incumbents). Remaining slots go to currently-live brains whose rank is
 * still within 1.5 × LIVE_TRACKED_MAX (hysteresis: no webhook churn from small score moves around the cut), then to
 * the next brains by rank.
 */
import { and, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { env } from "@/lib/env";
import type { ExternalStats } from "./types";

export const RECONCILE_EVERY_SEC = 6 * 3600;

export interface TierResult {
  live: number;
  standard: number;
  promoted: string[];
  demoted: string[];
}

export async function chooseLiveTier(max = env().LIVE_TRACKED_MAX, nowSec = Math.floor(Date.now() / 1000)): Promise<TierResult> {
  const db = getDb();
  const brains = await db
    .select({
      id: schema.brains.id,
      tracking: schema.brains.tracking,
      status: schema.brains.status,
      listed: schema.brains.listed,
      externalStatsJson: schema.brains.externalStatsJson,
    })
    .from(schema.brains);
  const recent = new Map(
    (
      await db
        .select({ id: schema.trades.brainId, n: sql<number>`count(*)` })
        .from(schema.trades)
        .where(gte(schema.trades.blockTime, nowSec - 7 * 86_400))
        .groupBy(schema.trades.brainId)
    ).map((r) => [r.id, Number(r.n)]),
  );
  const seated = new Set((await db.selectDistinct({ id: schema.seats.brainId }).from(schema.seats)).map((r) => r.id));

  const ranked = brains
    .filter((b) => b.listed)
    .map((b) => {
      const score = (JSON.parse(b.externalStatsJson) as ExternalStats).directory?.value ?? 30;
      const n = recent.get(b.id) ?? 0;
      return { ...b, priority: score + 25 * Math.min(1, Math.log10(1 + n) / Math.log10(101)) };
    })
    .sort((a, b) => b.priority - a.priority);

  const live = selectLive(
    ranked.map((b) => ({ ...b, seated: seated.has(b.id) })),
    max,
  );

  const promoted = brains.filter((b) => live.has(b.id) && b.tracking !== "live").map((b) => b.id);
  const demoted = brains.filter((b) => !live.has(b.id) && b.tracking === "live").map((b) => b.id);
  if (promoted.length) await db.update(schema.brains).set({ tracking: "live" }).where(inArray(schema.brains.id, promoted));
  if (demoted.length) await db.update(schema.brains).set({ tracking: "standard" }).where(inArray(schema.brains.id, demoted));
  return { live: live.size, standard: brains.length - live.size, promoted, demoted };
}

interface RankedCandidate {
  id: string;
  tracking: string;
  status: string;
  seated: boolean;
}

/** Pure tier choice over brains sorted by priority (best first); see the module comment for the rules. */
export function selectLive(ranked: readonly RankedCandidate[], max: number): Set<string> {
  const live = new Set<string>();
  for (const b of ranked) if (b.status === "claimed" || b.seated) live.add(b.id);
  ranked.forEach((b, rank) => {
    if (live.size < max && rank < max / 2) live.add(b.id);
  });
  ranked.forEach((b, rank) => {
    if (live.size < max && b.tracking === "live" && rank < 1.5 * max) live.add(b.id);
  });
  for (const b of ranked) {
    if (live.size >= max) break;
    live.add(b.id);
  }
  return live;
}

/** Live brains with a finished backfill (polled every reconcile pass). */
export async function liveBrainIds(): Promise<string[]> {
  const rows = await getDb()
    .select({ id: schema.brains.id })
    .from(schema.brains)
    .where(and(eq(schema.brains.tracking, "live"), eq(schema.brains.backfillStatus, "done")));
  return rows.map((r) => r.id);
}

/**
 * Standard brains due for their 6-hourly reconcile, oldest first. `limit` staggers the work: the worker calls this
 * every few minutes with ⌈standard / passes-per-window⌉ so the whole tier is spread over the window.
 */
export async function standardBrainsDue(limit: number, nowSec = Math.floor(Date.now() / 1000)): Promise<string[]> {
  const rows = await getDb()
    .select({ id: schema.brains.id })
    .from(schema.brains)
    .where(
      and(
        eq(schema.brains.tracking, "standard"),
        eq(schema.brains.backfillStatus, "done"),
        or(isNull(schema.brains.lastReconciledAt), lt(schema.brains.lastReconciledAt, nowSec - RECONCILE_EVERY_SEC)),
      ),
    )
    .orderBy(sql`coalesce(${schema.brains.lastReconciledAt}, 0)`)
    .limit(limit);
  return rows.map((r) => r.id);
}

export async function countStandardDone(): Promise<number> {
  const [r] = await getDb()
    .select({ n: sql<number>`count(*)` })
    .from(schema.brains)
    .where(and(eq(schema.brains.tracking, "standard"), eq(schema.brains.backfillStatus, "done")));
  return Number(r?.n ?? 0);
}

export async function markReconciled(id: string, nowSec = Math.floor(Date.now() / 1000)): Promise<void> {
  await getDb().update(schema.brains).set({ lastReconciledAt: nowSec }).where(eq(schema.brains.id, id));
}

/** An errored backfill is retried after BACKFILL_RETRY_BASE_SEC × attempts; after BACKFILL_MAX_ATTEMPTS it stays "error". */
export const BACKFILL_MAX_ATTEMPTS = 5;
export const BACKFILL_RETRY_BASE_SEC = 15 * 60;

/**
 * Backfills to start: pending ones, then errored ones whose retry time has come (attempts left), live tier first,
 * then oldest; skips ids already in flight.
 */
export async function nextPendingBackfills(limit: number, exclude: string[], nowSec = Math.floor(Date.now() / 1000)): Promise<string[]> {
  if (limit <= 0) return [];
  const b = schema.brains;
  const rows = await getDb()
    .select({ id: b.id })
    .from(b)
    .where(
      or(
        eq(b.backfillStatus, "pending"),
        and(
          eq(b.backfillStatus, "error"),
          lt(b.backfillAttempts, BACKFILL_MAX_ATTEMPTS),
          or(isNull(b.backfillRetryAt), lte(b.backfillRetryAt, nowSec)),
        ),
      ),
    )
    .orderBy(
      sql`case when ${b.tracking} = 'live' then 0 else 1 end`,
      sql`case when ${b.backfillStatus} = 'pending' then 0 else 1 end`,
      b.createdAt,
    )
    .limit(limit + exclude.length);
  return rows.map((r) => r.id).filter((id) => !exclude.includes(id)).slice(0, limit);
}
