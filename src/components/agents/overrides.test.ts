import { describe, expect, it } from "vitest";
import type { StrategySpec } from "@/server/agents/types";
import { fmtSignedPct, fmtSignedSol } from "./lib";
import { buildOverrides, OVERRIDE_FIELDS, readOverridePath, toDisplay } from "./overrides";

const spec = {
  sizing: { baseFraction: 0.07, maxFraction: 0.15, style: "fixed", maxPositionLamports: 500_000_000, maxOpenPositions: 3, minTradeLamports: 10_000_000 },
  exit: { timeStopSec: 1800, stopLossPct: -35, ladder: [], initialsOutPct: null, trailingStopPct: null },
  risk: { dailyLossLimitLamports: 1_000_000_000, maxTradesPerHour: 12, slippageBps: 1500, priorityFeeLamports: 100_000 },
} as unknown as StrategySpec;

const displayed = () => Object.fromEntries(OVERRIDE_FIELDS.map((f) => [f.path, toDisplay(readOverridePath(spec, f.path), f.scale)]));

describe("strategy overrides", () => {
  it("shows stored values in display units without float noise", () => {
    const d = displayed();
    expect(d["sizing.baseFraction"]).toBe("7");
    expect(d["sizing.maxPositionLamports"]).toBe("0.5");
    expect(d["exit.timeStopSec"]).toBe("30");
    expect(d["risk.slippageBps"]).toBe("15");
  });

  it("sends only changed fields, converted back to stored units", () => {
    const r = buildOverrides(spec, { ...displayed(), "sizing.baseFraction": "10", "exit.timeStopSec": "45", "risk.dailyLossLimitLamports": "0.25" });
    expect(r).toEqual({
      overrides: { sizing: { baseFraction: 0.1 }, exit: { timeStopSec: 2700 }, risk: { dailyLossLimitLamports: 250_000_000 } },
    });
    expect(buildOverrides(spec, displayed())).toEqual({ overrides: {} });
  });

  it("rejects out-of-bounds, empty and inconsistent values", () => {
    expect(buildOverrides(spec, { ...displayed(), "exit.stopLossPct": "-95" })).toEqual({ error: "Stop loss must be between -90 and -5 %" });
    expect(buildOverrides(spec, { ...displayed(), "risk.maxTradesPerHour": "" })).toHaveProperty("error");
    expect(buildOverrides(spec, { ...displayed(), "sizing.baseFraction": "20" })).toEqual({ error: "Base size can't exceed max size" });
  });
});

describe("signed formatting", () => {
  it("formats signs with a true minus", () => {
    expect(fmtSignedPct(12.345)).toBe("+12.3%");
    expect(fmtSignedPct(-4)).toBe("−4.0%");
    expect(fmtSignedPct(null)).toBe("—");
    expect(fmtSignedSol(-250_000_000)).toBe("−0.25 SOL");
    expect(fmtSignedSol(1_500_000_000)).toBe("+1.5 SOL");
  });
});
