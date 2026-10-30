/**
 * Primary archetype (first match, top to bottom) + overlay flags, with the triggering numbers in each reason.
 */
import { fmtDuration, fmtPct, fmtUsd } from "@/lib/format";
import type { ArchetypeId, FlagId, Labelled } from "./types";

export const ARCHETYPE_LABELS: Record<ArchetypeId, string> = {
  unrated: "Unrated — thin sample",
  deployer: "Deployer / Dev-linked",
  bot_flipper: "Bot / Flash Flipper",
  sniper: "Sniper",
  early_ape: "Early Ape (curve ape)",
  momentum_chaser: "Momentum Chaser",
  intraday: "Intraday Trader",
  swing: "Swing Holder",
  diamond_hands: "Diamond Hands",
};

export const FLAG_LABELS: Record<FlagId, string> = {
  promote_then_sell: "Promote-then-sell pattern",
  lottery: "Lottery",
  disciplined: "Disciplined",
  bag_holder: "Bag holder",
  scaler_in: "Scaler-in",
  partial_tp: "Partial take-profit",
  concentrated: "Concentrated",
  whale: "Whale",
  accumulating: "Accumulating",
  distributing: "Distributing",
  rug_exposed: "Collapse-exposed",
  session_trader: "Session trader",
  hard_to_copy: "Hard to copy",
};

/** Everything the rules read. Shares are 0–1, null when the denominator is empty. */
export interface ArchetypeStats {
  rated: boolean;
  trades: number;
  tokens: number;
  tradesPerDay: number | null;
  trades7d: number;
  devTokenShare: number | null;
  flashFlipShare: number | null;
  /** first buy ≤ 1 s after launch (≈ first 3 blocks) */
  launchBlockEntryShare: number | null;
  launchBlockDistinctDevs: number;
  medianHoldSec: number | null;
  medianEntryMcUsd: number | null;
  medianEntryDelaySec: number | null;
  /** first buy on a bonding curve (pump.fun curve, LaunchLab, DBC, Moonshot) */
  preGraduationShare: number | null;
  postGraduationShare: number | null;
  openAfter30dShare: number | null;
  avgBuysPerToken: number | null;
  avgSellsPerToken: number | null;
}

const lab = <T extends string>(id: T, label: string, reason: string): Labelled<T> => ({ id, label, reason });

export function classifyArchetype(s: ArchetypeStats): Labelled<ArchetypeId> {
  const A = (id: ArchetypeId, reason: string) => lab(id, ARCHETYPE_LABELS[id], reason);
  if (!s.rated) return A("unrated", `${s.trades} trades across ${s.tokens} tokens (needs ≥20 trades and ≥5 tokens)`);

  if (s.devTokenShare != null && s.devTokenShare > 0.5) {
    return A("deployer", `created ${fmtPct(s.devTokenShare)} of the tokens it traded`);
  }

  const bot: string[] = [];
  if (s.tradesPerDay != null && s.tradesPerDay > 50) bot.push(`${s.tradesPerDay.toFixed(0)} trades/day`);
  if (s.flashFlipShare != null && s.flashFlipShare >= 0.3) bot.push(`${fmtPct(s.flashFlipShare)} of positions round-tripped within 5s`);
  if (s.trades7d >= 2000) bot.push(`${s.trades7d} trades in 7 days`);
  if (bot.length) return A("bot_flipper", bot.join(", "));

  const hold = s.medianHoldSec;
  if (s.launchBlockEntryShare != null && s.launchBlockEntryShare >= 0.5 && s.launchBlockDistinctDevs >= 10 && hold != null && hold < 600) {
    return A(
      "sniper",
      `${fmtPct(s.launchBlockEntryShare)} of entries within ~1s of launch across ${s.launchBlockDistinctDevs} deployers; median hold ${fmtDuration(hold)}`,
    );
  }

  const mc = s.medianEntryMcUsd;
  const delay = s.medianEntryDelaySec;
  if (
    mc != null && mc < 100_000 &&
    s.preGraduationShare != null && s.preGraduationShare >= 0.6 &&
    delay != null && delay > 1 && delay <= 3600 &&
    hold != null && hold < 6 * 3600
  ) {
    return A(
      "early_ape",
      `median entry MC ${fmtUsd(mc)}, ${fmtPct(s.preGraduationShare)} of entries on the bonding curve, median entry ${fmtDuration(delay)} after launch, median hold ${fmtDuration(hold)}`,
    );
  }

  // Price-path data (≥2× in 60 min) is not available historically; graduated-token entries are the proxy.
  if (
    mc != null && mc >= 100_000 && mc <= 20_000_000 &&
    s.postGraduationShare != null && s.postGraduationShare >= 0.5 &&
    hold != null && hold >= 300 && hold <= 86_400
  ) {
    return A(
      "momentum_chaser",
      `median entry MC ${fmtUsd(mc)}, ${fmtPct(s.postGraduationShare)} of entries after graduation, median hold ${fmtDuration(hold)}`,
    );
  }

  if (hold != null && hold >= 60 && hold < 86_400) return A("intraday", `median hold ${fmtDuration(hold)}`);

  const tpd = s.tradesPerDay;
  if (hold != null && hold >= 86_400 && hold < 7 * 86_400 && tpd != null && tpd >= 1 && tpd <= 10) {
    return A("swing", `median hold ${fmtDuration(hold)}, ${tpd.toFixed(1)} trades/day`);
  }

  const longHold = hold != null && hold >= 7 * 86_400;
  const stillOpen = s.openAfter30dShare != null && s.openAfter30dShare >= 0.5;
  if ((longHold || stillOpen) && (s.avgSellsPerToken ?? 0) <= 2 && s.trades7d < 200) {
    return A(
      "diamond_hands",
      longHold ? `median hold ${fmtDuration(hold)}` : `${fmtPct(s.openAfter30dShare)} of positions still open after 30 days`,
    );
  }

  // No row matched exactly: closest row by hold time, numbers shown.
  if (hold == null) return A("diamond_hands", "no exits yet on most positions");
  if (hold < 86_400) return A("intraday", `closest match: median hold ${fmtDuration(hold)}`);
  if (hold < 7 * 86_400) return A("swing", `closest match: median hold ${fmtDuration(hold)}`);
  return A("diamond_hands", `closest match: median hold ${fmtDuration(hold)}`);
}

export interface FlagStats {
  tokens: number;
  winRate: number | null;
  closedPositions: number;
  tokensOver5x: number;
  deepLossShare: number | null; // closed positions < −50%
  realizedUsd: number;
  avgBuysPerToken: number | null;
  avgSellsPerToken: number | null;
  top3BuyShare: number | null;
  avgBuyUsd: number | null;
  buys: number;
  sells: number;
  deadTokenShare: number | null;
  deadTokenKnown: number;
  sessionWindowUtc: string | null;
  sessionShare: number | null;
  copyabilityScore: number | null;
  trackScore: number | null;
  promoteThenSell: Labelled<"promote_then_sell"> | null;
}

export function overlayFlags(s: FlagStats): Labelled<FlagId>[] {
  const F = (id: FlagId, reason: string) => lab(id, FLAG_LABELS[id], reason);
  const out: Labelled<FlagId>[] = [];
  if (s.promoteThenSell) out.push(s.promoteThenSell);
  if (s.winRate != null && s.winRate < 0.35 && s.tokensOver5x >= 1) {
    out.push(F("lottery", `win rate ${fmtPct(s.winRate)} with ${s.tokensOver5x} token(s) over 5x`));
  }
  if (s.deepLossShare != null && s.closedPositions >= 5) {
    if (s.deepLossShare <= 0.05 && s.realizedUsd > 0) {
      out.push(F("disciplined", `${fmtPct(s.deepLossShare)} of closed tokens below −50%, realized ${fmtUsd(s.realizedUsd)}`));
    }
    if (s.deepLossShare >= 0.3 && s.realizedUsd < 0) {
      out.push(F("bag_holder", `${fmtPct(s.deepLossShare)} of closed tokens below −50%, realized ${fmtUsd(s.realizedUsd)}`));
    }
  }
  if (s.avgBuysPerToken != null && s.avgBuysPerToken >= 3) out.push(F("scaler_in", `${s.avgBuysPerToken.toFixed(1)} buys per token`));
  if (s.avgSellsPerToken != null && s.avgSellsPerToken >= 3) out.push(F("partial_tp", `${s.avgSellsPerToken.toFixed(1)} sells per token`));
  if (s.tokens >= 5 && s.top3BuyShare != null && s.top3BuyShare >= 0.7) {
    out.push(F("concentrated", `top 3 tokens = ${fmtPct(s.top3BuyShare)} of buy volume`));
  }
  if (s.avgBuyUsd != null && s.avgBuyUsd >= 5000) out.push(F("whale", `average buy ${fmtUsd(s.avgBuyUsd)}`));
  if (s.sells > 0 && s.buys / s.sells >= 3) out.push(F("accumulating", `${s.buys} buys vs ${s.sells} sells`));
  if (s.buys > 0 && s.sells / s.buys >= 3) out.push(F("distributing", `${s.sells} sells vs ${s.buys} buys`));
  if (s.deadTokenShare != null && s.deadTokenKnown >= 5 && s.deadTokenShare >= 0.3) {
    out.push(F("rug_exposed", `${fmtPct(s.deadTokenShare)} of tokens closed ≥80% down or still held after liquidity fell below $4k`));
  }
  if (s.sessionWindowUtc && s.sessionShare != null) {
    out.push(F("session_trader", `${fmtPct(s.sessionShare)} of trades in ${s.sessionWindowUtc}`));
  }
  if (s.copyabilityScore != null && s.copyabilityScore < 35 && s.trackScore != null && s.trackScore >= 65) {
    out.push(F("hard_to_copy", `copyability ${s.copyabilityScore}/100 with track score ${s.trackScore.toFixed(0)}`));
  }
  return out;
}
