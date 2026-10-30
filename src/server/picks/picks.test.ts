import { describe, expect, it } from "vitest";
import { DEAD_AFTER_SEC } from "@/server/agents/exits";
import type { ExitPlan, SizingRules } from "@/server/agents/types";
import { markedOutcomePct, PICK_DEDUPE_SEC, PICK_MAX_OPEN_PER_BRAIN, pickGate, pickMark, pickStats, stepPick, suggestedFraction, type PaperPick } from "./logic";

const plan: ExitPlan = {
  timeStopSec: 3600,
  stopLossPct: -30,
  ladder: [
    { pct: 100, fraction: 0.5 },
    { pct: 300, fraction: 1 },
  ],
  initialsOutPct: null,
  trailingStopPct: 20,
};
const T0 = 1_000_000;
const pick = (o: Partial<PaperPick> = {}): PaperPick => ({
  createdAt: T0,
  entryPriceUsd: 1,
  peakPriceUsd: 1,
  lastPriceUsd: 1,
  lastPriceAt: T0,
  tpStepsHit: 0,
  initialsOutDone: false,
  remaining: 1,
  realized: 0,
  ...o,
});
const gate = { now: T0, lastPickOnMintAt: null, mintOpen: false, picksLastHour: 0, openPicks: 0, maxPerHour: 6 };

describe("pickGate", () => {
  it("passes a fresh token under the caps", () => {
    expect(pickGate(gate)).toBeNull();
  });
  it("dedupes per brain + token: open pick, or any pick in the last 24h", () => {
    expect(pickGate({ ...gate, mintOpen: true })).toMatch(/open pick/);
    expect(pickGate({ ...gate, lastPickOnMintAt: T0 - PICK_DEDUPE_SEC + 60 })).toMatch(/24h/);
    expect(pickGate({ ...gate, lastPickOnMintAt: T0 - PICK_DEDUPE_SEC })).toBeNull();
  });
  it("caps picks per brain per hour and open picks per brain", () => {
    expect(pickGate({ ...gate, picksLastHour: 5 })).toBeNull();
    expect(pickGate({ ...gate, picksLastHour: 6 })).toMatch(/hourly cap of 6/);
    expect(pickGate({ ...gate, openPicks: PICK_MAX_OPEN_PER_BRAIN })).toMatch(/open picks/);
  });
});

describe("suggestedFraction", () => {
  const sizing: SizingRules = { baseFraction: 0.05, maxFraction: 0.15, style: "conviction", maxPositionLamports: 1e9, maxOpenPositions: 3, minTradeLamports: 1e7 };
  it("scales base → max by conviction, clamped", () => {
    expect(suggestedFraction(sizing, 0)).toBe(0.05);
    expect(suggestedFraction(sizing, 0.5)).toBe(0.1);
    expect(suggestedFraction(sizing, 2)).toBe(0.15);
  });
  it("is flat for fixed sizing", () => {
    expect(suggestedFraction({ ...sizing, style: "fixed" }, 1)).toBe(0.05);
  });
});

describe("stepPick (paper exit plan)", () => {
  it("records price and peak without acting inside the plan", () => {
    const s = stepPick(plan, pick(), { priceUsd: 1.5, at: T0 + 10 }, T0 + 10);
    expect(s.closed).toBeNull();
    expect(s.changed).toBe(true);
    expect(s.pick).toMatchObject({ lastPriceUsd: 1.5, peakPriceUsd: 1.5, remaining: 1, realized: 0 });
    expect(stepPick(plan, s.pick, { priceUsd: 1.5, at: T0 + 10 }, T0 + 12).changed).toBe(false);
  });

  it("takes profit on the ladder, then closes on the trailing stop", () => {
    const a = stepPick(plan, pick(), { priceUsd: 2.1, at: T0 + 60 }, T0 + 60);
    expect(a.closed).toBeNull();
    expect(a.fired).toHaveLength(1);
    expect(a.pick).toMatchObject({ tpStepsHit: 1, remaining: 0.5 });
    expect(a.pick.realized).toBeCloseTo(1.05);
    expect(markedOutcomePct(a.pick, T0 + 60)).toBe(110);
    const b = stepPick(plan, a.pick, { priceUsd: 1.6, at: T0 + 120 }, T0 + 120); // −23.8% from the 2.1 peak
    expect(b.closed).toEqual({ reason: "trail", outcomePct: 85 }); // 0.5 × 2.1 + 0.5 × 1.6 = 1.85 stakes
    expect(b.pick.remaining).toBe(0);
  });

  it("crosses several rungs in one jump", () => {
    const s = stepPick(plan, pick(), { priceUsd: 4.5, at: T0 + 30 }, T0 + 30);
    expect(s.fired).toHaveLength(2);
    expect(s.closed).toEqual({ reason: "tp", outcomePct: 350 });
  });

  it("stops out at the stop-loss", () => {
    expect(stepPick(plan, pick(), { priceUsd: 0.65, at: T0 + 30 }, T0 + 30).closed).toEqual({ reason: "sl", outcomePct: -35 });
  });

  it("closes on the time stop at the last price", () => {
    expect(stepPick(plan, pick(), { priceUsd: 1.2, at: T0 + 3600 }, T0 + 3600).closed).toEqual({ reason: "time", outcomePct: 20 });
  });

  it("writes the remainder off when the token has no price for DEAD_AFTER_SEC", () => {
    const half = pick({ tpStepsHit: 1, remaining: 0.5, realized: 1.05, peakPriceUsd: 2.1, lastPriceUsd: 2.1, lastPriceAt: T0 + 60 });
    const now = T0 + 60 + DEAD_AFTER_SEC;
    const s = stepPick({ ...plan, timeStopSec: 86_400 }, half, { priceUsd: 2.1, at: T0 + 60 }, now);
    expect(s.closed).toEqual({ reason: "dead", outcomePct: 5 });
  });
});

describe("pickMark", () => {
  const p = pick({ lastPriceUsd: 1.3, lastPriceAt: T0 });
  it("uses the hub price when fresh", () => {
    expect(pickMark({ priceUsd: 1.4, priceAt: T0 + 2000 }, p, T0, 30, T0 + 2010)).toEqual({ priceUsd: 1.4, at: T0 + 2000 });
  });
  it("does not count runner downtime as 'no price'", () => {
    const m = pickMark(null, p, T0 + 5000, 30, T0 + 5010);
    expect(m).toEqual({ priceUsd: 1.3, at: T0 + 5000 });
    expect(stepPick({ ...plan, timeStopSec: 86_400 }, p, m, T0 + 5010).closed).toBeNull();
  });
});

describe("pickStats", () => {
  it("summarises closed outcomes", () => {
    const s = pickStats([
      { status: "closed", outcomePct: 85, createdAt: 1 },
      { status: "closed", outcomePct: -35, createdAt: 2 },
      { status: "closed", outcomePct: 20, createdAt: 3 },
      { status: "closed", outcomePct: -10, createdAt: 4 },
      { status: "open", outcomePct: null, createdAt: 5 },
    ]);
    expect(s).toMatchObject({ picks: 5, open: 1, closed: 4, wins: 2, winRate: 0.5, medianOutcomePct: 5, avgOutcomePct: 15, bestOutcomePct: 85, worstOutcomePct: -35, lastPickAt: 5 });
    expect(pickStats([])).toMatchObject({ picks: 0, closed: 0, winRate: null, medianOutcomePct: null });
  });
});
