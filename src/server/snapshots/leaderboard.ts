/**
 * Realized PnL leaderboard from our own indexed trades (average-cost replay, same accounting as the profile engine).
 * Replays every position with a sell in the last 30 days (~1M trades): worker-only, stored as the `leaderboard`
 * snapshot. No next/server-only imports.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { BrainTier } from "@/db/schema";
import { median, replayPosition, type ProfileTrade } from "@/server/profile/metrics";
import type { ArchetypeId } from "@/server/profile/types";
import type { BrainFace } from "@/server/queries/shared";

const { brains, trades, seats } = schema;
const pj = (path: string) => sql`json_extract(${brains.profileJson}, ${path})`;

export const LB_WINDOWS = { "1d": 1, "7d": 7, "30d": 30 } as const;
export type LbWindow = keyof typeof LB_WINDOWS;
export const SPARK_DAYS = 30;
const DAY = 86_400;

export interface WindowStats {
  realizedUsd: number;
  realizedSol: number;
  wins: number;
  losses: number;
  winRate: number | null;
  trades: number;
  medianHoldSec: number | null;
}

export interface LeaderBrain extends BrainFace {
  id: string;
  wallet: string;
  tier: BrainTier;
  trackScore: number | null;
  archetypeId: ArchetypeId | null;
  seatsMinted: number;
  seatSupply: number;
  tracking: "live" | "standard";
}

export interface LeaderRow extends LeaderBrain {
  stats: Record<LbWindow, WindowStats>;
  /** Realized USD per UTC day, oldest → today (SPARK_DAYS values). */
  daily: number[];
}

export interface Leaderboard {
  rows: LeaderRow[];
  /** Listed brains (including those with no trades in the 30-day window). */
  tracked: number;
  computedAt: number;
  /** UTC midnight of the first sparkline day. */
  sparkStart: number;
}

const emptyStats = (): WindowStats => ({ realizedUsd: 0, realizedSol: 0, wins: 0, losses: 0, winRate: null, trades: 0, medianHoldSec: null });

/** Listed brains with leaderboard identity columns (870 rows, brains table only). */
export async function loadLeaderBrains(): Promise<LeaderBrain[]> {
  const rows = await getDb()
    .select({
      id: brains.id,
      wallet: brains.wallet,
      brainId: brains.id,
      codename: brains.codename,
      displayName: brains.displayName,
      xHandle: brains.xHandle,
      provenance: brains.provenance,
      status: brains.status,
      avatarUrl: brains.avatarUrl,
      publicAvatarUrl: brains.publicAvatarUrl,
      tier: brains.tier,
      trackScore: brains.trackScore,
      archetypeId: sql<ArchetypeId | null>`${pj("$.archetype.id")}`,
      seatSupply: brains.seatSupply,
      seatsMinted: sql<number>`(select count(*) from ${seats} where ${seats.brainId} = ${brains.id})`.mapWith(Number),
      tracking: brains.tracking,
    })
    .from(brains)
    .where(eq(brains.listed, true));
  return rows.map((r) => ({ ...r, avatarUrl: r.status === "claimed" ? r.avatarUrl : null }));
}

/**
 * A sell counts in a window when it happened inside it; its basis comes from the position's whole history. Wins and
 * losses are per token: the realized sum of that token's in-window sells. Replays one brain at a time (indexed by
 * brain_id; bounded memory, short reads) and yields to the event loop between brains.
 */
export async function computeLeaderboard(): Promise<Leaderboard> {
  const now = Math.floor(Date.now() / 1000);
  const since30 = now - 30 * DAY;
  const sparkStart = Math.floor(now / DAY) * DAY - (SPARK_DAYS - 1) * DAY;
  const lower = Math.min(since30, sparkStart);
  const db = getDb();
  const windows = Object.entries(LB_WINDOWS) as [LbWindow, number][];
  const rows: LeaderRow[] = [];
  const brainRows = await loadLeaderBrains();

  for (const b of brainRows) {
    const [c] = await db
      .select({
        d1: sql<number>`coalesce(sum(case when ${trades.blockTime} >= ${now - DAY} then 1 else 0 end), 0)`.mapWith(Number),
        d7: sql<number>`coalesce(sum(case when ${trades.blockTime} >= ${now - 7 * DAY} then 1 else 0 end), 0)`.mapWith(Number),
        d30: sql<number>`count(*)`.mapWith(Number),
      })
      .from(trades)
      .where(and(eq(trades.brainId, b.id), gte(trades.blockTime, since30)));
    // tokens with a sell in the window; the join pulls their full history (basis needs earlier buys)
    const pairs = db
      .selectDistinct({ mint: trades.mint })
      .from(trades)
      .where(and(eq(trades.brainId, b.id), gte(trades.blockTime, lower), eq(trades.side, "sell")))
      .as("p");
    const tradeRows: ProfileTrade[] = await db
      .select({
        signature: trades.signature,
        slot: trades.slot,
        txIndex: trades.txIndex,
        blockTime: trades.blockTime,
        side: trades.side,
        mint: trades.mint,
        tokenAmount: trades.tokenAmount,
        solValue: trades.solValue,
        usdValue: trades.usdValue,
        feesSol: trades.feesSol,
        solUsd: trades.solUsd,
        mcUsd: trades.mcUsd,
        venue: trades.venue,
        launchpad: trades.launchpad,
        entryDelaySec: trades.entryDelaySec,
      })
      .from(trades)
      .innerJoin(pairs, and(eq(trades.brainId, b.id), eq(pairs.mint, trades.mint)));

    const byMint = new Map<string, ProfileTrade[]>();
    for (const t of tradeRows) {
      const list = byMint.get(t.mint);
      if (list) list.push(t);
      else byMint.set(t.mint, [t]);
    }
    const stats: Record<LbWindow, WindowStats> = { "1d": emptyStats(), "7d": emptyStats(), "30d": emptyStats() };
    const holds: Record<LbWindow, number[]> = { "1d": [], "7d": [], "30d": [] };
    const daily = new Array<number>(SPARK_DAYS).fill(0);
    for (const list of byMint.values()) {
      const p = replayPosition(list);
      if (!p || p.sellFills.length === 0) continue;
      // SOL rate of each sell (fill signature → SOL/USD at that trade).
      const rate = new Map<string, number>();
      for (const t of list) {
        if (t.side !== "sell") continue;
        const r = t.solUsd ?? (t.usdValue != null && t.solValue ? t.usdValue / t.solValue : null);
        if (r && r > 0) rate.set(t.signature, r);
      }
      for (const f of p.sellFills) {
        if (f.blockTime >= sparkStart) {
          const i = Math.floor((f.blockTime - sparkStart) / DAY);
          if (i >= 0 && i < SPARK_DAYS) daily[i] += f.realizedUsd;
        }
      }
      for (const [w, days] of windows) {
        const since = now - days * DAY;
        const fills = p.sellFills.filter((f) => f.blockTime >= since);
        if (fills.length === 0) continue;
        const s = stats[w];
        let usd = 0;
        let last = 0;
        for (const f of fills) {
          usd += f.realizedUsd;
          const r = rate.get(f.signature);
          if (r) s.realizedSol += f.realizedUsd / r;
          last = Math.max(last, f.blockTime);
        }
        s.realizedUsd += usd;
        if (usd > 0) s.wins++;
        else if (usd < 0) s.losses++;
        holds[w].push(Math.max(0, last - p.firstBuyAt));
      }
    }
    for (const [w] of windows) {
      const s = stats[w];
      const decided = s.wins + s.losses;
      s.winRate = decided > 0 ? s.wins / decided : null;
      s.trades = c ? (w === "1d" ? c.d1 : w === "7d" ? c.d7 : c.d30) : 0;
      s.medianHoldSec = median(holds[w]);
    }
    rows.push({ ...b, stats, daily });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return { rows, tracked: brainRows.length, computedAt: now, sparkStart };
}
