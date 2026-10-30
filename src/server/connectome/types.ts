/**
 * Connectome contract shared by the compute layer (src/server/connectome), API routes and the UI.
 * Neurons = brains (wallets). Synapses = directed co-entry relations (pre bought a token first, post followed
 * within the window). Regions = Louvain communities. Firing = live trades.
 */

export interface NeuronDTO {
  id: string; // brain id
  label: string; // brainTitle(): owner name (claimed), KOL public name (platform-attributed), else codename
  codename: string; // neutral codename (always; secondary label when label ≠ codename)
  avatarUrl: string | null; // brainAvatar(): claimed avatar or platform pfp, else null (no likeness)
  /** "via Public directory · codename X" (platform-attributed), "Publicly attributed to X · src" (community), else null. */
  attribution: string | null;
  claimed: boolean;
  tier: "S" | "A" | "B" | "C" | "unrated";
  archetype: string; // archetype label
  region: number;
  pagerank: number; // 0..1 normalised within the graph
  leadShare: number | null;
  inWeight: number;
  outWeight: number;
  partners: number;
  entries: number; // first-buys in the window
  realizedUsd: number | null; // profile 90d
}

export interface SynapseDTO {
  pre: string;
  post: string;
  weight: number;
  events: number;
  medianLagSec: number;
  lastEventAt: number;
  /** Example co-entries (public: only events older than PUBLIC_DELAY_SEC). */
  sample: { mint: string; symbol: string | null; lagSec: number; at: number }[];
}

export interface RegionDTO {
  id: number;
  name: string; // deterministic name derived from members' dominant archetype, e.g. "Sniper cortex"
  size: number;
}

export interface ConnectomeDTO {
  windowDays: number;
  windowSec: number; // co-entry window
  computedAt: number;
  neurons: NeuronDTO[];
  synapses: SynapseDTO[];
  regions: RegionDTO[];
}

/** Signal cascade: who typically follows `source`, layer by layer (BFS over outgoing synapses). */
export interface CascadeDTO {
  source: string;
  steps: { id: string; depth: number; via: string; cumulativeLagSec: number; strength: number }[];
}

/** Strongest directed path between two neurons (Dijkstra on cost = −ln(normalised weight)). */
export interface PathDTO {
  from: string;
  to: string;
  hops: { pre: string; post: string; weight: number; medianLagSec: number }[] | null;
}

/** Live firing event (public SSE): brain level only — no token, so the seat-gated edge isn't leaked. */
export interface FiringDTO {
  id: number; // trade id (cursor)
  brainId: string;
  side: "buy" | "sell";
  at: number; // block time
  sizeBucket: 1 | 2 | 3; // <1 SOL, 1–10 SOL, >10 SOL
}

/** Per-brain token connectome: the brain's own wiring of tokens and capital rotations. */
export interface TokenGraphDTO {
  brainId: string;
  delayed: boolean; // true when the viewer has no access → only trades older than PUBLIC_DELAY_SEC
  tokens: {
    mint: string;
    symbol: string | null;
    icon: string | null;
    buyUsd: number;
    realizedUsd: number;
    trades: number;
    launchpad: string | null;
    open: boolean;
  }[];
  /** Capital rotation: sold `from`, then bought `to` within ROTATION_WINDOW_SEC. */
  rotations: { from: string; to: string; count: number }[];
}

export const PUBLIC_DELAY_SEC = 3600;

/** Tokens available for replay: entered by ≥3 tracked brains, first tracked entry older than PUBLIC_DELAY_SEC. */
export interface ReplayListDTO {
  tokens: { mint: string; symbol: string | null; icon: string | null; brains: number; firstAt: number }[];
}

/**
 * One token spreading through the brain: every tracked brain's first buy (rank 1 = first tracked entrant) and its
 * exit (the sell that took the position to ≤1% of peak), when that happened. Public: events older than PUBLIC_DELAY_SEC.
 */
export interface ReplayDTO {
  mint: string;
  symbol: string | null;
  icon: string | null;
  entries: { brainId: string; at: number; side: "buy"; rank: number }[];
  exits: { brainId: string; at: number }[];
}
