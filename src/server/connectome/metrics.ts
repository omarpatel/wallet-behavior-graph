/**
 * Pure connectome primitives (no DB): co-entry detection, IDF weighting, permutation-null significance, synapse
 * aggregation, weighted PageRank, deterministic region naming, signal cascades, strongest paths and capital rotations.
 * Definitions shown at /methodology#connectome.
 */

/** Look-back for first buys. */
export const CONNECTOME_WINDOW_DAYS = 30;
/** Co-entry window W: the later brain entered within 60 min of the earlier one. */
export const CONNECTOME_WINDOW_SEC = 3600;
/** Lag decay τ: a co-entry Δt seconds apart contributes idf · exp(−Δt/τ). */
export const CO_ENTRY_TAU_SEC = 900;
/** Entries ≤ this many slots apart are near-simultaneous (bots/bundles), not a lead → follow relation. */
export const GAP_SLOTS = 2;
/** Within-token permutations for the null model, and the significance bar for keeping a synapse. */
export const NULL_SHUFFLES = 100;
export const MIN_Z = 3;
export const MIN_SHARED_TOKENS = 3;
/** Cascade activation threshold on summed input share (FlyWire information-flow model). */
export const CASCADE_THRESHOLD = 0.3;
/** Rotation edge window: a sell followed by the next buy within this many seconds. */
export const ROTATION_WINDOW_SEC = 180;

export interface FirstBuy {
  brainId: string;
  mint: string;
  /** First buy of `mint` by `brainId` (unix s) and its slot. */
  t: number;
  slot: number;
}

export interface CoEntry {
  pre: string;
  post: string;
  mint: string;
  lagSec: number;
  /** When the co-entry completed (post's first buy). */
  at: number;
  /** idf(mint) · exp(−lag/τ). */
  contribution: number;
}

export interface SynapseAgg {
  pre: string;
  post: string;
  weight: number;
  /** Co-entries = distinct shared tokens where pre entered first (one first buy per token). */
  events: number;
  medianLagSec: number;
  lastEventAt: number;
  /** Permutation-null z-score of `weight`. */
  z: number;
  /** Most recent co-entries first (caller trims / filters). */
  sample: { mint: string; lagSec: number; at: number }[];
}

export interface CoEntryOptions {
  windowSec: number;
  tauSec: number;
  gapSlots: number;
}

export const DEFAULT_CO_ENTRY: CoEntryOptions = { windowSec: CONNECTOME_WINDOW_SEC, tauSec: CO_ENTRY_TAU_SEC, gapSlots: GAP_SLOTS };

/**
 * Token popularity normalisation: idf(m) = ln((N + 1) / (n_m + 1)), N = brains active in the window, n_m = brains that
 * first-bought m in it. A token everyone apes (n_m = N) contributes nothing; a rare shared token contributes most.
 */
export function idf(n: number, N: number): number {
  return Math.log((N + 1) / (n + 1));
}

type Emit = (pre: string, post: string, lagSec: number, at: number, contribution: number) => void;

/** Lead → follow pairs within one token's entrants (`list` sorted by time, slot). */
function tokenPairs(list: { brainId: string; t: number; slot: number }[], w: number, o: CoEntryOptions, emit: Emit): void {
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      const lag = b.t - a.t;
      if (lag > o.windowSec) break;
      if (lag <= 0 || Math.abs(b.slot - a.slot) <= o.gapSlots || a.brainId === b.brainId) continue;
      emit(a.brainId, b.brainId, lag, b.t, w * Math.exp(-lag / o.tauSec));
    }
  }
}

interface TokenGroup {
  mint: string;
  idf: number;
  entrants: FirstBuy[];
}

function groupByToken(firstBuys: FirstBuy[]): TokenGroup[] {
  const N = new Set(firstBuys.map((f) => f.brainId)).size;
  const byMint = new Map<string, FirstBuy[]>();
  for (const f of firstBuys) {
    const list = byMint.get(f.mint);
    if (list) list.push(f);
    else byMint.set(f.mint, [f]);
  }
  const groups: TokenGroup[] = [];
  for (const [mint, list] of [...byMint].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.t - b.t || a.slot - b.slot || (a.brainId < b.brainId ? -1 : 1));
    groups.push({ mint, idf: idf(new Set(list.map((f) => f.brainId)).size, N), entrants: list });
  }
  return groups;
}

/**
 * Directed co-entries: for each token, every pair of brains with 0 < Δt ≤ W between first buys, direction earlier →
 * later. Same-second and near-simultaneous (|Δslot| ≤ gapSlots) entries carry no lead/follow signal and are skipped.
 */
export function coEntries(firstBuys: FirstBuy[], o: CoEntryOptions = DEFAULT_CO_ENTRY): CoEntry[] {
  const out: CoEntry[] = [];
  for (const g of groupByToken(firstBuys)) {
    tokenPairs(g.entrants, g.idf, o, (pre, post, lagSec, at, contribution) =>
      out.push({ pre, post, mint: g.mint, lagSec, at, contribution }),
    );
  }
  return out;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const pairKey = (pre: string, post: string) => `${pre}\u0000${post}`;

/**
 * Null model: K shuffles that permute entry (time, slot) within each token across its entrants — token popularity and
 * each brain's activity are preserved, who-precedes-whom is broken. Returns per-pair mean and sd of the shuffled weight
 * for the requested pairs.
 */
export function nullWeights(
  firstBuys: FirstBuy[],
  pairs: Set<string>,
  { shuffles = NULL_SHUFFLES, seed = 1, ...o }: Partial<CoEntryOptions> & { shuffles?: number; seed?: number } = {},
): Map<string, { mean: number; sd: number }> {
  const opts = { ...DEFAULT_CO_ENTRY, ...o };
  const rng = seededRng(seed);
  const groups = groupByToken(firstBuys);
  const sum = new Map<string, number>();
  const sumSq = new Map<string, number>();
  for (let k = 0; k < shuffles; k++) {
    const w = new Map<string, number>();
    for (const g of groups) {
      const times = g.entrants.map((f) => ({ t: f.t, slot: f.slot }));
      for (let i = times.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [times[i], times[j]] = [times[j], times[i]];
      }
      const shuffled = g.entrants
        .map((f, i) => ({ brainId: f.brainId, t: times[i].t, slot: times[i].slot }))
        .sort((a, b) => a.t - b.t || a.slot - b.slot);
      tokenPairs(shuffled, g.idf, opts, (pre, post, _lag, _at, c) => {
        const key = pairKey(pre, post);
        if (pairs.has(key)) w.set(key, (w.get(key) ?? 0) + c);
      });
    }
    for (const [key, v] of w) {
      sum.set(key, (sum.get(key) ?? 0) + v);
      sumSq.set(key, (sumSq.get(key) ?? 0) + v * v);
    }
  }
  const out = new Map<string, { mean: number; sd: number }>();
  for (const key of pairs) {
    const mean = (sum.get(key) ?? 0) / shuffles;
    const variance = Math.max(0, (sumSq.get(key) ?? 0) / shuffles - mean * mean);
    out.set(key, { mean, sd: Math.sqrt(variance) });
  }
  return out;
}

/**
 * Synapses: co-entries aggregated per (pre, post) — weight = Σ contributions — kept when they share ≥ minTokens tokens
 * and beat the within-token permutation null by z ≥ minZ. A zero-variance null (the shuffles never reproduce the
 * pair) counts as significant when the observed weight exceeds its mean.
 */
export function significantSynapses(
  firstBuys: FirstBuy[],
  {
    minTokens = MIN_SHARED_TOKENS,
    minZ = MIN_Z,
    shuffles = NULL_SHUFFLES,
    seed = 1,
    ...o
  }: Partial<CoEntryOptions> & { minTokens?: number; minZ?: number; shuffles?: number; seed?: number } = {},
): { coEntries: number; candidates: number; synapses: SynapseAgg[] } {
  const opts = { ...DEFAULT_CO_ENTRY, ...o };
  const events = coEntries(firstBuys, opts);
  const byPair = new Map<string, CoEntry[]>();
  for (const e of events) {
    const k = pairKey(e.pre, e.post);
    const list = byPair.get(k);
    if (list) list.push(e);
    else byPair.set(k, [e]);
  }
  const candidates = new Set([...byPair].filter(([, l]) => l.length >= minTokens).map(([k]) => k));
  const nulls = nullWeights(firstBuys, candidates, { ...opts, shuffles, seed });
  const out: SynapseAgg[] = [];
  for (const key of candidates) {
    const list = byPair.get(key)!;
    const weight = list.reduce((s, e) => s + e.contribution, 0);
    const { mean, sd } = nulls.get(key)!;
    const z = sd > 0 ? (weight - mean) / sd : weight > mean ? Number.MAX_VALUE : 0;
    if (z < minZ) continue;
    list.sort((a, b) => b.at - a.at);
    out.push({
      pre: list[0].pre,
      post: list[0].post,
      weight,
      events: list.length,
      medianLagSec: Math.round(median(list.map((e) => e.lagSec))),
      lastEventAt: list[0].at,
      z,
      sample: list.map((e) => ({ mint: e.mint, lagSec: e.lagSec, at: e.at })),
    });
  }
  out.sort((a, b) => b.weight - a.weight || (a.pre + a.post < b.pre + b.post ? -1 : 1));
  return { coEntries: events.length, candidates: candidates.size, synapses: out };
}

export interface WeightedEdge {
  from: string;
  to: string;
  weight: number;
}

/**
 * Weighted PageRank by power iteration (damping 0.85). Rank flows along `edges` proportionally to weight; dangling
 * nodes spread uniformly. Returns scores normalised so the maximum is 1. Callers pass the follower → leader graph so
 * influence accumulates at brains that are consistently entered after.
 */
export function pageRank(nodes: string[], edges: WeightedEdge[], damping = 0.85, iterations = 100, tol = 1e-10): Map<string, number> {
  const n = nodes.length;
  const out = new Map<string, number>();
  if (!n) return out;
  const idx = new Map(nodes.map((id, i) => [id, i]));
  const outW = new Float64Array(n);
  const adj: { to: number; w: number }[][] = nodes.map(() => []);
  for (const e of edges) {
    const a = idx.get(e.from);
    const b = idx.get(e.to);
    if (a == null || b == null || !(e.weight > 0) || a === b) continue;
    adj[a].push({ to: b, w: e.weight });
    outW[a] += e.weight;
  }
  let pr = new Float64Array(n).fill(1 / n);
  for (let it = 0; it < iterations; it++) {
    const next = new Float64Array(n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (outW[i] === 0) {
        dangling += pr[i];
        continue;
      }
      for (const { to, w } of adj[i]) next[to] += (damping * pr[i] * w) / outW[i];
    }
    const base = (1 - damping) / n + (damping * dangling) / n;
    let diff = 0;
    for (let i = 0; i < n; i++) {
      next[i] += base;
      diff += Math.abs(next[i] - pr[i]);
    }
    pr = next;
    if (diff < tol) break;
  }
  const max = Math.max(...pr);
  nodes.forEach((id, i) => out.set(id, max > 0 ? pr[i] / max : 0));
  return out;
}

/** Deterministic PRNG (mulberry32) so Louvain regions are stable between recomputes. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Renumbers raw community ids to 0..k−1 ordered by size desc, then smallest member id; nodes missing from
 * `communities` (no synapses) get their own singleton region after all communities.
 */
export function canonicalRegions(nodes: string[], communities: Record<string, number>): Map<string, number> {
  const groups = new Map<number, string[]>();
  for (const id of nodes) {
    const c = communities[id];
    if (c == null) continue;
    const list = groups.get(c);
    if (list) list.push(id);
    else groups.set(c, [id]);
  }
  const ordered = [...groups.values()]
    .map((m) => m.sort())
    .sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));
  const out = new Map<string, number>();
  ordered.forEach((members, i) => members.forEach((id) => out.set(id, i)));
  let next = ordered.length;
  for (const id of [...nodes].sort()) if (!out.has(id)) out.set(id, next++);
  return out;
}

/** Region trait thresholds: members' median entry delay below this → "fast-entry cortex". */
export const FAST_ENTRY_SEC = 60;
/** Members' median lead share at or above this → "lead nucleus". */
export const LEAD_SHARE_HIGH = 0.6;

export interface RegionMember {
  region: number;
  /** Public title (brainTitle: owner / platform-attributed public name, else codename). */
  label: string;
  pagerank: number;
  leadShare: number | null;
  medianEntryDelaySec: number | null;
}

/**
 * Region names after the hub (highest-PageRank member; ties by label) plus an anatomical suffix from the region's
 * dominant trait: members' median entry delay < 60 s → "fast-entry cortex"; else median lead share ≥ 0.6 →
 * "lead nucleus"; else "cluster". One-neuron regions are "Unwired · <label>". Hub labels are unique per brain, so
 * names don't collide in practice; a repeated name still gets " 2", " 3"….
 */
export function regionNames(members: RegionMember[]): Map<number, { name: string; size: number }> {
  const byRegion = new Map<number, RegionMember[]>();
  for (const m of members) {
    const list = byRegion.get(m.region);
    if (list) list.push(m);
    else byRegion.set(m.region, [m]);
  }
  const used = new Map<string, number>();
  const out = new Map<number, { name: string; size: number }>();
  for (const region of [...byRegion.keys()].sort((a, b) => a - b)) {
    const list = byRegion.get(region)!;
    const hub = [...list].sort((a, b) => b.pagerank - a.pagerank || (a.label < b.label ? -1 : 1))[0];
    let base: string;
    if (list.length === 1) {
      base = `Unwired · ${hub.label}`;
    } else {
      const delays = list.flatMap((m) => (m.medianEntryDelaySec == null ? [] : [m.medianEntryDelaySec]));
      const leads = list.flatMap((m) => (m.leadShare == null ? [] : [m.leadShare]));
      const suffix =
        delays.length && median(delays) < FAST_ENTRY_SEC
          ? "fast-entry cortex"
          : leads.length && median(leads) >= LEAD_SHARE_HIGH
            ? "lead nucleus"
            : "cluster";
      base = `${hub.label} ${suffix}`;
    }
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    out.set(region, { name: n > 1 ? `${base} ${n}` : base, size: list.length });
  }
  return out;
}

export interface GraphSynapse {
  pre: string;
  post: string;
  weight: number;
  medianLagSec: number;
}

export interface CascadeStep {
  id: string;
  depth: number;
  via: string;
  cumulativeLagSec: number;
  strength: number;
}

/** Input share in_ij = w_ij / Σ_k w_kj: the fraction of j's incoming weight that comes from i. */
export function inShares(synapses: GraphSynapse[]): Map<GraphSynapse, number> {
  const inTotal = new Map<string, number>();
  for (const s of synapses) inTotal.set(s.post, (inTotal.get(s.post) ?? 0) + s.weight);
  return new Map(synapses.map((s) => [s, s.weight / inTotal.get(s.post)!]));
}

/**
 * Signal cascade from `source` (deterministic FlyWire information-flow model): start with active = {source}; at each
 * step every inactive neuron j whose summed input share from active neurons Σ in_ij ≥ threshold activates at that
 * depth. `strength` = that summed share (capped at 1); `via` = the active input contributing most; lag accumulates
 * via's cumulative lag + the via → j median lag. Stops after `depth` steps or when nothing new activates.
 */
export function cascade(synapses: GraphSynapse[], source: string, depth: number, threshold = CASCADE_THRESHOLD): CascadeStep[] {
  const share = inShares(synapses);
  const incoming = new Map<string, GraphSynapse[]>();
  for (const s of synapses) {
    if (s.pre === s.post) continue;
    const list = incoming.get(s.post);
    if (list) list.push(s);
    else incoming.set(s.post, [s]);
  }
  const lagOf = new Map<string, number>([[source, 0]]);
  const steps: CascadeStep[] = [];
  for (let d = 1; d <= depth; d++) {
    const layer: CascadeStep[] = [];
    for (const [j, inputs] of incoming) {
      if (lagOf.has(j)) continue;
      let total = 0;
      let best: GraphSynapse | null = null;
      for (const s of inputs) {
        if (!lagOf.has(s.pre)) continue;
        const sh = share.get(s)!;
        total += sh;
        if (!best || sh > share.get(best)! || (sh === share.get(best)! && s.pre < best.pre)) best = s;
      }
      if (best && total >= threshold - 1e-12) {
        layer.push({ id: j, depth: d, via: best.pre, cumulativeLagSec: lagOf.get(best.pre)! + best.medianLagSec, strength: Math.min(1, total) });
      }
    }
    if (!layer.length) break;
    layer.sort((a, b) => b.strength - a.strength || (a.id < b.id ? -1 : 1));
    for (const s of layer) lagOf.set(s.id, s.cumulativeLagSec);
    steps.push(...layer);
  }
  return steps;
}

/**
 * Most probable directed chain (Dijkstra) with hop cost −ln(in_share), so the cheapest path maximises the product of
 * the followers' input shares. Returns null when `to` is unreachable, [] when from = to.
 */
export function strongestPath(synapses: GraphSynapse[], from: string, to: string): GraphSynapse[] | null {
  if (from === to) return [];
  const share = inShares(synapses.filter((s) => s.weight > 0));
  const outgoing = new Map<string, GraphSynapse[]>();
  for (const s of share.keys()) {
    const list = outgoing.get(s.pre);
    if (list) list.push(s);
    else outgoing.set(s.pre, [s]);
  }
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, GraphSynapse>();
  const done = new Set<string>();
  // Graphs are small (tens to hundreds of neurons): a linear-scan priority queue is enough.
  const open = new Set([from]);
  while (open.size) {
    let u: string | null = null;
    let du = Infinity;
    for (const id of open) {
      const d = dist.get(id)!;
      if (d < du || (d === du && u != null && id < u)) {
        u = id;
        du = d;
      }
    }
    if (u == null) break;
    open.delete(u);
    done.add(u);
    if (u === to) break;
    for (const s of outgoing.get(u) ?? []) {
      if (done.has(s.post)) continue;
      const nd = du - Math.log(share.get(s)!);
      if (nd < (dist.get(s.post) ?? Infinity)) {
        dist.set(s.post, nd);
        prev.set(s.post, s);
        open.add(s.post);
      }
    }
  }
  if (!prev.has(to)) return null;
  const hops: GraphSynapse[] = [];
  for (let cur = to; cur !== from; ) {
    const s = prev.get(cur)!;
    hops.push(s);
    cur = s.pre;
  }
  return hops.reverse();
}

export interface RotationTrade {
  side: "buy" | "sell";
  mint: string;
  blockTime: number;
  /** Tiebreak within a second (e.g. slot·1e4 + txIndex); sells sort before buys at equal keys. */
  order: number;
}

/**
 * Capital rotations: a sell of A followed by the brain's next buy of B ≠ A within `windowSec`. Every sell still
 * pending when a buy lands links to that buy (a sell's "next buy" is consumed by the first buy after it).
 */
export function rotations(trades: RotationTrade[], windowSec = ROTATION_WINDOW_SEC): { from: string; to: string; count: number }[] {
  const sorted = [...trades].sort(
    (a, b) => a.blockTime - b.blockTime || a.order - b.order || (a.side === b.side ? 0 : a.side === "sell" ? -1 : 1),
  );
  const pending = new Map<string, number>(); // sold mint → last sell time
  const counts = new Map<string, { from: string; to: string; count: number }>();
  for (const t of sorted) {
    if (t.side === "sell") {
      pending.set(t.mint, t.blockTime);
      continue;
    }
    for (const [mint, at] of pending) {
      if (mint === t.mint || t.blockTime - at > windowSec) continue;
      const k = `${mint}\u0000${t.mint}`;
      const c = counts.get(k);
      if (c) c.count++;
      else counts.set(k, { from: mint, to: t.mint, count: 1 });
    }
    pending.clear();
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || (a.from + a.to < b.from + b.to ? -1 : 1));
}
