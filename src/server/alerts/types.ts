/**
 * Deterministic facts attached to every live-trade alert (alerts.facts_json).
 * The LLM only explains these; it never originates claims.
 * Fields marked optional were added later; alerts stored before them lack the key.
 */
import type { SwarmStage } from "@/server/signals/types";

/** One named risk from RugCheck's report summary (their wording and levels). */
export interface RugRisk {
  name: string;
  level: string; // "danger" | "warn" | "info"
  description: string | null;
  value: string | null;
}

export interface AlertFacts {
  side: "buy" | "sell";
  signature: string;
  blockTime: number;
  mint: string;
  symbol: string | null;
  name: string | null;
  icon: string | null;
  launchpad: string | null;
  venue: string | null;

  tokenAmount: number;
  solValue: number | null;
  usdValue: number | null;
  mcUsd: number | null;
  entryDelaySec: number | null; // buys: seconds since token creation

  /** Position context for this mint in this wallet, after the trade. */
  position: {
    isFirstBuy: boolean;
    buysSoFar: number;
    sellsSoFar: number;
    heldSec: number | null; // since first buy
    soldFraction: number | null; // sells only: share of peak position sold so far
    realizedUsd: number | null; // sells only
    roiOnSell: number | null; // sells only: this sell's proceeds vs avg cost
  };

  /** How this trade compares with the wallet's own profile. */
  inCharacter: {
    sizeVsMedian: number | null; // usdValue / profile.sizing.medianBuyUsd
    mcVsMedian: number | null; // mcUsd / profile.entryMc.medianUsd
    delayVsMedian: number | null;
    notes: string[]; // e.g. "4.1× usual size", "entered much later than usual"
  };

  /** Safety context (Jupiter token data + RugCheck summary at alert time). */
  safety: {
    liquidityUsd: number | null;
    topHoldersPct: number | null;
    mintAuthorityDisabled: boolean | null;
    freezeAuthorityDisabled: boolean | null;
    organicScore: number | null;
    /** RugCheck normalised risk 0–100 (higher = riskier). */
    rugScore?: number | null;
    lpLockedPct?: number | null;
    /** RugCheck danger/warn risks, minus those contradicted by Jupiter's structured audit flags. */
    rugRisks?: RugRisk[];
    warnings: string[]; // e.g. "liquidity under $50k"
  };

  /** Set when this buy is the brain's first entry into a token that tracked brains are swarming. */
  swarm?: {
    id: number;
    stage: SwarmStage;
    members: number; // at alert time
    rank: number; // this brain's entry order (1 = first)
    lagSec: number; // since the swarm's first entry
  };

  links: {
    solscanTx: string;
    dexscreener: string;
    pumpfun: string | null;
  };
}

/** What SSE subscribers and the brain page receive. */
export interface AlertDTO {
  id: number;
  brainId: string;
  headline: string;
  facts: AlertFacts;
  explanation: string | null;
  publishAt: number;
}
