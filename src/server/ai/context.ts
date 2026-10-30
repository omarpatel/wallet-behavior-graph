import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { brains } from "@/db/schema";
import { fmtDuration, fmtPct, fmtSol, fmtUsd } from "@/lib/format";
import type { BrainProfile, Buckets, TokenResult } from "@/server/profile/types";

export type BrainRow = typeof brains.$inferSelect;

export async function loadBrain(brainId: string): Promise<BrainRow | null> {
  const [row] = await getDb().select().from(brains).where(eq(brains.id, brainId)).limit(1);
  return row ?? null;
}

export function parseProfile(brain: Pick<BrainRow, "profileJson">): BrainProfile | null {
  if (!brain.profileJson) return null;
  return JSON.parse(brain.profileJson) as BrainProfile;
}

const ratio = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "—" : `${x.toFixed(2)}×`);

function buckets(b: Buckets): string {
  const total = b.reduce((s, x) => s + x.count, 0);
  if (!total) return "no data";
  return b
    .filter((x) => x.count > 0)
    .map((x) => `${x.label}: ${x.count} (${fmtPct(x.count / total)})`)
    .join(", ");
}

function token(t: TokenResult): string {
  const name = t.symbol ? `$${t.symbol}` : `${t.mint.slice(0, 6)}…`;
  return `${name}: bought ${fmtUsd(t.buyUsd)}, realized ${fmtUsd(t.realizedUsd)}, ROI ${fmtPct(t.roi)}, held ${fmtDuration(t.holdSec)} to first sell, entry MC ${fmtUsd(t.entryMcUsd)}${t.open ? ", still open" : ""}`;
}

/**
 * Compact profile summary for per-alert explanations (archetype, medians, sizing, hold, exits).
 */
export function profileSummary(p: BrainProfile | null): string {
  if (!p) return "No profile computed yet for this wallet.";
  const lines = [
    `Sample (last ${p.windowDays} days): ${p.sample.trades} trades, ${p.sample.tokens} tokens${p.rated ? "" : " (too thin to rate)"}.`,
    `Archetype: ${p.archetype.label} (${p.archetype.reason}).`,
    p.flags.length ? `Flags: ${p.flags.map((f) => `${f.label} (${f.reason})`).join("; ")}.` : "",
    `Median buy: ${fmtUsd(p.sizing.medianBuyUsd)} (${fmtSol(p.sizing.medianBuySol)}), sizing style ${p.sizing.style ?? "—"}.`,
    `Median entry MC: ${fmtUsd(p.entryMc.medianUsd)}. Median entry delay after launch: ${fmtDuration(p.timing.medianEntryDelaySec)}.`,
    `Median hold to first sell: ${fmtDuration(p.hold.medianHoldSec)}; sold within 5m ${fmtPct(p.hold.soldWithin5mShare)}, within 1h ${fmtPct(p.hold.soldWithin1hShare)}, within 24h ${fmtPct(p.hold.soldWithin24hShare)} of positions.`,
    `Exits: full dump in one tx ${fmtPct(p.exits.fullDumpShare)}, laddered (≥3 sells) ${fmtPct(p.exits.ladderShare)}, initials out on first sell ${fmtPct(p.exits.initialsOutShare)}, stop-out at ≤ −30% ${fmtPct(p.exits.stopOutShare)}.`,
    `Win rate ${fmtPct(p.pnl.winRate)} over ${p.pnl.closedPositions} closed positions.`,
  ];
  return lines.filter(Boolean).join("\n");
}

/**
 * Human-readable facts sheet of the full profile. Every number the playbook may state is here,
 * already formatted, so the model can copy numbers verbatim (and we can verify it did).
 */
export function profileFactsSheet(p: BrainProfile): string {
  const s = [
    `## Sample`,
    `- Window: last ${p.windowDays} days; ${p.sample.trades} trades (${p.sample.buys} buys, ${p.sample.sells} sells) across ${p.sample.tokens} tokens on ${p.sample.activeDays} active days.`,
    `- Rated: ${p.rated ? "yes" : "no"}. Track-record score: ${p.trackScore == null ? "—" : p.trackScore.toFixed(0)} / 100, tier ${p.tier}.`,
    `## Archetype and flags`,
    `- Archetype: ${p.archetype.label} — ${p.archetype.reason}`,
    ...p.flags.map((f) => `- Flag: ${f.label} — ${f.reason}`),
    `## PnL (realized only)`,
    `- Realized: ${fmtUsd(p.pnl.realizedUsd)} (${fmtSol(p.pnl.realizedSol)}) on cost ${fmtUsd(p.pnl.costUsd)}; ROI ${fmtPct(p.pnl.roi)}; profit factor ${ratio(p.pnl.profitFactor)}.`,
    `- Win rate ${fmtPct(p.pnl.winRate)} over ${p.pnl.closedPositions} closed positions; ${p.pnl.openPositions} open positions.`,
    `- Token ROI distribution: ${buckets(p.pnl.buckets)}.`,
    `## Entry timing (seconds after token launch)`,
    `- Median entry delay ${fmtDuration(p.timing.medianEntryDelaySec)} (25th percentile ${fmtDuration(p.timing.p25EntryDelaySec)}, 75th ${fmtDuration(p.timing.p75EntryDelaySec)}).`,
    `- Distribution: ${buckets(p.timing.buckets)}.`,
    `- Pump.fun entries on the bonding curve: ${fmtPct(p.timing.preGraduationShare)}; entries in the first minute: ${fmtPct(p.timing.firstMinuteShare)}.`,
    `## Entry market cap`,
    `- Median entry MC ${fmtUsd(p.entryMc.medianUsd)}. Distribution: ${buckets(p.entryMc.buckets)}.`,
    `## Hold time (first buy → first sell, per token)`,
    `- Median ${fmtDuration(p.hold.medianHoldSec)}. Round trips ≤ 5s: ${fmtPct(p.hold.flashFlipShare)}. Sold within 5m: ${fmtPct(p.hold.soldWithin5mShare)}, within 1h: ${fmtPct(p.hold.soldWithin1hShare)}, within 24h: ${fmtPct(p.hold.soldWithin24hShare)}.`,
    `- Distribution: ${buckets(p.hold.buckets)}.`,
    `## Sizing`,
    `- Median buy ${fmtUsd(p.sizing.medianBuyUsd)} (${fmtSol(p.sizing.medianBuySol)}); average buy ${fmtUsd(p.sizing.avgBuyUsd)}; variation (σ/μ of per-token buy USD) ${p.sizing.cv == null ? "—" : p.sizing.cv.toFixed(2)}; style ${p.sizing.style ?? "—"}.`,
    `## Exits`,
    `- Average buys per token ${p.exits.avgBuysPerToken?.toFixed(1) ?? "—"}, sells per token ${p.exits.avgSellsPerToken?.toFixed(1) ?? "—"}.`,
    `- ≥90% sold in one tx: ${fmtPct(p.exits.fullDumpShare)}. Laddered exits (≥3 sells): ${fmtPct(p.exits.ladderShare)}. First sell recovered ≥100% of cost: ${fmtPct(p.exits.initialsOutShare)}. First sell at ≤ −30%: ${fmtPct(p.exits.stopOutShare)}.`,
    `## Coin mix`,
    `- Launchpads: ${buckets(p.coinMix.launchpads)}.`,
    `- Venues: ${buckets(p.coinMix.venues)}.`,
    `## Activity`,
    `- Trades per day ${p.activity.tradesPerDay?.toFixed(1) ?? "—"}; session window ${p.activity.sessionWindowUtc ?? "none (spread across the day)"}.`,
    `## Copyability`,
    `- Score ${p.copyability.score == null ? "—" : p.copyability.score.toFixed(0)} / 100 — ${p.copyability.reason}`,
    `## Top wins`,
    ...(p.topWins.length ? p.topWins.slice(0, 3).map((t) => `- ${token(t)}`) : ["- none"]),
    `## Top losses`,
    ...(p.topLosses.length ? p.topLosses.slice(0, 3).map((t) => `- ${token(t)}`) : ["- none"]),
  ];
  if (p.promoteThenSell) {
    const x = p.promoteThenSell;
    s.push(
      `## Posts vs trades (claimed, X linked)`,
      `- Bullish token posts: ${x.bullishMentions}; posts followed by selling ≥50% within 24h while pre-positioned: ${x.events} (${x.strongEvents} sold ≥80% within 1h or first sell ≤15 min); rate ${fmtPct(x.rate)}; lift vs comparable un-posted positions ${ratio(x.lift)}.`,
    );
  }
  return s.join("\n");
}

/** Profile JSON without bulky arrays, for the chat context. */
export function trimmedProfile(p: BrainProfile): Omit<BrainProfile, "recentTokens"> & { recentTokens: TokenResult[] } {
  const strip = (t: TokenResult) => ({ ...t, icon: null });
  return {
    ...p,
    topWins: p.topWins.map(strip),
    topLosses: p.topLosses.map(strip),
    recentTokens: p.recentTokens.slice(0, 10).map(strip),
  };
}
