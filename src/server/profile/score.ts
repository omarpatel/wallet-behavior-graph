/**
 * Track-record score, tier, copyability and tier pricing.
 */
import type { ArchetypeId, BrainProfile } from "./types";

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp01 = (x: number, lo: number, hi: number) => clamp01((x - lo) / (hi - lo));
/** Log-scale position of x between lo and hi (both > 0), clamped to 0–1. */
const logLerp01 = (x: number, lo: number, hi: number) => (x <= 0 ? 0 : clamp01(Math.log(x / lo) / Math.log(hi / lo)));

/**
 * Shrinkage prior strength in pseudo-positions (sniper smart.rs PRIOR_STRENGTH): a wallet needs about this many
 * closed positions before its own record outweighs the assumption that it is average.
 */
export const WIN_RATE_PRIOR_STRENGTH = 20;
/** Prior mean when the population base rate isn't known yet (too few closed positions across brains). */
export const DEFAULT_WIN_RATE_BASE = 0.5;
/** Pooled closed positions needed before the population win rate is trusted as the prior mean. */
export const MIN_POPULATION_CLOSED = 200;

/**
 * Beta-posterior mean of the win rate with a Beta(base·k, (1−base)·k) prior: (wins + base·k) / (n + k).
 * Three lucky wins stay near the base rate; 200 closed positions at 60% stay near 60%.
 */
export function shrinkWinRate(wins: number, n: number, base: number, strength = WIN_RATE_PRIOR_STRENGTH): number {
  return (wins + base * strength) / (n + strength);
}

export interface TrackScoreInput {
  /** closed positions with ROI < −50% / closed positions */
  deepLossShare: number | null;
  /** Σ winning realized / (Σ wins + |Σ losses|) */
  profitShare: number | null;
  roi: number | null;
  /** shrinkWinRate(...) of closed positions */
  winRateShrunk: number | null;
  /** population base rate the shrinkage pulled toward */
  winRateBase: number;
  tokens: number;
  deployer: boolean;
}

/**
 * Track record (0–100): stop-loss discipline 34% + profit share 28% + ROI 16% (−5%→0, +30%→100)
 * + win rate 10% + sample size 12% (20→320 tokens); ×0.45 for deployer wallets.
 * Win rate is the Bayesian-shrunk rate scored as lift over the population: base − 20 pts → 0, base → 50%,
 * base + 20 pts → 100%. A raw rate let 3/3 wins outrank 120/200.
 */
export function trackScore(i: TrackScoreInput): number | null {
  if (i.deepLossShare == null || i.profitShare == null || i.roi == null || i.winRateShrunk == null) return null;
  const s =
    34 * (1 - i.deepLossShare) +
    28 * clamp01(i.profitShare) +
    16 * lerp01(i.roi, -0.05, 0.3) +
    10 * lerp01(i.winRateShrunk, i.winRateBase - 0.2, i.winRateBase + 0.2) +
    12 * lerp01(i.tokens, 20, 320);
  return Math.round((i.deployer ? s * 0.45 : s) * 10) / 10;
}

export function tierFor(score: number | null, rated: boolean): BrainProfile["tier"] {
  if (!rated || score == null) return "unrated";
  if (score >= 80) return "S";
  if (score >= 65) return "A";
  if (score >= 50) return "B";
  return "C";
}

/** Pricing table (lamports). C and unrated share the entry tier. */
export const TIER_PRICING: Record<BrainProfile["tier"], { supply: number; priceLamports: number; renewalLamports: number }> = {
  S: { supply: 50, priceLamports: 2_000_000_000, renewalLamports: 600_000_000 },
  A: { supply: 100, priceLamports: 1_000_000_000, renewalLamports: 300_000_000 },
  B: { supply: 150, priceLamports: 500_000_000, renewalLamports: 150_000_000 },
  C: { supply: 200, priceLamports: 250_000_000, renewalLamports: 80_000_000 },
  unrated: { supply: 200, priceLamports: 250_000_000, renewalLamports: 80_000_000 },
};

/** How exploitable the edge is for a follower who sees the trade seconds later. */
const EDGE_BY_ARCHETYPE: Record<ArchetypeId, number> = {
  unrated: 0.5,
  deployer: 0,
  bot_flipper: 0,
  sniper: 0.1,
  early_ape: 0.35,
  momentum_chaser: 0.6,
  intraday: 0.7,
  swing: 0.9,
  diamond_hands: 1,
};

export interface CopyabilityInput {
  medianEntryMcUsd: number | null;
  /** mean realized USD per closed position */
  profitPerPositionUsd: number | null;
  medianHoldSec: number | null;
  tradesPerWeek: number | null;
  archetype: ArchetypeId;
  /** shrinkWinRate(...) of closed positions, and the base it was pulled toward */
  winRateShrunk: number | null;
  winRateBase: number;
}

/**
 * Copy-tradeability 0–100 = additive quality × fidelity gate.
 * - quality (additive weights, plus a shrunk win rate): entry MC 20% (log $10K → $1M), profit per
 *   position 20% (log $30 → $500), hold vs latency 18% (log 5 s → 10 min), execution pace 14% (100 → 1000
 *   trades/week), edge type 16%, shrunk win-rate lift 12% (base − 20 pts → 0, base + 20 pts → 1).
 * - gate (same as the directory's `directoryScore`): 0.25 + 0.75·f, f = the worse of the hold and pace fidelities; 0.7
 *   when both are unknown. Additive weights alone let a profitable sub-minute flipper score like a slow selector;
 *   with the gate a wallet a follower physically can't mirror can't score well whatever it earns. A wallet with
 *   ≥ 10 min holds at a manual pace keeps its full additive score.
 * A recency term is left out: profiles are only recomputed when the wallet trades, so it would go stale.
 */
export function copyability(i: CopyabilityInput): BrainProfile["copyability"] {
  if (i.medianEntryMcUsd == null && i.medianHoldSec == null) {
    return { score: null, reason: "Not enough closed positions to judge copyability." };
  }
  const hold = i.medianHoldSec == null ? null : logLerp01(i.medianHoldSec, 5, 600);
  const pace = i.tradesPerWeek == null ? null : 1 - lerp01(i.tradesPerWeek, 100, 1000);
  const known = [hold, pace].filter((x): x is number => x != null);
  const gate = known.length ? 0.25 + 0.75 * Math.min(...known) : 0.7;
  const parts = [
    { w: 20, v: i.medianEntryMcUsd == null ? 0.5 : logLerp01(i.medianEntryMcUsd, 10_000, 1_000_000), why: "very low entry market caps leave no room after a follower's slippage" },
    { w: 20, v: i.profitPerPositionUsd == null ? 0.5 : logLerp01(Math.max(i.profitPerPositionUsd, 0.01), 30, 500), why: "thin profit per position is eaten by slippage and fees" },
    { w: 18, v: hold ?? 0.5, why: "positions are often closed before a follower could react" },
    { w: 14, v: pace ?? 0.5, why: "trade frequency is beyond manual execution" },
    { w: 16, v: EDGE_BY_ARCHETYPE[i.archetype], why: "the edge comes from speed/launch access rather than selection" },
    {
      w: 12,
      v: i.winRateShrunk == null ? 0.5 : lerp01(i.winRateShrunk, i.winRateBase - 0.2, i.winRateBase + 0.2),
      why: "it wins less often than the average tracked wallet once luck is discounted",
    },
  ];
  const score = Math.round(parts.reduce((s, p) => s + p.w * p.v, 0) * gate);
  const weakest = [...parts].sort((a, b) => a.v * a.w - b.v * b.w).filter((p) => p.v < 0.5).slice(0, 2);
  const reason =
    score >= 65
      ? "Entries, hold times and frequency leave a follower room to act."
      : weakest.length
        ? `Hard to mirror: ${weakest.map((p) => p.why).join("; ")}. Learn the discipline, don't copy the entries.`
        : "Mixed: some of this style can be followed, timing-sensitive entries cannot.";
  return { score, reason };
}
