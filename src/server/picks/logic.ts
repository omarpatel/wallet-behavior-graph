/**
 * Pure Brain Picks logic (no DB, no feeds): publishing gates, style sizing, the paper exit simulation and track-record
 * stats. The engine (engine.ts) and the read models (queries.ts) call these; picks.test.ts covers them.
 */
import { DEAD_AFTER_SEC, evaluateExit, type PriceMark } from "@/server/agents/exits";
import type { RuleCheck } from "@/server/agents/features";
import type { ExitPlan, SizingRules } from "@/server/agents/types";
import type { PickCloseReason, PickStatsDTO } from "./types";

/** One pick per brain + token in this window (an open pick on the token also blocks a new one). */
export const PICK_DEDUPE_SEC = 24 * 3600;
/** Open picks per brain at most (bounds tracking; the style's agents would not hold more either). */
export const PICK_MAX_OPEN_PER_BRAIN = 10;
/** A remainder below this share of the stake counts as sold out. */
const DUST = 1e-6;
/** Exit actions applied in one step at most (a jump can cross several ladder rungs at once). */
const MAX_ACTIONS_PER_STEP = 8;

export interface PickGateInput {
  now: number;
  /** createdAt of this brain's latest pick on the token, any status (null = never picked). */
  lastPickOnMintAt: number | null;
  /** This brain has an open pick on the token. */
  mintOpen: boolean;
  /** This brain's picks created in the last hour. */
  picksLastHour: number;
  /** This brain's open picks. */
  openPicks: number;
  maxPerHour: number;
}

/** Why a brain can't publish a pick on this token now, or null when it can. */
export function pickGate(i: PickGateInput): string | null {
  if (i.mintOpen) return "already an open pick on this token";
  if (i.lastPickOnMintAt != null && i.now - i.lastPickOnMintAt < PICK_DEDUPE_SEC) return "picked within the last 24h";
  if (i.picksLastHour >= i.maxPerHour) return `hourly cap of ${i.maxPerHour} picks reached`;
  if (i.openPicks >= PICK_MAX_OPEN_PER_BRAIN) return `${PICK_MAX_OPEN_PER_BRAIN} open picks already`;
  return null;
}

/** The style's position size for a pick (fraction of a bankroll): fixed styles flat, others base → max by conviction. */
export function suggestedFraction(s: SizingRules, confidence: number): number {
  const c = Math.min(1, Math.max(0, confidence));
  const f = s.style === "fixed" ? s.baseFraction : s.baseFraction + (s.maxFraction - s.baseFraction) * c;
  return Math.round(f * 10_000) / 10_000;
}

/** "Matches this wallet's style (Sniper): MC $12k; age 45s; …; safety: mint authority revoked; RugCheck 1". */
export function pickReason(archetype: string, market: RuleCheck[], safety: RuleCheck[]): string {
  const m = market.map((c) => c.detail).join("; ");
  const s = safety.map((c) => c.detail).join("; ");
  return `Matches this wallet's style (${archetype}): ${m}${s ? `; safety: ${s}` : ""}`.slice(0, 1_000);
}

/** Paper position of a pick: 1 stake bought at entryPriceUsd, sold down by the style's exit plan. */
export interface PaperPick {
  createdAt: number;
  entryPriceUsd: number;
  peakPriceUsd: number | null;
  lastPriceUsd: number | null;
  lastPriceAt: number | null;
  tpStepsHit: number;
  initialsOutDone: boolean;
  /** Share of the stake still held, 0–1. */
  remaining: number;
  /** Proceeds so far, in stakes. */
  realized: number;
}

export interface PickStep {
  pick: PaperPick;
  /** Exit rules that fired in this step ("take-profit 1/2 at +104.0% (target +100%)"). */
  fired: string[];
  closed: { reason: PickCloseReason; outcomePct: number } | null;
  /** State to persist changed (price, peak or an exit fired). */
  changed: boolean;
}

function closeReason(tag: string): PickCloseReason {
  if (tag.startsWith("tp") || tag === "io") return "tp";
  if (tag === "sl" || tag === "trail" || tag === "time" || tag === "dead") return tag;
  return "time";
}

/**
 * Advance a pick by one mark: record a fresh price (and peak), then apply the exit plan (evaluateExit, the same engine
 * the agents use) until nothing fires or the position is gone. A sale realizes `sold × price / entry`; "dead" realizes 0.
 * `mark` is the hub's price when fresh, else the last known price with `at` = when it was last seen.
 */
export function stepPick(plan: ExitPlan, p0: PaperPick, mark: PriceMark, now: number): PickStep {
  const p = { ...p0 };
  let changed = false;
  if (mark.priceUsd != null && mark.at != null && mark.priceUsd > 0 && (mark.priceUsd !== p.lastPriceUsd || mark.at !== p.lastPriceAt)) {
    p.lastPriceUsd = mark.priceUsd;
    p.lastPriceAt = mark.at;
    p.peakPriceUsd = Math.max(p.peakPriceUsd ?? p.entryPriceUsd, mark.priceUsd);
    changed = true;
  }
  const fired: string[] = [];
  for (let i = 0; i < MAX_ACTIONS_PER_STEP && p.remaining > DUST; i++) {
    const a = evaluateExit(plan, { entryPriceUsd: p.entryPriceUsd, peakPriceUsd: p.peakPriceUsd, openedAt: p.createdAt, tpStepsHit: p.tpStepsHit, initialsOutDone: p.initialsOutDone }, mark, now);
    if (!a) break;
    changed = true;
    fired.push(a.reason);
    const price = a.tag === "dead" ? 0 : (p.lastPriceUsd ?? 0);
    const sold = a.fraction >= 0.999 ? p.remaining : p.remaining * a.fraction;
    p.realized += (sold * price) / p.entryPriceUsd;
    p.remaining = Math.max(0, p.remaining - sold);
    if (a.tag.startsWith("tp")) p.tpStepsHit++;
    if (a.tag === "io") p.initialsOutDone = true;
    if (p.remaining <= DUST) {
      p.remaining = 0;
      return { pick: p, fired, closed: { reason: closeReason(a.tag), outcomePct: round2((p.realized - 1) * 100) }, changed };
    }
  }
  return { pick: p, fired, closed: null, changed };
}

/** Mark for a pick: the hub's fresh price, else the last stored price seen no earlier than `aliveSince` (engine start). */
export function pickMark(
  hub: { priceUsd: number | null; priceAt: number | null } | null,
  p: Pick<PaperPick, "lastPriceUsd" | "lastPriceAt" | "createdAt">,
  aliveSince: number,
  maxAgeSec: number,
  now: number,
): PriceMark {
  if (hub?.priceUsd != null && hub.priceAt != null && now - hub.priceAt <= maxAgeSec) return { priceUsd: hub.priceUsd, at: hub.priceAt };
  // Downtime of the runner is not "no price": count staleness from when we were watching again.
  return { priceUsd: p.lastPriceUsd, at: Math.max(p.lastPriceAt ?? p.createdAt, aliveSince) };
}

export const gainPct = (price: number | null, entry: number) => (price != null && entry > 0 ? round2((price / entry - 1) * 100) : null);

/** Paper result so far, % of the stake: realized + the remainder at the last price (dead after DEAD_AFTER_SEC unpriced). */
export function markedOutcomePct(p: PaperPick, now: number): number | null {
  if (p.remaining <= DUST) return round2((p.realized - 1) * 100);
  if (p.lastPriceUsd == null) return null;
  const alive = p.lastPriceAt != null && now - p.lastPriceAt < DEAD_AFTER_SEC;
  return round2((p.realized + (alive ? (p.remaining * p.lastPriceUsd) / p.entryPriceUsd : 0) - 1) * 100);
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export interface StatsRow {
  status: "open" | "closed";
  outcomePct: number | null;
  createdAt: number;
}

export function pickStats(rows: StatsRow[]): PickStatsDTO {
  const outcomes = rows.filter((r) => r.status === "closed" && r.outcomePct != null).map((r) => r.outcomePct!);
  const sorted = [...outcomes].sort((a, b) => a - b);
  const n = sorted.length;
  const wins = sorted.filter((v) => v > 0).length;
  const median = n ? (n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : null;
  return {
    picks: rows.length,
    open: rows.filter((r) => r.status === "open").length,
    closed: n,
    wins,
    winRate: n ? wins / n : null,
    medianOutcomePct: median != null ? round2(median) : null,
    avgOutcomePct: n ? round2(sorted.reduce((s, v) => s + v, 0) / n) : null,
    bestOutcomePct: n ? sorted[n - 1] : null,
    worstOutcomePct: n ? sorted[0] : null,
    lastPickAt: rows.length ? Math.max(...rows.map((r) => r.createdAt)) : null,
  };
}
