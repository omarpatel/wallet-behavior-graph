/**
 * Recomputes the trading connectome (synapses + neurons tables) from first buys. Run by the worker every 10 min.
 * Model: see metrics.ts. No next/* imports: used by the worker process.
 */
import { UndirectedGraph } from "graphology";
import louvain from "graphology-communities-louvain";
import type { InStatement } from "@libsql/client";
import { getDbClient } from "@/db/client";
import { PUBLIC_DELAY_SEC } from "./types";
import {
  canonicalRegions,
  CONNECTOME_WINDOW_DAYS,
  CONNECTOME_WINDOW_SEC,
  pageRank,
  seededRng,
  significantSynapses,
  type FirstBuy,
} from "./metrics";

export interface RecomputeResult {
  firstBuys: number;
  coEntries: number;
  /** Pairs sharing ≥ MIN_SHARED_TOKENS tokens, tested against the null model. */
  candidates: number;
  synapses: number;
  neurons: number;
  regions: number;
  computedAt: number;
}

const SAMPLE_SIZE = 5;
const SEED = 0x6b6f6c; // "kol": Louvain + permutation null, so recomputes are reproducible

export async function recomputeConnectome({ windowDays = CONNECTOME_WINDOW_DAYS, windowSec = CONNECTOME_WINDOW_SEC } = {}): Promise<RecomputeResult> {
  const client = getDbClient();
  const now = Math.floor(Date.now() / 1000);
  const since = now - windowDays * 86_400;

  // A brain's true first buy of each token (all history), kept when it falls inside the window: re-buys of a token
  // first bought before the window are not entries. block_time and slot are monotone, so both minima are that buy.
  const [fb, brainRows] = await Promise.all([
    client.execute({
      sql: `select brain_id, mint, min(block_time) as t, min(slot) as slot from trades where side = 'buy' group by brain_id, mint having t >= ?`,
      args: [since],
    }),
    client.execute(`select id from brains`),
  ]);
  const firstBuys: FirstBuy[] = fb.rows.map((r) => ({
    brainId: String(r.brain_id),
    mint: String(r.mint),
    t: Number(r.t),
    slot: Number(r.slot),
  }));
  const brainIds = brainRows.rows.map((r) => String(r.id)).sort();

  const sig = significantSynapses(firstBuys, { windowSec, seed: SEED });
  const synapses = sig.synapses;

  // Sample symbols for the stored examples (public: only co-entries older than the public delay).
  const publicBefore = now - PUBLIC_DELAY_SEC;
  const samples = synapses.map((s) => s.sample.filter((e) => e.at <= publicBefore).slice(0, SAMPLE_SIZE));
  const sampleMints = [...new Set(samples.flat().map((e) => e.mint))];
  const symbols = new Map<string, string | null>();
  for (let i = 0; i < sampleMints.length; i += 500) {
    const chunk = sampleMints.slice(i, i + 500);
    const r = await client.execute({
      sql: `select mint, symbol from tokens where mint in (${chunk.map(() => "?").join(",")})`,
      args: chunk,
    });
    for (const row of r.rows) symbols.set(String(row.mint), row.symbol == null ? null : String(row.symbol));
  }

  // Regions: Louvain on the undirected projection (weight = both directions summed), fixed seed.
  const und = new UndirectedGraph<Record<string, unknown>, { weight: number }>();
  for (const s of synapses) {
    und.mergeNode(s.pre);
    und.mergeNode(s.post);
    if (und.hasEdge(s.pre, s.post)) und.updateEdgeAttribute(s.pre, s.post, "weight", (w) => (w ?? 0) + s.weight);
    else und.addEdge(s.pre, s.post, { weight: s.weight });
  }
  const communities = und.order ? louvain(und, { getEdgeWeight: "weight", rng: seededRng(SEED) }) : {};
  const region = canonicalRegions(brainIds, communities);

  // Influence: PageRank on the reversed graph (follower → leader).
  const rank = pageRank(
    brainIds,
    synapses.map((s) => ({ from: s.post, to: s.pre, weight: s.weight })),
  );

  const inW = new Map<string, number>();
  const outW = new Map<string, number>();
  const partners = new Map<string, Set<string>>();
  for (const s of synapses) {
    outW.set(s.pre, (outW.get(s.pre) ?? 0) + s.weight);
    inW.set(s.post, (inW.get(s.post) ?? 0) + s.weight);
    if (!partners.has(s.pre)) partners.set(s.pre, new Set());
    if (!partners.has(s.post)) partners.set(s.post, new Set());
    partners.get(s.pre)!.add(s.post);
    partners.get(s.post)!.add(s.pre);
  }
  const entries = new Map<string, number>();
  for (const f of firstBuys) entries.set(f.brainId, (entries.get(f.brainId) ?? 0) + 1);

  const stmts: InStatement[] = [`delete from synapses`, `delete from neurons`];
  synapses.forEach((s, i) => {
    const sample = samples[i].map((e) => ({ mint: e.mint, symbol: symbols.get(e.mint) ?? null, lagSec: e.lagSec, at: e.at }));
    stmts.push({
      sql: `insert into synapses (pre, post, weight, events, median_lag_sec, last_event_at, sample_json, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [s.pre, s.post, s.weight, s.events, s.medianLagSec, s.lastEventAt, JSON.stringify(sample), now],
    });
  });
  for (const id of brainIds) {
    const i = inW.get(id) ?? 0;
    const o = outW.get(id) ?? 0;
    stmts.push({
      sql: `insert into neurons (brain_id, region, pagerank, in_weight, out_weight, lead_share, partners, entries, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, region.get(id)!, rank.get(id) ?? 0, i, o, i + o > 0 ? o / (i + o) : null, partners.get(id)?.size ?? 0, entries.get(id) ?? 0, now],
    });
  }
  await client.batch(stmts, "write");

  return {
    firstBuys: firstBuys.length,
    coEntries: sig.coEntries,
    candidates: sig.candidates,
    synapses: synapses.length,
    neurons: brainIds.length,
    regions: new Set(region.values()).size,
    computedAt: now,
  };
}
