/** Live neural firing: brain-level view of live trades (no token, no amount — only a size bucket). */
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { FiringDTO } from "./types";

const { trades, brains } = schema;

const columns = {
  id: trades.id,
  brainId: trades.brainId,
  side: trades.side,
  at: trades.blockTime,
  solValue: trades.solValue,
};

function toFiring(r: { id: number; brainId: string; side: "buy" | "sell"; at: number; solValue: number | null }): FiringDTO {
  const sol = r.solValue ?? 0;
  return { id: r.id, brainId: r.brainId, side: r.side, at: r.at, sizeBucket: sol > 10 ? 3 : sol >= 1 ? 2 : 1 };
}

// Backfilled history is not "firing": only trades ingested live, for listed brains.
const live = and(eq(trades.source, "live"), eq(brains.listed, true));

/** The newest `limit` firings, oldest first. */
export async function recentFirings(limit: number): Promise<FiringDTO[]> {
  const rows = await getDb()
    .select(columns)
    .from(trades)
    .innerJoin(brains, eq(brains.id, trades.brainId))
    .where(live)
    .orderBy(desc(trades.id))
    .limit(limit);
  return rows.reverse().map(toFiring);
}

/** Firings with trade id above `cursor`, oldest first. */
export async function firingsAfter(cursor: number, limit: number): Promise<FiringDTO[]> {
  const rows = await getDb()
    .select(columns)
    .from(trades)
    .innerJoin(brains, eq(brains.id, trades.brainId))
    .where(and(live, gt(trades.id, cursor)))
    .orderBy(asc(trades.id))
    .limit(limit);
  return rows.map(toFiring);
}

/** Highest trade id (cursor start when there is nothing to replay). */
export async function latestTradeId(): Promise<number> {
  const [r] = await getDb().select({ id: trades.id }).from(trades).orderBy(desc(trades.id)).limit(1);
  return r?.id ?? 0;
}
