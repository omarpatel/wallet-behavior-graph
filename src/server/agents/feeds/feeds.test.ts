import { describe, expect, it } from "vitest";
import { curvePriceSol, curveProgress, decodeBondingCurve, graduationLamports } from "./curve";
import { RollingWindow } from "./window";

function curveBytes(vTok: bigint, vSol: bigint, rTok: bigint, rSol: bigint, supply: bigint, complete: boolean, len = 151): Uint8Array {
  const buf = new Uint8Array(len);
  const v = new DataView(buf.buffer);
  v.setBigUint64(8, vTok, true);
  v.setBigUint64(16, vSol, true);
  v.setBigUint64(24, rTok, true);
  v.setBigUint64(32, rSol, true);
  v.setBigUint64(40, supply, true);
  buf[48] = complete ? 1 : 0;
  return buf;
}

describe("bonding curve", () => {
  it("matches the observed mainnet graduation threshold", () => {
    expect(graduationLamports()).toBe(85_005_359_056n);
  });

  it("decodes a fresh curve: 30 SOL / 1.073e9 tokens → ~2.8e-8 SOL per token, MC ≈ 27.96 SOL", () => {
    const c = decodeBondingCurve(curveBytes(1_073_000_000_000_000n, 30_000_000_000n, 793_100_000_000_000n, 0n, 1_000_000_000_000_000n, false))!;
    const p = curvePriceSol(c)!;
    expect(p * 1e9).toBeCloseTo(27.958993, 5); // PumpPortal create event: marketCapSol 27.958993476234856
    expect(curveProgress(c)).toBe(0);
    expect(c.complete).toBe(false);
  });

  it("handles the 115-byte layout and rejects short data", () => {
    expect(decodeBondingCurve(curveBytes(1n, 1n, 1n, 1n, 1n, true, 115))?.complete).toBe(true);
    expect(decodeBondingCurve(new Uint8Array(40))).toBeNull();
  });
});

describe("RollingWindow (unknown is not zero)", () => {
  it("returns null until the history covers the window", () => {
    const w = new RollingWindow();
    w.push({ t: 100, priceUsd: 1, reserveLamports: 0 });
    expect(w.changePct(60)).toBeNull();
    w.push({ t: 130, priceUsd: 1.1, reserveLamports: 1e9 });
    expect(w.changePct(60)).toBeNull(); // 30 s of 60 s
    expect(w.netInflowLamports(60)).toBeNull();
    w.push({ t: 150, priceUsd: 1.2, reserveLamports: 2e9 });
    expect(w.changePct(60)).toBeCloseTo(20, 6); // oldest sample covers ≥ 80% of the window
    expect(w.netInflowLamports(60)).toBe(2e9);
  });

  it("measures from the latest sample at or before the window start", () => {
    const w = new RollingWindow();
    for (let t = 0; t <= 300; t += 10) w.push({ t, priceUsd: 1 + t / 100, reserveLamports: null });
    expect(w.changePct(100)).toBeCloseTo((4 / 3 - 1) * 100, 6);
    expect(w.netInflowLamports(100)).toBeNull(); // pools have no reserves → unknown
  });

  it("tracks idleness and peaks", () => {
    const w = new RollingWindow();
    w.push({ t: 0, priceUsd: 1, reserveLamports: 5 });
    w.push({ t: 10, priceUsd: 2, reserveLamports: 6 });
    w.push({ t: 20, priceUsd: 1.5, reserveLamports: 6 });
    expect(w.idleSec(50)).toBe(40);
    expect(w.peakSince(5)).toBe(2);
  });
});
