/**
 * Swarm signal DTOs (src/server/signals). A swarm is several tracked brains first-buying the same token within
 * SWARM_WINDOW_SEC. Detection: ./swarms.ts; queries + visibility: ./queries.ts; API: /api/swarms(/stream).
 */
import type { BrainTier, Provenance } from "@/db/schema";

/** All first buys must fall within this many seconds of the swarm's first member. */
export const SWARM_WINDOW_SEC = 600;
/** Members needed before a swarm row exists ("forming"). */
export const SWARM_MIN = 3;
/** Stage thresholds: ≥5 → "swarm", ≥10 → "large". */
export const SWARM_FULL = 5;
export const SWARM_LARGE = 10;
/** A swarm counts as active while its last member joined within this many seconds. */
export const SWARM_ACTIVE_SEC = 1800;
/** Outcome window: peak market cap seen within this long after the swarm started. */
export const SWARM_OUTCOME_WINDOW_SEC = 86_400;

export type SwarmStage = "forming" | "swarm" | "large";

export const swarmStage = (members: number): SwarmStage =>
  members >= SWARM_LARGE ? "large" : members >= SWARM_FULL ? "swarm" : "forming";

/** External base rate (not measured by Wallet Behavior Graph). */
export interface SwarmStudyRate {
  minMembers: number;
  windowSec: number;
  /** Share of such clusters whose token became a runner. */
  runnerShare: number;
  runnerDefinition: string;
  source: string;
}

export const SWARM_STUDY_SOURCE = "External pump.fun cluster study, Aug–Oct 2026";

/** External reference: wallet clusters after mint (≥5 wallets in 10 min → ~15% runners; ≥10 → ~50%). */
export const SWARM_STUDY_RATES: SwarmStudyRate[] = [
  {
    minMembers: 5,
    windowSec: 600,
    runnerShare: 0.15,
    runnerDefinition: "reached ≥$100K market cap (farm launches excluded)",
    source: SWARM_STUDY_SOURCE,
  },
  {
    minMembers: 10,
    windowSec: 600,
    runnerShare: 0.5,
    runnerDefinition: "reached ≥$100K market cap (farm launches excluded)",
    source: SWARM_STUDY_SOURCE,
  },
];

/** Stored in swarms.members_json, in entry order. */
export interface SwarmMemberRecord {
  brainId: string;
  at: number; // first buy blockTime (unix s)
  slot: number;
  signature: string;
  solValue: number | null;
  mcUsd: number | null;
}

export interface SwarmMemberDTO {
  brainId: string;
  codename: string;
  /** Public/attributed name; render with the provenance label like every other brain surface. */
  displayName: string | null;
  xHandle: string | null;
  /** Claimed avatar, else the directory's public pfp. */
  avatarUrl: string | null;
  provenance: Provenance;
  tier: BrainTier;
  at: number;
  lagSec: number; // since swarm start
  slot: number;
  /** Landed in the same slot as another member (near-simultaneous; possibly one operator or a bundle). */
  bundled: boolean;
  solValue: number | null;
  mcUsd: number | null; // null while the token is hidden
}

export interface SwarmTokenDTO {
  mint: string;
  symbol: string | null;
  name: string | null;
  icon: string | null;
  launchpad: string | null;
  mcapUsd: number | null; // latest known
  rugScore: number | null; // RugCheck normalised 0–100, higher = riskier
  lpLockedPct: number | null;
}

/**
 * Our own measured outcome. Peak = highest market cap in any tracked brain's trade of this token within 24 h after
 * the swarm started — a lower bound of the true peak (we only see prices when tracked wallets trade).
 * "FromPublish" figures start at the SWARM_MIN-th entry (when the swarm became detectable) and only count trades
 * strictly after it: what a follower alerted at detection could still have caught.
 */
export interface SwarmOutcomeDTO {
  mcAtStartUsd: number | null;
  peakMcUsd: number | null;
  peakAt: number | null;
  multiple: number | null; // peak / start
  mcAtPublishUsd: number | null;
  peakAfterPublishMcUsd: number | null;
  multipleFromPublish: number | null;
  windowComplete: boolean; // 24 h have passed since the start
  observedTrades: number;
  basis: "tracked_trades";
}

export interface SwarmDTO {
  id: number;
  stage: SwarmStage;
  members: number;
  /** Distinct slots among members: same-slot entries count once here. */
  independentMembers: number;
  startedAt: number;
  lastJoinAt: number;
  /** When the SWARM_MIN-th member joined. */
  publishAt: number;
  active: boolean;
  /** Token identity withheld from this viewer until revealAt. */
  hidden: boolean;
  revealAt: number;
  token: SwarmTokenDTO | null;
  memberList: SwarmMemberDTO[];
  outcome: SwarmOutcomeDTO | null;
}

/** Our measured rates over swarms whose 24 h window is complete and whose start market cap is known. */
export interface SwarmMeasuredRate {
  minMembers: number;
  swarms: number;
  reached2x: number;
  share2x: number | null;
  /** Denominator of share2xFromPublish: swarms with a known market cap at detection. */
  withPublishMc: number;
  reached2xFromPublish: number;
  share2xFromPublish: number | null;
  /** Denominator of share100k: swarms that started below $100K market cap. */
  startedBelow100k: number;
  reached100k: number;
  share100k: number | null;
}

export interface SwarmListDTO {
  generatedAt: number;
  windowSec: number;
  study: SwarmStudyRate[];
  measured: SwarmMeasuredRate[];
  swarms: SwarmDTO[];
}
