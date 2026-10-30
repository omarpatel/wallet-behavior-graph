/**
 * Brain agents — autonomous traders that trade IN THE STYLE of a brain. They do not mirror the brain's wallet.
 * Strategy = deterministic translation of the brain's BrainProfile (src/server/profile/types.ts) into entry filters,
 * sizing and an exit plan, optionally gated by an LLM judge that reads the brain's playbook.
 * Tables: agents, agent_decisions, agent_orders, agent_positions, agent_ledger (src/db/schema.ts).
 */

import type { Provenance } from "@/db/schema";

export const AGENT_SCHEMA_VERSION = 1;

/** What the agent hunts for, derived from the profile (each field records the profile stat it came from). */
export interface EntryRules {
  launchpads: string[]; // e.g. ["pump.fun"]; empty = any
  phase: "curve" | "graduated" | "any"; // from timing.preGraduationShare
  entryMcUsd: { min: number; max: number }; // from entryMc p25..p75 (or bucket mass)
  entryDelaySec: { min: number; max: number }; // since token launch, from timing p25..p75
  /** Momentum gate for momentum styles: price change over the lookback must exceed this (0 = off). */
  momentum: { lookbackSec: number; minChangePct: number };
  minLiquidityUsd: number;
  maxRugScore: number; // RugCheck normalised 0–100
  requireMintRevoked: boolean;
  requireFreezeRevoked: boolean;
  maxTopHoldersPct: number | null;
  /** Wallet Behavior Graph signal confirmation: require an active swarm of ≥ N tracked brains on the token (0 = off). */
  minSwarmMembers: number;
  /**
   * Demand gate (sniper README): the move must be confirmed by flow, and unknown never counts as zero.
   * Curve tokens: net SOL into the bonding curve over `windowSec` ≥ minNetInflowSol (on-chain reserve samples).
   * Graduated tokens: buys/sells over 5 min ≥ minBuySellRatio (DexScreener / Jupiter counts). null = off.
   */
  demand: { windowSec: number; minNetInflowSol: number; minBuySellRatio: number } | null;
}

export interface SizingRules {
  /** Fraction of the agent's free SOL per entry (from sizing.style: fixed → constant, conviction → scaled). */
  baseFraction: number;
  maxFraction: number;
  style: "fixed" | "variable" | "conviction";
  maxPositionLamports: number; // hard cap per position
  maxOpenPositions: number;
  minTradeLamports: number;
}

/** How positions are exited, mirroring the brain's exit pattern. Checked every tick against live price. */
export interface ExitPlan {
  /** Sell everything after this long (median hold × factor). */
  timeStopSec: number;
  stopLossPct: number; // e.g. -30 → sell all at −30%
  /** Take-profit ladder: at +pct sell `fraction` of the remaining position. Empty = single exit by other rules. */
  ladder: { pct: number; fraction: number }[];
  /** "Initials out": at +pct sell enough to recover cost basis. null = off. */
  initialsOutPct: number | null;
  trailingStopPct: number | null; // from peak, after first TP
}

export interface StrategySpec {
  schemaVersion: number;
  brainId: string;
  archetype: string;
  /** Plain-language summary shown in the UI, generated deterministically from the rules below. */
  summary: string;
  entry: EntryRules;
  sizing: SizingRules;
  exit: ExitPlan;
  /** Risk controls (owner-editable within bounds). */
  risk: {
    dailyLossLimitLamports: number; // halt the agent when realised + unrealised loss today exceeds this
    maxTradesPerHour: number;
    slippageBps: number;
    priorityFeeLamports: number;
  };
  /** Which profile stats produced which rule, for transparency ("entry MC $8k–$30k ← your p25–p75"). */
  provenance: Record<string, string>;
}

/** Snapshot of a candidate token when the agent evaluates it (stored in agent_decisions.features_json). */
export interface CandidateFeatures {
  mint: string;
  symbol: string | null;
  name: string | null;
  launchpad: string | null;
  phase: "curve" | "graduated" | "unknown";
  ageSec: number | null;
  mcUsd: number | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  change5mPct: number | null;
  change1hPct: number | null;
  buys5m: number | null;
  sells5m: number | null;
  rugScore: number | null;
  mintRevoked: boolean | null;
  freezeRevoked: boolean | null;
  topHoldersPct: number | null;
  swarmMembers: number; // tracked brains currently in a swarm on this token (only swarms the owner may see live)
  source: string; // which feed surfaced it (pumpportal:new, pumpportal:migration, swarm, dexscreener…)
  /** Net SOL into the bonding curve over the demand window (curve tokens; null = unknown). */
  netInflowSol: number | null;
  curveProgressPct: number | null; // 0–100 toward graduation (curve tokens)
  priceAgeSec: number | null; // age of priceUsd when evaluated
}

export interface AgentDTO {
  id: string;
  owner: string;
  brainId: string;
  name: string;
  walletPubkey: string;
  mode: "paper" | "live";
  status: "running" | "paused" | "halted" | "stopped";
  haltedReason: string | null;
  strategy: StrategySpec;
  useLlm: boolean;
  balanceLamports: number; // live: on-chain SOL; paper: simulated cash
  equityLamports: number; // balance + marked open positions
  pnlLamports: number; // equity − net deposits (live) or − paper start (paper)
  pnlPct: number | null; // pnlLamports / starting capital × 100
  /** Live: net deposits (deposits − withdrawals). Paper: paperStartLamports. */
  capitalLamports: number;
  /** Real SOL in the agent wallet (both modes; paper agents can be pre-funded before switching to live). */
  walletLamports: number | null;
  openPositions: number;
  trades: number;
  markedAt: number | null; // when equity was last marked by the runner
  createdAt: number;
  brain: AgentBrainFace;
}

/** Brain identity needed to render name + avatar (same fields as src/server/queries/shared.ts BrainFace). */
export interface AgentBrainFace {
  brainId: string;
  codename: string;
  displayName: string | null;
  xHandle: string | null;
  provenance: Provenance;
  status: "unclaimed" | "claimed";
  avatarUrl: string | null;
  publicAvatarUrl: string | null;
}

export interface AgentPositionDTO {
  mint: string;
  symbol: string | null;
  status: "open" | "closed";
  qtyRaw: string;
  decimals: number;
  costLamports: number; // remaining cost basis
  realizedLamports: number; // SOL realised by sells so far (gross proceeds − cost of the sold part)
  entryPriceUsd: number | null;
  entryMcUsd: number | null;
  lastPriceUsd: number | null;
  lastPriceAt: number | null; // unix s of lastPriceUsd
  peakPriceUsd: number | null;
  valueLamports: number | null; // marked value of qtyRaw at lastPriceUsd (null when no fresh price)
  unrealizedLamports: number | null; // valueLamports − costLamports
  pnlPct: number | null; // (lastPrice / entryPrice − 1) × 100
  tpStepsHit: number; // ladder steps already sold
  initialsOutDone: boolean;
  openedAt: number;
  timeStopAt: number; // openedAt + exit.timeStopSec
  closedAt: number | null;
  exitPlan: ExitPlan;
}

export interface AgentOrderDTO {
  id: number;
  side: "buy" | "sell";
  mint: string;
  symbol: string | null;
  status: "queued" | "sent" | "filled" | "failed";
  paper: boolean;
  signature: string | null; // live only
  /** SOL leg: lamports spent (buy) or received (sell); null until filled. */
  lamports: number | null;
  tokenRaw: string | null; // token leg in raw units
  feeLamports: number | null; // network + priority (+ modelled) fees
  priceUsd: number | null;
  mcUsd: number | null;
  reason: string; // "entry" | "take-profit +100%" | "stop-loss −35%" | "time stop" | "close-all" | …
  error: string | null;
  createdAt: number;
  filledAt: number | null;
}

export interface AgentDecisionDTO {
  id: number;
  mint: string;
  symbol: string | null;
  action: "buy" | "sell" | "skip";
  reason: string;
  features: CandidateFeatures;
  llmModel: string | null;
  llmText: string | null;
  createdAt: number;
}

/** agent_decisions.context_json of platform agents (legacy); null for user agents. */
export interface DecisionContext {
  /** Brain whose style the agent traded under when it decided. */
  styleBrainId: string;
  /** Cross-brain context chips from the council ("swarm ×4", "2 connectome leaders in"). */
  chips: string[];
  /** Uses seat-gated live data: held back from the public tape for PUBLIC_DELAY_SEC. */
  gated: boolean;
}

export interface AgentLedgerDTO {
  id: number;
  kind: "deposit" | "withdraw" | "paper_reset" | "fee_claim";
  amountLamports: number;
  signature: string | null;
  flagged: string | null; // e.g. "over AGENT_MAX_DEPOSIT_SOL"
  createdAt: number;
}

/** GET /api/agents/[id]. Public read-only for non-owners (ledger omitted). */
export interface AgentDetailDTO extends AgentDTO {
  brain: AgentBrainFace;
  isOwner: boolean;
  positions: AgentPositionDTO[]; // open first, then the 20 most recent closed
  orders: AgentOrderDTO[]; // newest 50
  decisions: AgentDecisionDTO[]; // newest 50
  equityHistory: { t: number; equityLamports: number }[]; // 5-min samples, last 7 days
  ledger: AgentLedgerDTO[] | null; // owner only
  liveEnabled: boolean; // AGENTS_LIVE_ENABLED (platform switch)
  agentsEnabled: boolean; // AGENTS_ENABLED (global kill switch)
}

export interface AgentLeaderboardRow {
  id: string;
  name: string;
  brainId: string;
  brain: AgentBrainFace;
  archetype: string;
  mode: "paper" | "live";
  status: AgentDTO["status"];
  pnlLamports: number;
  pnlPct: number | null; // pnl / starting capital (paper start, or net deposits for live)
  trades: number; // filled orders
  winRate: number | null; // closed positions with realised > 0
  openPositions: number;
  createdAt: number;
  ageSec: number;
}

/** GET /api/agents/leaderboard[?brainId=] — paper and live are never ranked together. */
export interface AgentLeaderboardDTO {
  paper: AgentLeaderboardRow[];
  live: AgentLeaderboardRow[];
}

/** GET /api/agents/[id]/deposit (owner) — everything the browser needs to build a mainnet SystemProgram transfer. */
export interface AgentDepositInfoDTO {
  to: string;
  blockhash: string;
  lastValidBlockHeight: number;
  maxLamports: number; // AGENT_MAX_DEPOSIT_SOL in lamports
  remainingLamports: number; // max − net deposits so far
}

/** Hard platform limits (env-overridable in src/lib/env.ts). */
export const AGENT_LIMITS = {
  maxDepositLamports: 5_000_000_000, // AGENT_MAX_DEPOSIT_SOL
  maxAgentsPerOwner: 5,
} as const;

/**
 * Owner-editable strategy fields (PATCH /api/agents/[id] `strategyOverrides`) and their bounds. Path = key into
 * StrategySpec. Values outside [min, max] are rejected with 400. Lamport values are integers.
 */
export const AGENT_OVERRIDE_BOUNDS = {
  "sizing.baseFraction": { min: 0.01, max: 0.5, step: 0.01 },
  "sizing.maxFraction": { min: 0.01, max: 0.5, step: 0.01 },
  "sizing.maxPositionLamports": { min: 10_000_000, max: 5_000_000_000, step: 10_000_000 },
  "sizing.maxOpenPositions": { min: 1, max: 10, step: 1 },
  "exit.stopLossPct": { min: -90, max: -5, step: 1 },
  "exit.timeStopSec": { min: 60, max: 7 * 86_400, step: 60 },
  "risk.dailyLossLimitLamports": { min: 10_000_000, max: 5_000_000_000, step: 10_000_000 },
  "risk.maxTradesPerHour": { min: 1, max: 60, step: 1 },
  "risk.slippageBps": { min: 50, max: 3_000, step: 50 },
} as const;

export type AgentOverridePath = keyof typeof AGENT_OVERRIDE_BOUNDS;

/** PATCH body shape: nested partials of the bounded fields above. */
export interface StrategyOverrides {
  sizing?: Partial<Pick<SizingRules, "baseFraction" | "maxFraction" | "maxPositionLamports" | "maxOpenPositions">>;
  exit?: Partial<Pick<ExitPlan, "stopLossPct" | "timeStopSec">>;
  risk?: Partial<Pick<StrategySpec["risk"], "dailyLossLimitLamports" | "maxTradesPerHour" | "slippageBps">>;
}
