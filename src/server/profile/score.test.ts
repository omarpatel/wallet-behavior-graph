import { describe, expect, it } from "vitest";
import { copyability, shrinkWinRate, trackScore, WIN_RATE_PRIOR_STRENGTH } from "./score";

const BASE = 0.42;

describe("shrinkWinRate (Beta posterior, prior strength 20)", () => {
  it("3 lucky wins out of 3 don't beat 120 wins out of 200", () => {
    const lucky = shrinkWinRate(3, 3, BASE);
    const steady = shrinkWinRate(120, 200, BASE);
    expect(lucky).toBeCloseTo((3 + BASE * 20) / 23, 12);
    expect(lucky).toBeLessThan(steady);
    expect(lucky).toBeLessThan(0.5); // stays near the base rate
    expect(steady).toBeGreaterThan(0.58); // 200 samples keep ~60%
  });

  it("no sample → the base rate; a large sample → its own rate", () => {
    expect(shrinkWinRate(0, 0, BASE)).toBeCloseTo(BASE, 12);
    expect(shrinkWinRate(9000, 10_000, BASE)).toBeCloseTo(0.9, 2);
  });

  it("at n = prior strength the record and the prior weigh the same", () => {
    expect(shrinkWinRate(20, WIN_RATE_PRIOR_STRENGTH, BASE)).toBeCloseTo((1 + BASE) / 2, 12);
  });

  it("losers are pulled up toward the base too (one loss isn't a 0% wallet)", () => {
    expect(shrinkWinRate(0, 1, BASE)).toBeGreaterThan(0.39);
  });
});

describe("trackScore uses the shrunk win rate", () => {
  const rest = { deepLossShare: 0.2, profitShare: 0.6, roi: 0.1, tokens: 150, deployer: false, winRateBase: BASE };

  it("a 3/3 record scores below a 120/200 record with everything else equal", () => {
    const lucky = trackScore({ ...rest, winRateShrunk: shrinkWinRate(3, 3, BASE) })!;
    const steady = trackScore({ ...rest, winRateShrunk: shrinkWinRate(120, 200, BASE) })!;
    expect(lucky).toBeLessThan(steady);
  });

  it("performing exactly at the base rate earns half the win-rate weight", () => {
    const atBase = trackScore({ ...rest, winRateShrunk: BASE })!;
    const zero = trackScore({ ...rest, winRateShrunk: BASE - 0.2 })!;
    expect(atBase - zero).toBeCloseTo(5, 6);
  });
});

describe("copyability (fidelity gate)", () => {
  const swing = {
    medianEntryMcUsd: 2_000_000,
    profitPerPositionUsd: 800,
    medianHoldSec: 3 * 3600,
    tradesPerWeek: 20,
    archetype: "swing" as const,
    winRateShrunk: 0.55,
    winRateBase: BASE,
  };

  it("a slow, profitable selector is copyable", () => {
    expect(copyability(swing).score).toBeGreaterThanOrEqual(65);
  });

  it("a flipper can't buy its way past the gate with profit", () => {
    const flipper = copyability({ ...swing, medianHoldSec: 6, tradesPerWeek: 2000, archetype: "bot_flipper", profitPerPositionUsd: 5000 });
    expect(flipper.score).toBeLessThan(30);
    expect(flipper.reason).toMatch(/before a follower could react|beyond manual execution/);
  });

  it("the gate scales the whole score: a 20 s hold costs more than its additive weight", () => {
    const slow = copyability(swing).score!;
    const fast = copyability({ ...swing, medianHoldSec: 20 }).score!;
    expect(fast).toBeLessThan(slow * 0.5);
  });
});
