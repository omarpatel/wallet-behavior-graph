/**
 * BrainProfile: deterministic, versioned trading-style profile of one wallet.
 * Produced by src/server/profile (computeProfile), stored as brains.profile_json,
 * consumed by the AI layer (explanations/playbook/chat), pricing tiers and the UI.
 *
 * Methodology: the /methodology page.
 * All money values: USD unless suffixed Sol. All durations: seconds.
 */

export const PROFILE_SCHEMA_VERSION = 1;

export type ArchetypeId =
  | "unrated"
  | "deployer"
  | "bot_flipper"
  | "sniper"
  | "early_ape"
  | "momentum_chaser"
  | "intraday"
  | "swing"
  | "diamond_hands";

export type FlagId =
  | "promote_then_sell" // claimed brains only
  | "lottery"
  | "disciplined"
  | "bag_holder"
  | "scaler_in"
  | "partial_tp"
  | "concentrated"
  | "whale"
  | "accumulating"
  | "distributing"
  | "rug_exposed"
  | "session_trader"
  | "hard_to_copy";

export interface Labelled<T extends string> {
  id: T;
  label: string;
  /** The triggering numbers, human readable, e.g. "62% of entries < $100k MC". */
  reason: string;
}

/** Ordered bucket counts, label → count, in display order. */
export type Buckets = { label: string; count: number }[];

export interface TokenResult {
  mint: string;
  symbol: string | null;
  icon: string | null;
  buyUsd: number;
  realizedUsd: number;
  roi: number | null; // realized / cost
  firstBuyAt: number;
  holdSec: number | null; // first buy → first sell
  entryMcUsd: number | null;
  open: boolean;
}

export interface BrainProfile {
  schemaVersion: number;
  computedAt: number; // unix s
  windowDays: number; // trailing window the stats cover (90)

  sample: {
    trades: number;
    buys: number;
    sells: number;
    tokens: number;
    firstTradeAt: number | null;
    lastTradeAt: number | null;
    activeDays: number;
  };
  /** false when < 20 trades or < 5 tokens: archetype "unrated", no tier. */
  rated: boolean;

  archetype: Labelled<ArchetypeId>;
  flags: Labelled<FlagId>[];

  pnl: {
    realizedUsd: number;
    realizedSol: number;
    costUsd: number;
    roi: number | null;
    winRate: number | null; // closed positions with realized > 0
    /** Beta-posterior win rate (prior strength 20 toward winRateBase); absent on profiles computed before it. */
    winRateShrunk?: number | null;
    /** Population base rate (pooled closed positions across tracked brains) used as the prior mean. */
    winRateBase?: number;
    closedPositions: number;
    openPositions: number;
    profitFactor: number | null;
    /** >5x, 2–5x, 0–2x, −50–0%, < −50% (token-level ROI). */
    buckets: Buckets;
  };

  timing: {
    medianEntryDelaySec: number | null;
    p25EntryDelaySec: number | null;
    p75EntryDelaySec: number | null;
    /** same block, ≤10s, <1m, 1–5m, 5–60m, 1–24h, >24h. */
    buckets: Buckets;
    preGraduationShare: number | null; // share of pump.fun entries on the bonding curve
    firstMinuteShare: number | null;
  };

  entryMc: {
    medianUsd: number | null;
    /** <$10k, $10–30k, $30–100k, $100k–1M, $1–10M, $10–100M, ≥$100M. */
    buckets: Buckets;
  };

  hold: {
    /** Median per-token first-buy → first-sell ("copy window"). */
    medianHoldSec: number | null;
    flashFlipShare: number | null; // round trip ≤ 5s
    soldWithin5mShare: number | null;
    soldWithin1hShare: number | null;
    soldWithin24hShare: number | null;
    /** <1m, 1–5m, 5–60m, 1–24h, 1–7d, >7d, still open. */
    buckets: Buckets;
  };

  sizing: {
    medianBuySol: number | null;
    medianBuyUsd: number | null;
    avgBuyUsd: number | null;
    cv: number | null; // σ/μ of per-token total buy USD
    style: "fixed" | "variable" | "conviction" | null;
  };

  exits: {
    avgBuysPerToken: number | null;
    avgSellsPerToken: number | null;
    fullDumpShare: number | null; // ≥90% sold in one tx
    ladderShare: number | null; // ≥3 sells
    initialsOutShare: number | null; // first sell recovers ≥100% of cost
    stopOutShare: number | null; // first sell at ≤ −30%
  };

  coinMix: {
    launchpads: Buckets; // pump.fun, bonk, other, unknown
    venues: Buckets; // pump_curve, pumpswap, raydium, meteora, jupiter, …
  };

  activity: {
    tradesPerDay: number | null;
    hourHistogramUtc: number[]; // 24 counts
    sessionWindowUtc: string | null; // e.g. "14:00–20:00 UTC" when ≥70% in one 6h window
  };

  copyability: {
    score: number | null; // 0–100
    reason: string;
  };

  /** Track-record score 0–100 (never uses unrealized PnL). */
  trackScore: number | null;
  tier: "S" | "A" | "B" | "C" | "unrated";

  topWins: TokenResult[]; // up to 5
  topLosses: TokenResult[]; // up to 5
  recentTokens: TokenResult[]; // up to 20 most recent

  /** Claimed brains with X linked only. */
  promoteThenSell: {
    bullishMentions: number;
    events: number;
    strongEvents: number;
    rate: number | null;
    lift: number | null;
  } | null;
}
