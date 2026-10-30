import "server-only";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { connection } from "next/server";
import { getDb, schema } from "@/db/client";
import { hasBrainAccess } from "@/server/access";
import { buildPositions, replayPosition } from "@/server/profile/metrics";
import { nowSec } from "@/server/queries/shared";
import { readSnapshot, SNAPSHOT_KEYS } from "@/server/snapshots/store";
import { loadGraph } from "./graph";
import { cascade, CONNECTOME_WINDOW_DAYS, CONNECTOME_WINDOW_SEC, rotations, strongestPath } from "./metrics";
import {
  PUBLIC_DELAY_SEC,
  type CascadeDTO,
  type ConnectomeDTO,
  type NeuronDTO,
  type PathDTO,
  type RegionDTO,
  type ReplayDTO,
  type ReplayListDTO,
  type SynapseDTO,
  type TokenGraphDTO,
} from "./types";

const { brains, trades, tokens } = schema;

const TOKEN_GRAPH_DAYS = 30;
const TOKEN_GRAPH_MAX_TOKENS = 120;
/** Request-time bound: hyperactive wallets (bots) are drawn from their newest trades only. */
const TOKEN_GRAPH_MAX_TRADES = 6_000;
const ROTATION_KEEP_TOP = 200;
const WIRING_TOP = 8;

/** Public connectome. `region` keeps that region's neurons and the synapses between them. */
export async function getConnectome(opts: { minWeight?: number; region?: number } = {}): Promise<ConnectomeDTO> {
  await connection();
  const g = await loadGraph();
  const minWeight = opts.minWeight ?? 0;
  const neuronsOut = opts.region == null ? g.neurons : g.neurons.filter((n) => n.region === opts.region);
  const kept = new Set(neuronsOut.map((n) => n.id));
  return {
    windowDays: CONNECTOME_WINDOW_DAYS,
    windowSec: CONNECTOME_WINDOW_SEC,
    computedAt: g.computedAt,
    neurons: neuronsOut,
    synapses: g.synapses.filter((s) => s.weight >= minWeight && kept.has(s.pre) && kept.has(s.post)),
    regions: opts.region == null ? g.regions : g.regions.filter((r) => r.id === opts.region),
  };
}

export interface NeuronWiring {
  neuron: NeuronDTO | null;
  /** Strongest synapses where this brain followed (post = brain), top 8 by weight. */
  inputs: SynapseDTO[];
  /** Strongest synapses where this brain led (pre = brain), top 8 by weight. */
  outputs: SynapseDTO[];
  region: RegionDTO | null;
  /** Neurons referenced by `inputs`/`outputs` (for labels). */
  partners: Record<string, NeuronDTO>;
  /** All regions (names/sizes for partner region chips). */
  regions: RegionDTO[];
}

/** One brain's wiring for the brain page (public). */
export async function getNeuronWiring(brainId: string): Promise<NeuronWiring> {
  await connection();
  const g = await loadGraph();
  const neuron = g.neurons.find((n) => n.id === brainId) ?? null;
  const inputs = g.synapses.filter((s) => s.post === brainId).slice(0, WIRING_TOP);
  const outputs = g.synapses.filter((s) => s.pre === brainId).slice(0, WIRING_TOP);
  const ids = new Set([...inputs.map((s) => s.pre), ...outputs.map((s) => s.post)]);
  return {
    neuron,
    inputs,
    outputs,
    region: neuron ? (g.regions.find((r) => r.id === neuron.region) ?? null) : null,
    partners: Object.fromEntries(g.neurons.filter((n) => ids.has(n.id)).map((n) => [n.id, n])),
    regions: g.regions,
  };
}

/** Who typically enters after `source`, layer by layer. Null when `source` is not a (listed) neuron. */
export async function getCascade(source: string, depth = 3): Promise<CascadeDTO | null> {
  await connection();
  const g = await loadGraph();
  if (!g.neurons.some((n) => n.id === source)) return null;
  return { source, steps: cascade(g.synapses, source, depth) };
}

/** Strongest directed path between two neurons. Null when either is not a (listed) neuron. */
export async function getPath(from: string, to: string): Promise<PathDTO | null> {
  await connection();
  const g = await loadGraph();
  if (!g.neurons.some((n) => n.id === from) || !g.neurons.some((n) => n.id === to)) return null;
  const hops = strongestPath(g.synapses, from, to);
  return {
    from,
    to,
    hops: hops?.map((h) => ({ pre: h.pre, post: h.post, weight: h.weight, medianLagSec: h.medianLagSec })) ?? null,
  };
}

/**
 * A brain's own token wiring over the last 30 days (newest TOKEN_GRAPH_MAX_TRADES trades at most): top tokens by buy
 * USD and capital rotations between them. Viewers without access to the brain only see trades older than
 * PUBLIC_DELAY_SEC. Null when the brain is unknown.
 */
export async function getTokenGraph(brainId: string, viewerWallet: string | null): Promise<TokenGraphDTO | null> {
  await connection();
  const db = getDb();
  const [brain] = await db.select({ id: brains.id }).from(brains).where(eq(brains.id, brainId)).limit(1);
  if (!brain) return null;
  const delayed = !(await hasBrainAccess(viewerWallet, brainId)).ok;
  const now = nowSec();

  const newest = await db
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
    .where(
      and(
        eq(trades.brainId, brainId),
        gte(trades.blockTime, now - TOKEN_GRAPH_DAYS * 86_400),
        delayed ? lte(trades.blockTime, now - PUBLIC_DELAY_SEC) : undefined,
      ),
    )
    .orderBy(desc(trades.blockTime))
    .limit(TOKEN_GRAPH_MAX_TRADES);
  const rows = newest.reverse();

  const perMint = new Map<string, { buyUsd: number; trades: number; launchpad: string | null }>();
  for (const t of rows) {
    const m = perMint.get(t.mint) ?? { buyUsd: 0, trades: 0, launchpad: null };
    m.trades++;
    if (t.side === "buy") m.buyUsd += t.usdValue ?? 0;
    m.launchpad ??= t.launchpad;
    perMint.set(t.mint, m);
  }
  const top = [...perMint.entries()]
    .filter(([, m]) => m.buyUsd > 0)
    .sort((a, b) => b[1].buyUsd - a[1].buyUsd || (a[0] < b[0] ? -1 : 1))
    .slice(0, TOKEN_GRAPH_MAX_TOKENS);
  const topSet = new Set(top.map(([mint]) => mint));

  const positions = new Map(
    buildPositions(rows.filter((t) => topSet.has(t.mint))).map((p) => [p.mint, p]),
  );
  const meta = new Map<string, { symbol: string | null; icon: string | null; launchpad: string | null }>();
  const mints = [...topSet];
  for (let i = 0; i < mints.length; i += 200) {
    const chunk = mints.slice(i, i + 200);
    const tk = await db
      .select({ mint: tokens.mint, symbol: tokens.symbol, icon: tokens.icon, launchpad: tokens.launchpad })
      .from(tokens)
      .where(sql`${tokens.mint} in ${chunk}`);
    for (const t of tk) meta.set(t.mint, t);
  }

  const rot = rotations(
    rows.filter((t) => topSet.has(t.mint)).map((t) => ({ side: t.side, mint: t.mint, blockTime: t.blockTime, order: t.slot * 10_000 + t.txIndex })),
  ).filter((r, i) => r.count >= 2 || i < ROTATION_KEEP_TOP);

  return {
    brainId,
    delayed,
    tokens: top.map(([mint, m]) => {
      const p = positions.get(mint);
      const k = meta.get(mint);
      return {
        mint,
        symbol: k?.symbol ?? null,
        icon: k?.icon ?? null,
        buyUsd: m.buyUsd,
        realizedUsd: p?.realizedUsd ?? 0,
        trades: m.trades,
        launchpad: k?.launchpad ?? m.launchpad,
        open: p ? !p.closed : false,
      };
    }),
    rotations: rot,
  };
}

/** Recent tokens entered by ≥3 tracked brains (`replays` snapshot, computed by the worker; empty until then). */
export async function getReplays(): Promise<ReplayListDTO> {
  await connection();
  return (await readSnapshot<ReplayListDTO>(SNAPSHOT_KEYS.replays))?.value ?? { tokens: [] };
}

/**
 * One token's spread through the tracked brains: entries ranked by first buy, exits when a position was closed
 * (≤1% of peak left). Only trades older than PUBLIC_DELAY_SEC are used. Null when there is no public entry.
 */
export async function getReplay(mint: string): Promise<ReplayDTO | null> {
  await connection();
  const db = getDb();
  const publicBefore = nowSec() - PUBLIC_DELAY_SEC;
  // first buy per listed brain of this token (trades_mint_time), public once older than the delay
  const firsts = await db.all<{ brain_id: string; at: number; slot: number }>(sql`
    select t.brain_id as brain_id, min(t.block_time) as at, min(t.slot) as slot
    from ${trades} t join ${brains} b on b.id = t.brain_id and b.listed = 1
    where t.mint = ${mint} and t.side = 'buy'
    group by t.brain_id
    having min(t.block_time) <= ${publicBefore}
    order by at, slot, brain_id`);
  if (!firsts.length) return null;

  const ids = firsts.map((f) => f.brain_id);
  const [rows, [meta]] = await Promise.all([
    db
      .select({
        brainId: trades.brainId,
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
      .where(and(eq(trades.mint, mint), inArray(trades.brainId, ids), lte(trades.blockTime, publicBefore))),
    db.select({ symbol: tokens.symbol, icon: tokens.icon }).from(tokens).where(eq(tokens.mint, mint)).limit(1),
  ]);

  const exits: ReplayDTO["exits"] = [];
  for (const id of ids) {
    const p = replayPosition(rows.filter((t) => t.brainId === id));
    const last = p?.sellFills.at(-1);
    if (p?.closed && last) exits.push({ brainId: id, at: last.blockTime });
  }
  exits.sort((a, b) => a.at - b.at || (a.brainId < b.brainId ? -1 : 1));

  return {
    mint,
    symbol: meta?.symbol ?? null,
    icon: meta?.icon ?? null,
    entries: firsts.map((f, i) => ({ brainId: f.brain_id, at: Number(f.at), side: "buy" as const, rank: i + 1 })),
    exits,
  };
}
