import { describe, expect, it } from "vitest";
import type { ArchetypeId, BrainProfile, Buckets } from "@/server/profile/types";
import { applyOverrides, bucketQuantile, deriveStrategy, OverrideError, validateOverrides } from "./strategy";
import type { StrategySpec } from "./types";

const b = (labels: string[], counts: number[]): Buckets => labels.map((label, i) => ({ label, count: counts[i] ?? 0 }));
const MC = ["<$10k", "$10–30k", "$30–100k", "$100k–1M", "$1–10M", "$10–100M", "≥$100M"];
const HOLD = ["<1m", "1–5m", "5–60m", "1–24h", "1–7d", ">7d", "still open"];
const PNL = [">5x", "2–5x", "0–2x", "−50–0%", "< −50%"];

interface Shape {
  archetype: ArchetypeId;
  rated?: boolean;
  mc: number[];
  hold: number[];
  pnl?: number[];
  p25?: number | null;
  p75?: number | null;
  preGrad?: number | null;
  pads?: number[]; // pump.fun, bonk, other, unknown
  style?: BrainProfile["sizing"]["style"];
  ladderShare?: number | null;
  initialsOutShare?: number | null;
  stopOutShare?: number | null;
  fullDumpShare?: number | null;
  tradesPerDay?: number | null;
  flags?: BrainProfile["flags"];
}

/** Minimal profiles shaped like real ones in data/wbg.db (one per archetype, numbers rounded). */
function profile(s: Shape): BrainProfile {
  return {
    schemaVersion: 1,
    computedAt: 1_792_680_980,
    windowDays: 90,
    sample: { trades: 500, buys: 250, sells: 250, tokens: 200, firstTradeAt: null, lastTradeAt: null, activeDays: 30 },
    rated: s.rated ?? true,
    archetype: { id: s.archetype, label: s.archetype, reason: "fixture" },
    flags: s.flags ?? [],
    pnl: {
      realizedUsd: 0,
      realizedSol: 0,
      costUsd: 0,
      roi: null,
      winRate: null,
      closedPositions: 100,
      openPositions: 5,
      profitFactor: null,
      buckets: b(PNL, s.pnl ?? [1, 5, 30, 40, 24]),
    },
    timing: {
      medianEntryDelaySec: s.p25 != null && s.p75 != null ? Math.sqrt(s.p25 * s.p75) : null,
      p25EntryDelaySec: s.p25 ?? null,
      p75EntryDelaySec: s.p75 ?? null,
      buckets: [],
      preGraduationShare: s.preGrad ?? null,
      firstMinuteShare: null,
    },
    entryMc: { medianUsd: null, buckets: b(MC, s.mc) },
    hold: {
      medianHoldSec: null,
      flashFlipShare: null,
      soldWithin5mShare: null,
      soldWithin1hShare: null,
      soldWithin24hShare: null,
      buckets: b(HOLD, s.hold),
    },
    sizing: { medianBuySol: 1, medianBuyUsd: 100, avgBuyUsd: 150, cv: 1, style: s.style === undefined ? "variable" : s.style },
    exits: {
      avgBuysPerToken: 2,
      avgSellsPerToken: 1.5,
      fullDumpShare: s.fullDumpShare ?? 0.7,
      ladderShare: s.ladderShare ?? 0.1,
      initialsOutShare: s.initialsOutShare ?? 0.01,
      stopOutShare: s.stopOutShare ?? 0.2,
    },
    coinMix: { launchpads: b(["pump.fun", "bonk", "other", "unknown"], s.pads ?? [100, 0, 20, 0]), venues: [] },
    activity: { tradesPerDay: s.tradesPerDay === undefined ? 20 : s.tradesPerDay, hourHistogramUtc: [], sessionWindowUtc: null },
    copyability: { score: 40, reason: "fixture" },
    trackScore: 50,
    tier: "B",
    topWins: [],
    topLosses: [],
    recentTokens: [],
    promoteThenSell: null,
  };
}

function derive(s: Shape): StrategySpec {
  const r = deriveStrategy(profile(s), { brainId: "fixture" });
  if (!r.ok) throw new Error(r.reason);
  return r.strategy;
}

function expectSane(s: StrategySpec) {
  expect(s.entry.entryMcUsd.min).toBeGreaterThan(0);
  expect(s.entry.entryMcUsd.max).toBeGreaterThan(s.entry.entryMcUsd.min);
  expect(s.entry.entryDelaySec.max).toBeGreaterThan(s.entry.entryDelaySec.min);
  expect(s.exit.stopLossPct).toBeLessThan(0);
  expect(s.exit.timeStopSec).toBeGreaterThanOrEqual(120);
  expect(s.exit.ladder.at(-1)?.fraction).toBe(1);
  expect(s.sizing.maxFraction).toBeGreaterThanOrEqual(s.sizing.baseFraction);
  expect(s.risk.maxTradesPerHour).toBeGreaterThanOrEqual(1);
  for (const k of ["entry.phase", "entry.entryMcUsd", "entry.entryDelaySec", "exit.timeStopSec", "exit.ladder", "exit.stopLossPct", "sizing.style"])
    expect(s.provenance[k], k).toBeTruthy();
  expect(s.summary).toMatch(/^Hunts /);
}

describe("bucketQuantile", () => {
  it("log-interpolates inside the bucket", () => {
    const q = bucketQuantile(b(MC, [0, 10, 0, 0, 0, 0, 0]), [2_500, 10_000, 30_000, 100_000, 1e6, 1e7, 1e8, 1e9], 0.5)!;
    expect(q).toBeCloseTo(Math.sqrt(10_000 * 30_000), 0);
  });
  it("is null for empty buckets", () => {
    expect(bucketQuantile(b(MC, []), [1, 2, 3, 4, 5, 6, 7, 8], 0.5)).toBeNull();
  });
});

describe("deriveStrategy per archetype", () => {
  it("bot_flipper: curve, pump.fun, tiny MC, short time stop, many trades", () => {
    const s = derive({
      archetype: "bot_flipper",
      mc: [624, 395, 191, 40, 1, 1, 0],
      hold: [707, 300, 189, 23, 2, 1, 30],
      p25: 7,
      p75: 186,
      preGrad: 0.82,
      pads: [1155, 14, 78, 5],
      style: "conviction",
      tradesPerDay: 515,
      stopOutShare: 0.28,
    });
    expectSane(s);
    expect(s.entry.phase).toBe("curve");
    expect(s.entry.launchpads).toEqual(["pump.fun"]);
    expect(s.entry.entryMcUsd.max).toBeLessThanOrEqual(30_000);
    expect(s.entry.entryDelaySec).toEqual({ min: 7, max: 186 });
    expect(s.exit.timeStopSec).toBeLessThanOrEqual(10 * 60);
    expect(s.risk.maxTradesPerHour).toBe(30);
    expect(s.sizing.style).toBe("conviction");
    expect(s.sizing.maxFraction).toBeGreaterThan(s.sizing.baseFraction);
    expect(s.entry.demand?.minNetInflowSol).toBeGreaterThan(0);
  });

  it("early_ape: curve entries in the first minutes", () => {
    const s = derive({ archetype: "early_ape", mc: [72, 96, 54, 13, 3, 1, 0], hold: [175, 45, 11, 1, 2, 0, 5], p25: 19.5, p75: 483, preGrad: 0.76 });
    expectSane(s);
    expect(s.entry.phase).toBe("curve");
    expect(s.entry.entryDelaySec.min).toBe(20);
    expect(s.entry.entryDelaySec.max).toBe(483);
    expect(s.entry.momentum.minChangePct).toBe(0);
  });

  it("momentum_chaser: graduated, momentum gate, hours-long time stop", () => {
    const s = derive({
      archetype: "momentum_chaser",
      mc: [5, 7, 19, 39, 26, 1, 1],
      hold: [1, 0, 27, 56, 11, 1, 11],
      p25: 16_336,
      p75: 830_826,
      preGrad: 0.04,
      pads: [45, 1, 56, 5],
      style: "conviction",
      stopOutShare: 0.3,
    });
    expectSane(s);
    expect(s.entry.phase).toBe("graduated");
    expect(s.entry.launchpads).toEqual([]);
    expect(s.entry.momentum.minChangePct).toBeGreaterThan(0);
    expect(s.entry.entryMcUsd.min).toBeGreaterThanOrEqual(30_000);
    expect(s.exit.timeStopSec).toBeGreaterThanOrEqual(3600);
    expect(s.exit.trailingStopPct).toBe(20);
    expect(s.exit.stopLossPct).toBe(-20); // disciplined: 30% stop-outs tighten −25% × 0.8
  });

  it("intraday: any phase with a ladder when the brain sells in steps", () => {
    const s = derive({ archetype: "intraday", mc: [58, 132, 105, 88, 10, 0, 0], hold: [102, 81, 88, 50, 40, 19, 13], p25: 42, p75: 1863, preGrad: 0.46, ladderShare: 0.3, initialsOutShare: 0.15 });
    expectSane(s);
    expect(s.entry.phase).toBe("any");
    expect(s.exit.ladder).toHaveLength(3);
    expect(s.exit.initialsOutPct).toBe(100);
    expect(s.exit.trailingStopPct).toBe(25);
  });

  it("swing: graduated, wide stops, days-long time stop, tight slippage", () => {
    const s = derive({ archetype: "swing", mc: [0, 0, 6, 14, 1, 0, 0], hold: [0, 0, 1, 2, 5, 0, 13], p25: 44_320, p75: 319_695, preGrad: 0, pads: [15, 0, 6, 0], tradesPerDay: 3.2 });
    expectSane(s);
    expect(s.entry.phase).toBe("graduated");
    expect(s.exit.timeStopSec).toBeGreaterThanOrEqual(86_400);
    expect(s.risk.slippageBps).toBe(300);
    expect(s.risk.maxTradesPerHour).toBe(1);
  });

  it("diamond_hands with an all-null profile falls back to archetype defaults", () => {
    const s = derive({ archetype: "diamond_hands", mc: [], hold: [], p25: null, p75: null, preGrad: null, pads: [0, 0, 0, 0], style: null, tradesPerDay: null, ladderShare: null, initialsOutShare: null, stopOutShare: null, fullDumpShare: null });
    expectSane(s);
    expect(s.entry.phase).toBe("graduated");
    expect(s.provenance["entry.entryMcUsd"]).toMatch(/default/);
    expect(s.provenance["exit.timeStopSec"]).toMatch(/default/);
    expect(s.sizing.style).toBe("variable");
  });

  it("sniper: sub-30s entries", () => {
    const s = derive({ archetype: "sniper", mc: [900, 50, 5, 0, 0, 0, 0], hold: [500, 100, 20, 0, 0, 0, 3], p25: 1, p75: 9, preGrad: 0.95 });
    expectSane(s);
    expect(s.entry.entryDelaySec.min).toBe(2);
    expect(s.entry.entryDelaySec.max).toBe(32);
  });

  it("refuses unrated and deployer brains", () => {
    expect(deriveStrategy(profile({ archetype: "unrated", rated: false, mc: [], hold: [] }), { brainId: "x" }).ok).toBe(false);
    expect(deriveStrategy(profile({ archetype: "deployer", mc: [1], hold: [1] }), { brainId: "x" }).ok).toBe(false);
    expect(deriveStrategy(null, { brainId: "x" }).ok).toBe(false);
  });

  it("is deterministic", () => {
    const shape: Shape = { archetype: "intraday", mc: [1, 2, 3, 4, 0, 0, 0], hold: [1, 2, 3, 0, 0, 0, 0], p25: 60, p75: 600, preGrad: 0.5 };
    expect(derive(shape)).toEqual(derive(shape));
  });
});

describe("overrides", () => {
  const base = derive({ archetype: "early_ape", mc: [72, 96, 54, 13, 3, 1, 0], hold: [175, 45, 11, 1, 2, 0, 5], p25: 19.5, p75: 483, preGrad: 0.76 });

  it("applies bounded edits and marks provenance", () => {
    const o = validateOverrides({ exit: { stopLossPct: -15 }, risk: { maxTradesPerHour: 4.4 } });
    const s = applyOverrides(base, o);
    expect(s.exit.stopLossPct).toBe(-15);
    expect(s.risk.maxTradesPerHour).toBe(4);
    expect(s.provenance["exit.stopLossPct"]).toMatch(/owner override/);
    expect(s.summary).toContain("−15%".replace("−", "-"));
  });

  it("rejects out-of-bounds and unknown fields", () => {
    expect(() => validateOverrides({ exit: { stopLossPct: -95 } })).toThrow(OverrideError);
    expect(() => validateOverrides({ entry: { minLiquidityUsd: 1 } } as never)).toThrow(OverrideError);
    expect(() => validateOverrides({ sizing: { baseFraction: 0.3, maxFraction: 0.1 } })).toThrow(OverrideError);
  });
});
