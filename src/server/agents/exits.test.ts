import { describe, expect, it } from "vitest";
import { DEAD_AFTER_SEC, evaluateExit, type ExitPosition } from "./exits";
import { marketChecks, safetyChecks, verdict } from "./features";
import type { CandidateFeatures, EntryRules, ExitPlan } from "./types";

const plan: ExitPlan = {
  timeStopSec: 600,
  stopLossPct: -30,
  ladder: [
    { pct: 50, fraction: 0.33 },
    { pct: 100, fraction: 0.5 },
    { pct: 200, fraction: 1 },
  ],
  initialsOutPct: null,
  trailingStopPct: 25,
};
const pos = (o: Partial<ExitPosition> = {}): ExitPosition => ({ entryPriceUsd: 1, peakPriceUsd: 1, openedAt: 1000, tpStepsHit: 0, initialsOutDone: false, ...o });

describe("evaluateExit", () => {
  it("never acts on a stale price (except time stop / dead token)", () => {
    expect(evaluateExit(plan, pos(), { priceUsd: 0.1, at: 1000 }, 1100)).toBeNull(); // −90% but 100 s old
    expect(evaluateExit(plan, pos(), { priceUsd: 0.1, at: 1000 }, 1700)?.tag).toBe("time");
    expect(evaluateExit(plan, pos({ openedAt: 0 }), { priceUsd: null, at: null }, DEAD_AFTER_SEC)?.tag).toBe("dead");
  });

  it("stop-loss beats everything", () => {
    expect(evaluateExit(plan, pos(), { priceUsd: 0.69, at: 1010 }, 1010)).toMatchObject({ tag: "sl", fraction: 1 });
  });

  it("walks the ladder one step at a time", () => {
    expect(evaluateExit(plan, pos(), { priceUsd: 1.6, at: 1010 }, 1010)).toMatchObject({ tag: "tp1", fraction: 0.33 });
    expect(evaluateExit(plan, pos({ tpStepsHit: 1, peakPriceUsd: 1.6 }), { priceUsd: 1.6, at: 1010 }, 1010)).toBeNull();
    expect(evaluateExit(plan, pos({ tpStepsHit: 1, peakPriceUsd: 2.1 }), { priceUsd: 2.05, at: 1010 }, 1010)).toMatchObject({ tag: "tp2", fraction: 0.5 });
  });

  it("trails only after the first take-profit", () => {
    expect(evaluateExit(plan, pos({ peakPriceUsd: 1.45 }), { priceUsd: 1.05, at: 1010 }, 1010)).toBeNull();
    expect(evaluateExit(plan, pos({ tpStepsHit: 1, peakPriceUsd: 1.9 }), { priceUsd: 1.4, at: 1010 }, 1010)?.tag).toBe("trail");
  });

  it("initials out sells the cost basis", () => {
    const a = evaluateExit({ ...plan, initialsOutPct: 100, ladder: [{ pct: 300, fraction: 1 }] }, pos(), { priceUsd: 2, at: 1010 }, 1010);
    expect(a?.tag).toBe("io");
    expect(a?.fraction).toBeCloseTo(0.5, 6);
  });

  it("time stop with a fresh price", () => {
    expect(evaluateExit(plan, pos(), { priceUsd: 1.1, at: 1600 }, 1600)?.tag).toBe("time");
  });
});

const rules: EntryRules = {
  launchpads: ["pump.fun"],
  phase: "curve",
  entryMcUsd: { min: 5_000, max: 40_000 },
  entryDelaySec: { min: 20, max: 480 },
  momentum: { lookbackSec: 0, minChangePct: 0 },
  minLiquidityUsd: 1_500,
  maxRugScore: 60,
  requireMintRevoked: true,
  requireFreezeRevoked: true,
  maxTopHoldersPct: 30,
  minSwarmMembers: 0,
  demand: { windowSec: 60, minNetInflowSol: 1, minBuySellRatio: 1.2 },
};
const f = (o: Partial<CandidateFeatures> = {}): CandidateFeatures => ({
  mint: "M",
  symbol: "M",
  name: null,
  launchpad: "pump.fun",
  phase: "curve",
  ageSec: 60,
  mcUsd: 9_000,
  priceUsd: 0.000009,
  liquidityUsd: 2_000,
  change5mPct: null,
  change1hPct: null,
  buys5m: null,
  sells5m: null,
  rugScore: null,
  mintRevoked: true,
  freezeRevoked: true,
  topHoldersPct: 12,
  swarmMembers: 0,
  source: "test",
  netInflowSol: 2.5,
  curveProgressPct: 10,
  priceAgeSec: 2,
  ...o,
});

describe("entry rules", () => {
  it("passes a token inside every band", () => {
    expect(verdict("market", marketChecks(rules, f(), null)).pass).toBe(true);
    expect(verdict("safety", safetyChecks(rules, f())).pass).toBe(true);
  });

  it("treats unknown flow as a miss, never as zero", () => {
    const v = verdict("market", marketChecks(rules, f({ netInflowSol: null }), null));
    expect(v.pass).toBe(false);
    expect(v.misses[0]).toMatchObject({ status: "unknown" });
  });

  it("reports each failing band", () => {
    const v = verdict("market", marketChecks(rules, f({ mcUsd: 50_000, ageSec: 5 }), null));
    expect(v.misses.map((m) => m.rule)).toEqual(["MC", "age"]);
  });

  it("requires RugCheck for pool tokens but not on the curve", () => {
    expect(verdict("safety", safetyChecks({ ...rules, phase: "graduated" }, f({ phase: "graduated" }))).pass).toBe(false);
    expect(verdict("safety", safetyChecks(rules, f({ rugScore: 80 }))).pass).toBe(false);
  });
});
