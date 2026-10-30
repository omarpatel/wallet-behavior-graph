/**
 * Wallet directory contract. A directory is a list of public wallets with optional labels and leaderboard stats
 * (data/directory/, a synthetic sample by default). Stored per brain in brains.sources_json /
 * brains.external_stats_json.
 */

/** directory = a wallet list with labels + leaderboard stats; study = an early-entry study record for the wallet. */
export type DirectorySourceId = "directory" | "study";

export interface DirectorySource {
  source: DirectorySourceId;
  name: string | null;
  handle: string | null; // X handle without @
  url: string | null; // profile page on the source
  avatarUrl: string | null;
  rank: number | null;
  fetchedAt: number; // unix s of the snapshot
}

export interface SourceStats {
  pnl1dUsd: number | null;
  pnl7dUsd: number | null;
  pnl30dUsd: number | null;
  winRate7d: number | null;
  winRate30d: number | null;
  trades7d: number | null;
  trades30d: number | null;
  avgHoldSecs: number | null;
  asOf: number; // unix s
}

/** Early-entry study of pump.fun launches for one wallet (runners vs fails among its early first-buys). */
export interface StudyRecord {
  hitRate: number | null;
  earlyRunners: number | null; // ATH ≥ $250K
  earlyMidfails: number | null; // $60–200K
  earlyFails: number | null; // < $40K
  runnersAll: number | null;
  medianDelayMin: number | null;
  medianEntryMcapUsd: number | null;
  notes: string | null;
}

export interface ExternalStats {
  /** The directory's own published leaderboard stats for the wallet. */
  listing?: SourceStats;
  study?: StudyRecord;
  directory?: DirectoryScoreRecord;
}

/** Ranking score from merged directory stats (src/server/directory/merge.ts `directoryScore`). */
export interface DirectoryScoreRecord {
  value: number | null; // 0–100
  notes: string[]; // human-readable drivers, most important first
  tags: string[]; // e.g. kol, hft, low-frequency, inactive
  asOf: number; // unix s
}
