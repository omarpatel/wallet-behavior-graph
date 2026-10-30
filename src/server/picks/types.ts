/**
 * Brain Picks: tokens that match a brain's trading style right now, published to the brain's seat holders in real time
 * (everyone else: PUBLIC_DELAY_SEC later). A pick is the same deterministic market + safety rule pass the brain's agents
 * use (src/server/agents/features.ts), plus the cross-brain council and an optional LLM one-liner. Picks never place
 * orders: each one is tracked against live prices and closed by the style's exit plan on paper — that paper outcome is
 * the brain's public pick track record. Table: brain_picks (src/db/schema.ts). Not financial advice.
 */
import type { AgentBrainFace, CandidateFeatures, ExitPlan } from "@/server/agents/types";

/** Why a pick's paper position closed (the exit-plan rule that fired; "dead" = no price for DEAD_AFTER_SEC). */
export type PickCloseReason = "tp" | "sl" | "trail" | "time" | "dead";

export interface PickDTO {
  id: number;
  brainId: string;
  createdAt: number;
  /** When the public sees the token (createdAt + PUBLIC_DELAY_SEC). */
  revealAt: number;
  /** Public viewer before revealAt: token, prices, reason and outcome are withheld (null / empty). */
  hidden: boolean;
  token: { mint: string; symbol: string | null; name: string | null; launchpad: string | null; phase: CandidateFeatures["phase"] } | null;
  entryMcUsd: number | null;
  entryPriceUsd: number | null;
  /** The style's position size for this pick, as a fraction of a bankroll (0–1; base…max by conviction). */
  suggestedFraction: number;
  /** The style's exit plan the paper outcome follows. */
  exitPlan: ExitPlan;
  /** Deterministic rule summary: why it matches this wallet's style. */
  reason: string | null;
  /** Cross-brain context ("swarm ×4", "2 connectome leaders in"). */
  chips: string[];
  /** Optional LLM one-liner (≤30 words). */
  llm: { model: string; text: string } | null;
  features: CandidateFeatures | null;
  status: "open" | "closed";
  closedAt: number | null;
  closeReason: PickCloseReason | null;
  /** Price change since the pick, %, at lastPriceAt. */
  lastGainPct: number | null;
  /** Best price change since the pick, %. */
  maxGainPct: number | null;
  /** Paper result of following the exit plan, % of the stake (closed picks; open: realized + marked remainder). */
  outcomePct: number | null;
  lastPriceAt: number | null;
  /** Share of the paper position already taken off by take-profits / initials-out, 0–100. */
  soldPct: number;
}

export interface PickStatsDTO {
  picks: number;
  open: number;
  closed: number;
  wins: number; // closed with outcome > 0
  winRate: number | null; // wins / closed, 0–1
  medianOutcomePct: number | null;
  avgOutcomePct: number | null;
  bestOutcomePct: number | null;
  worstOutcomePct: number | null;
  lastPickAt: number | null;
}

/** GET /api/brains/[id]/picks */
export interface BrainPicksDTO {
  brainId: string;
  /** Viewer has access (seat / KOL / admin): every pick in real time. Otherwise picks younger than delaySec are hidden. */
  realtime: boolean;
  delaySec: number;
  /** Picks are generated for brains with ≥1 active seat, or ≥1 agent. */
  generating: boolean;
  /** The style the picks follow (null when the profile is too thin to derive one). */
  style: { archetype: string; summary: string; exit: ExitPlan; sizing: { baseFraction: number; maxFraction: number; style: string } } | null;
  untradableReason: string | null;
  /** Track record (public: picks older than delaySec only). */
  stats: PickStatsDTO;
  picks: PickDTO[];
  /** Pass as ?cursor= for older picks. */
  nextCursor: string | null;
}

export interface PickLeaderboardRow {
  rank: number | null; // null = fewer than minClosed closed picks (still warming up)
  brain: AgentBrainFace;
  archetype: string | null;
  stats: PickStatsDTO;
}

/** GET /api/picks/leaderboard[?window=7d|30d|all] — public; only picks older than PUBLIC_DELAY_SEC count. */
export interface PickLeaderboardDTO {
  window: "7d" | "30d" | "all";
  minClosed: number;
  delaySec: number;
  /** Ranked by average paper outcome per closed pick, then win rate. */
  rows: PickLeaderboardRow[];
  /** All brains together over the same picks. */
  total: PickStatsDTO;
  computedAt: number;
}
