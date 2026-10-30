import "server-only";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { connection } from "next/server";
import { getDb, schema } from "@/db/client";
import { swarmViewer } from "@/server/signals/queries";
import type { Squad, SquadsSnapshot } from "@/server/snapshots/squads";
import { readSnapshot, SNAPSHOT_KEYS } from "@/server/snapshots/store";
import { PUBLIC_TRADE_DELAY_SEC } from "./brains";
import { faceColumns, nowSec, type BrainFace } from "./shared";

const { brains, trades, tokens } = schema;

/** Squads as last built by the worker (null while the first snapshot is being computed). */
export async function listSquads(): Promise<SquadsSnapshot | null> {
  await connection();
  return (await readSnapshot<SquadsSnapshot>(SNAPSHOT_KEYS.squads))?.value ?? null;
}

/** Null when the slug is unknown or squads are not computed yet. */
export async function getSquad(slug: string): Promise<{ squad: Squad; sparkStart: number; computedAt: number } | null> {
  const snap = await listSquads();
  const squad = snap?.squads.find((s) => s.slug === slug);
  return snap && squad ? { squad, sparkStart: snap.sparkStart, computedAt: snap.computedAt } : null;
}

export interface TapeTrade extends BrainFace {
  id: number;
  brainId: string;
  signature: string;
  blockTime: number;
  side: "buy" | "sell";
  mint: string;
  symbol: string | null;
  icon: string | null;
  solValue: number | null;
  usdValue: number | null;
  mcUsd: number | null;
  /** Newer than the public delay: shown only because the viewer holds a seat on this member. */
  realtime: boolean;
}

/**
 * The squad's combined trade tape. Public: trades older than PUBLIC_TRADE_DELAY_SEC. A viewer with an unexpired seat
 * on a member (or that member's claimed owner / admin) also sees that member's newer trades — never other members'.
 */
export async function getSquadTape(
  memberIds: string[],
  viewerWallet: string | null,
  limit = 60,
): Promise<{ trades: TapeTrade[]; realtimeIds: string[]; now: number }> {
  await connection();
  const now = nowSec();
  if (memberIds.length === 0) return { trades: [], realtimeIds: [], now };
  const viewer = await swarmViewer(viewerWallet);
  const realtimeIds = viewer.all ? memberIds : memberIds.filter((id) => viewer.brainIds.has(id));
  const cutoff = now - PUBLIC_TRADE_DELAY_SEC;
  const visible = realtimeIds.length
    ? or(lt(trades.blockTime, cutoff), inArray(trades.brainId, realtimeIds))
    : lt(trades.blockTime, cutoff);
  const rows = await getDb()
    .select({
      id: trades.id,
      ...faceColumns,
      signature: trades.signature,
      blockTime: trades.blockTime,
      side: trades.side,
      mint: trades.mint,
      symbol: tokens.symbol,
      icon: tokens.icon,
      solValue: trades.solValue,
      usdValue: trades.usdValue,
      mcUsd: trades.mcUsd,
    })
    .from(trades)
    .innerJoin(brains, eq(brains.id, trades.brainId))
    .leftJoin(tokens, eq(tokens.mint, trades.mint))
    .where(and(inArray(trades.brainId, memberIds), visible))
    .orderBy(desc(trades.blockTime), desc(trades.id))
    .limit(limit);
  return {
    trades: rows.map((r) => ({ ...r, avatarUrl: r.status === "claimed" ? r.avatarUrl : null, realtime: r.blockTime >= cutoff })),
    realtimeIds,
    now,
  };
}
