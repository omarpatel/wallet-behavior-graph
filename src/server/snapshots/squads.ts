/**
 * Auto squads snapshot (`squads`), built by the worker from the leaderboard snapshot and the connectome graph.
 * No next/server-only imports.
 */
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { loadGraph } from "@/server/connectome/graph";
import { SPARK_DAYS, type Leaderboard, type LeaderRow, type WindowStats } from "./leaderboard";

const { brains } = schema;
const pj = (path: string) => sql`json_extract(${brains.profileJson}, ${path})`;

export type SquadKind = "circle" | "top5" | "sharp" | "early" | "diamond";

export interface SquadMember extends LeaderRow {
  /** Why this member is in the squad, e.g. "shrunk win rate 61%". */
  note: string | null;
}

export interface SquadCombined {
  members: number;
  realized7dUsd: number;
  realized30dUsd: number;
  wins30d: number;
  losses30d: number;
  winRate30d: number | null;
  trades30d: number;
  daily: number[];
}

export interface SquadsSnapshot {
  squads: Squad[];
  sparkStart: number;
  computedAt: number;
}

export interface Squad {
  slug: string;
  kind: SquadKind;
  name: string;
  blurb: string;
  rule: string;
  members: SquadMember[];
  combined: SquadCombined;
}

const SHARP_MIN_CLOSED = 10;
const DIAMOND_MIN_HOLD_SEC = 6 * 3600;

function combine(members: SquadMember[]): SquadCombined {
  const sum = (f: (s: WindowStats) => number) => members.reduce((a, m) => a + f(m.stats["30d"]), 0);
  const wins = sum((s) => s.wins);
  const losses = sum((s) => s.losses);
  const daily = new Array<number>(SPARK_DAYS).fill(0);
  for (const m of members) m.daily.forEach((v, i) => (daily[i] += v));
  return {
    members: members.length,
    realized7dUsd: members.reduce((a, m) => a + m.stats["7d"].realizedUsd, 0),
    realized30dUsd: sum((s) => s.realizedUsd),
    wins30d: wins,
    losses30d: losses,
    winRate30d: wins + losses > 0 ? wins / (wins + losses) : null,
    trades30d: sum((s) => s.trades),
    daily,
  };
}

const fmtPctInt = (r: number) => `${Math.round(r * 100)}%`;
const fmtHours = (s: number) => (s >= 86_400 ? `${(s / 86_400).toFixed(1)}d` : `${(s / 3600).toFixed(1)}h`);

/**
 * Auto squads (trader baskets): groups of tracked wallets defined by a
 * transparent rule over public data. Following a squad means watching its combined tape — nothing is pooled.
 */
export async function computeSquads(board: Leaderboard): Promise<SquadsSnapshot> {
  const [graph, extra] = await Promise.all([
    loadGraph(),
    getDb()
      .select({
        id: brains.id,
        archetypeId: sql<string | null>`${pj("$.archetype.id")}`,
        winRateShrunk: sql<number | null>`${pj("$.pnl.winRateShrunk")}`,
        winRateBase: sql<number | null>`${pj("$.pnl.winRateBase")}`,
        closed: sql<number | null>`${pj("$.pnl.closedPositions")}`,
        medianHoldSec: sql<number | null>`${pj("$.hold.medianHoldSec")}`,
        sampleTokens: sql<number | null>`${pj("$.sample.tokens")}`,
      })
      .from(brains)
      .where(eq(brains.listed, true)),
  ]);
  const rowById = new Map(board.rows.map((r) => [r.id, r]));
  const member = (id: string, note: string | null): SquadMember | null => {
    const r = rowById.get(id);
    return r ? { ...r, note } : null;
  };
  const squads: Squad[] = [];
  const push = (s: Omit<Squad, "combined">) => {
    if (s.members.length >= 2) squads.push({ ...s, combined: combine(s.members) });
  };

  // Monthly top five: realized 30d from our own trades.
  push({
    slug: "monthly-top-five",
    kind: "top5",
    name: "Monthly top five",
    blurb: "The five wallets with the highest realized PnL over the last 30 days in our own index.",
    rule: "Top 5 by 30-day realized PnL (average cost, fees included), positive only. Re-ranked every few minutes.",
    members: board.rows
      .filter((r) => r.stats["30d"].realizedUsd > 0)
      .sort((a, b) => b.stats["30d"].realizedUsd - a.stats["30d"].realizedUsd)
      .slice(0, 5)
      .map((r) => ({ ...r, note: null })),
  });

  // Sharp shooters: win rate shrunk toward the population base rate (Beta prior), so small samples can't top it.
  const sharp = extra
    .filter((e) => e.winRateShrunk != null && e.winRateBase != null && Number(e.closed ?? 0) >= SHARP_MIN_CLOSED)
    .filter((e) => Number(e.winRateShrunk) > Number(e.winRateBase))
    .sort((a, b) => Number(b.winRateShrunk) - Number(a.winRateShrunk))
    .slice(0, 8)
    .flatMap((e) => member(e.id, `shrunk win rate ${fmtPctInt(Number(e.winRateShrunk))} · ${Number(e.closed)} closed`) ?? []);
  push({
    slug: "sharp-shooters",
    kind: "sharp",
    name: "Sharp shooters",
    blurb: "Highest win rates once luck is discounted: each wallet's win rate is shrunk toward the population average, so a 4-for-4 streak can't outrank 60 wins in 100.",
    rule: `Top 8 by shrunk win rate (Beta prior, 20 pseudo-positions at the population base rate), at least ${SHARP_MIN_CLOSED} closed positions, above the base rate.`,
    members: sharp,
  });

  // Early apes: entry-timing archetypes.
  const early = extra
    .filter((e) => e.archetypeId === "early_ape" || e.archetypeId === "sniper")
    .map((e) => ({ e, r: rowById.get(e.id) }))
    .filter((x): x is { e: (typeof extra)[number]; r: LeaderRow } => !!x.r)
    .sort((a, b) => (b.r.trackScore ?? -1) - (a.r.trackScore ?? -1))
    .slice(0, 10)
    .map(({ e, r }) => ({ ...r, note: e.archetypeId === "sniper" ? "sniper" : "early ape" }));
  push({
    slug: "early-apes",
    kind: "early",
    name: "Early apes",
    blurb: "Wallets whose profile says they get in first: launch snipers and early-curve buyers.",
    rule: "Archetype Sniper or Early ape (deterministic profile labels), top 10 by track score.",
    members: early,
  });

  // Diamond hands: long median holds.
  const diamond = extra
    .filter(
      (e) =>
        e.archetypeId === "diamond_hands" ||
        (Number(e.medianHoldSec ?? 0) >= DIAMOND_MIN_HOLD_SEC && Number(e.sampleTokens ?? 0) >= 5),
    )
    .sort((a, b) => Number(b.medianHoldSec ?? 0) - Number(a.medianHoldSec ?? 0))
    .slice(0, 10)
    .flatMap((e) => member(e.id, e.medianHoldSec != null ? `median hold ${fmtHours(Number(e.medianHoldSec))}` : "diamond hands") ?? []);
  push({
    slug: "diamond-hands",
    kind: "diamond",
    name: "Diamond hands",
    blurb: "The patient ones: wallets that typically hold for hours or days rather than seconds.",
    rule: `Archetype Diamond hands, or a median first-buy → first-sell hold of at least ${fmtHours(DIAMOND_MIN_HOLD_SEC)} over ≥5 tokens; top 10 by hold.`,
    members: diamond,
  });

  // Connectome circles: each multi-member Louvain region, named and keyed by its hub (highest PageRank).
  const byRegion = new Map<number, typeof graph.neurons>();
  for (const n of graph.neurons) {
    const list = byRegion.get(n.region);
    if (list) list.push(n);
    else byRegion.set(n.region, [n]);
  }
  const circles = [...byRegion.entries()]
    .filter(([, list]) => list.length >= 3)
    .map(([region, list]) => ({ region, list: [...list].sort((a, b) => b.pagerank - a.pagerank) }))
    .sort((a, b) => b.list.length - a.list.length);
  for (const { region, list } of circles) {
    const hub = list[0];
    const name = graph.regions.find((r) => r.id === region)?.name ?? `${hub.label} circle`;
    push({
      slug: `circle-${hub.id}`,
      kind: "circle",
      name,
      blurb: `A connectome region: wallets that repeatedly enter the same tokens in sequence. Hub: ${hub.label}.`,
      rule: "Louvain community of the connectome (co-entry synapses, permutation-tested), members ordered by influence (PageRank).",
      members: list.flatMap((n) => member(n.id, n.id === hub.id ? "hub" : n.leadShare != null ? `leads ${fmtPctInt(n.leadShare)} of co-entries` : null) ?? []),
    });
  }

  return { squads, sparkStart: board.sparkStart, computedAt: board.computedAt };
}
