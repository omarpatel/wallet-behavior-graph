/**
 * Exit-rule engine: stop-loss, trailing stop, time stop, initials-out and the take-profit
 * ladder, evaluated every tick against a live price. Pure. Guards: never act on a price older than PRICE_MAX_AGE_SEC
 * (except the time stop, which needs no price); a token with no price for DEAD_AFTER_SEC is treated as dead (value 0)
 * and a sell is attempted — if no route exists the position is written off.
 */
import { PRICE_MAX_AGE_SEC } from "./config";
import { dur } from "./strategy";
import type { ExitPlan } from "./types";

export const DEAD_AFTER_SEC = 15 * 60;

export interface ExitPosition {
  entryPriceUsd: number | null;
  peakPriceUsd: number | null;
  openedAt: number;
  tpStepsHit: number;
  initialsOutDone: boolean;
}

export interface ExitAction {
  /** Fraction of the CURRENT quantity to sell (1 = everything). */
  fraction: number;
  /** Stable per position: idempotency key component ("sl", "trail", "time", "tp1", "io", "dead"). */
  tag: string;
  reason: string;
}

export interface PriceMark {
  priceUsd: number | null;
  at: number | null;
}

export function evaluateExit(plan: ExitPlan, pos: ExitPosition, price: PriceMark, now: number): ExitAction | null {
  const fresh = price.priceUsd != null && price.at != null && now - price.at <= PRICE_MAX_AGE_SEC;
  const held = now - pos.openedAt;
  if (!fresh) {
    const lastSeen = price.at ?? pos.openedAt;
    if (now - lastSeen >= DEAD_AFTER_SEC) return { fraction: 1, tag: "dead", reason: `no price for ${Math.round((now - lastSeen) / 60)}m: treated as dead (value 0), selling` };
    if (held >= plan.timeStopSec) return { fraction: 1, tag: "time", reason: `time stop after ${dur(held)} (price stale)` };
    return null;
  }
  const p = price.priceUsd!;
  const entry = pos.entryPriceUsd;
  if (entry == null || entry <= 0) return held >= plan.timeStopSec ? { fraction: 1, tag: "time", reason: `time stop after ${dur(held)}` } : null;
  const pnlPct = (p / entry - 1) * 100;
  const sign = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

  if (pnlPct <= plan.stopLossPct) return { fraction: 1, tag: "sl", reason: `stop-loss ${sign(pnlPct)} ≤ ${plan.stopLossPct}%` };

  const peak = Math.max(pos.peakPriceUsd ?? p, p);
  if (plan.trailingStopPct != null && (pos.tpStepsHit > 0 || pos.initialsOutDone)) {
    const fromPeak = (p / peak - 1) * 100;
    if (fromPeak <= -plan.trailingStopPct)
      return { fraction: 1, tag: "trail", reason: `trailing stop ${fromPeak.toFixed(1)}% from peak (limit −${plan.trailingStopPct}%)` };
  }

  if (held >= plan.timeStopSec) return { fraction: 1, tag: "time", reason: `time stop after ${dur(held)} at ${sign(pnlPct)}` };

  if (plan.initialsOutPct != null && !pos.initialsOutDone && pnlPct >= plan.initialsOutPct) {
    // value = cost × (1 + pnl); selling cost / value of the bag recovers the cost basis
    return { fraction: 1 / (1 + pnlPct / 100), tag: "io", reason: `initials out at ${sign(pnlPct)}` };
  }

  const step = plan.ladder[pos.tpStepsHit];
  if (step && pnlPct >= step.pct) {
    return { fraction: step.fraction, tag: `tp${pos.tpStepsHit + 1}`, reason: `take-profit ${pos.tpStepsHit + 1}/${plan.ladder.length} at ${sign(pnlPct)} (target +${step.pct}%)` };
  }
  return null;
}
