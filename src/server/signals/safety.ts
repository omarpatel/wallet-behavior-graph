/**
 * Token safety chips: the RugCheck + Jupiter
 * audit facts already on AlertFacts.safety, each with a good/warn/bad tone. Pure and client-safe (types only).
 */
import type { AlertFacts } from "@/server/alerts/types";

export type SafetyTone = "good" | "warn" | "bad";

export interface SafetyChip {
  label: string;
  tone: SafetyTone;
}

/** RugCheck risk 0–100: ≤30 good, ≤60 warn, else bad (conventional thresholds). */
export const rugTone = (score: number): SafetyTone => (score <= 30 ? "good" : score <= 60 ? "warn" : "bad");

/**
 * Chip order: RugCheck risk, mint, freeze, LP locked, top holders, liquidity. Unknown facts are omitted.
 * `onCurve`: the token still trades on a launchpad bonding curve, where there is no LP to lock — the LP chip is skipped.
 */
export function safetyChips(s: AlertFacts["safety"], opts: { onCurve?: boolean } = {}): SafetyChip[] {
  const chips: SafetyChip[] = [];
  if (s.rugScore != null) chips.push({ label: `risk ${s.rugScore}/100`, tone: rugTone(s.rugScore) });
  if (s.mintAuthorityDisabled != null) {
    chips.push({ label: s.mintAuthorityDisabled ? "mint revoked" : "mint live", tone: s.mintAuthorityDisabled ? "good" : "bad" });
  }
  if (s.freezeAuthorityDisabled != null) {
    chips.push({ label: s.freezeAuthorityDisabled ? "freeze revoked" : "freeze live", tone: s.freezeAuthorityDisabled ? "good" : "bad" });
  }
  if (s.lpLockedPct != null && !opts.onCurve) {
    chips.push({
      label: `LP ${s.lpLockedPct.toFixed(0)}% locked`,
      tone: s.lpLockedPct >= 80 ? "good" : s.lpLockedPct >= 1 ? "warn" : "bad",
    });
  }
  // Jupiter's figure is the top-10 holders' combined share (top-1 thresholds of 20/40 don't apply)
  if (s.topHoldersPct != null) {
    chips.push({
      label: `top holders ${s.topHoldersPct.toFixed(0)}%`,
      tone: s.topHoldersPct < 30 ? "good" : s.topHoldersPct < 50 ? "warn" : "bad",
    });
  }
  if (s.liquidityUsd != null) {
    const k = s.liquidityUsd >= 1e6 ? `$${(s.liquidityUsd / 1e6).toFixed(1)}M` : `$${Math.round(s.liquidityUsd / 1e3)}K`;
    chips.push({ label: `liquidity ${k}`, tone: s.liquidityUsd >= 50_000 ? "good" : s.liquidityUsd >= 5_000 ? "warn" : "bad" });
  }
  return chips;
}
