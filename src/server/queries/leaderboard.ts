import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { cacheLife } from "next/cache";
import { connection } from "next/server";
import { getDb, schema } from "@/db/client";
import type { ExternalStats, SourceStats } from "@/server/directory/types";
import { loadLeaderBrains, type LbWindow, type LeaderBrain, type Leaderboard, type LeaderRow } from "@/server/snapshots/leaderboard";
import { readSnapshot, SNAPSHOT_KEYS } from "@/server/snapshots/store";
import { parseJson } from "./shared";

const { brains } = schema;

/**
 * Realized PnL leaderboard, as last computed by the worker (`leaderboard` snapshot, src/server/snapshots). Null while
 * the first snapshot is still being computed.
 */
export async function getLeaderboard(): Promise<Leaderboard | null> {
  await connection();
  return (await readSnapshot<Leaderboard>(SNAPSHOT_KEYS.leaderboard))?.value ?? null;
}

/** One brain's leaderboard row from the same snapshot (null when not computed yet or not listed). */
export async function getBrainBoardRow(brainId: string): Promise<LeaderRow | null> {
  return (await getLeaderboard())?.rows.find((r) => r.id === brainId) ?? null;
}

export const LB_SORTS = {
  pnl: "Realized PnL",
  winrate: "Win rate",
  trades: "Trades",
  wins: "Wins",
} as const;
export type LbSort = keyof typeof LB_SORTS;

/** Win-rate sort ranks wallets with at least this many decided tokens first (a 1-for-1 day isn't a 100% shooter). */
export const WINRATE_MIN_DECIDED = 5;

/** Rows active in the window, sorted (ties: realized PnL, then trades). */
export function rankLeaderboard(rows: LeaderRow[], w: LbWindow, sort: LbSort): LeaderRow[] {
  const key = (r: LeaderRow): number => {
    const s = r.stats[w];
    if (sort === "winrate") return (s.wins + s.losses >= WINRATE_MIN_DECIDED ? 2 : 0) + (s.winRate ?? -1);
    if (sort === "trades") return s.trades;
    if (sort === "wins") return s.wins;
    return s.realizedUsd;
  };
  return rows
    .filter((r) => r.stats[w].trades > 0 || r.stats[w].wins + r.stats[w].losses > 0)
    .sort((a, b) => key(b) - key(a) || b.stats[w].realizedUsd - a.stats[w].realizedUsd || b.stats[w].trades - a.stats[w].trades);
}

export interface SourceLeaderRow extends LeaderBrain {
  stats: SourceStats;
  url: string | null;
}

/** The wallet directory's own figures, as published at its snapshot time (brains table only). */
export async function getSourceLeaderboard(): Promise<SourceLeaderRow[]> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 300, expire: 3600 });
  const db = getDb();
  const [brainRows, ext] = await Promise.all([
    loadLeaderBrains(),
    db
      .select({ id: brains.id, ext: brains.externalStatsJson, sources: brains.sourcesJson })
      .from(brains)
      .where(and(eq(brains.listed, true), sql`json_extract(${brains.externalStatsJson}, '$.listing') is not null`)),
  ]);
  const byId = new Map(brainRows.map((b) => [b.id, b]));
  const out: SourceLeaderRow[] = [];
  for (const r of ext) {
    const b = byId.get(r.id);
    const stats = parseJson<ExternalStats>(r.ext, {}).listing;
    if (!b || !stats) continue;
    const src = parseJson<{ source: string; url: string | null }[]>(r.sources, []).find((s) => s.source === "directory");
    out.push({ ...b, stats, url: src?.url ?? null });
  }
  return out;
}

export function sourcePnl(s: SourceStats, w: LbWindow): number | null {
  return w === "1d" ? s.pnl1dUsd : w === "7d" ? s.pnl7dUsd : s.pnl30dUsd;
}
