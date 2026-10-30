import { describe, expect, it } from "vitest";
import { selectLive } from "./tracking";

const brain = (i: number, tracking: "live" | "standard", extra: { status?: string; seated?: boolean } = {}) => ({
  id: `b${i}`,
  tracking,
  status: extra.status ?? "unclaimed",
  seated: extra.seated ?? false,
});

describe("selectLive", () => {
  it("admits a top-ranked newcomer even when incumbents fill every slot within the hysteresis band", () => {
    // rank 0 is a newcomer; ranks 1..10 are incumbents, all inside 1.5 × max = 12.
    const ranked = [brain(0, "standard"), ...Array.from({ length: 10 }, (_, i) => brain(i + 1, "live"))];
    const live = selectLive(ranked, 8);
    expect(live.has("b0")).toBe(true);
    expect(live.size).toBe(8);
    // The lowest-ranked incumbents make room.
    expect(live.has("b10")).toBe(false);
  });

  it("keeps incumbents ranked just below the cut instead of newcomers ranked just above it", () => {
    // max 8: newcomers at ranks 4..7 (outside the top half), incumbents at 8..11 (inside 1.5 × max).
    const ranked = [
      ...Array.from({ length: 4 }, (_, i) => brain(i, "live")),
      ...Array.from({ length: 4 }, (_, i) => brain(i + 4, "standard")),
      ...Array.from({ length: 4 }, (_, i) => brain(i + 8, "live")),
    ];
    const live = selectLive(ranked, 8);
    expect([...live].sort()).toEqual(["b0", "b1", "b10", "b11", "b2", "b3", "b8", "b9"]);
  });

  it("drops incumbents that fall outside the hysteresis band", () => {
    const ranked = [...Array.from({ length: 12 }, (_, i) => brain(i, "standard")), brain(12, "live")];
    const live = selectLive(ranked, 8);
    expect(live.has("b12")).toBe(false);
    expect([...live].sort()).toEqual(["b0", "b1", "b2", "b3", "b4", "b5", "b6", "b7"]);
  });

  it("always keeps claimed and seated brains, even beyond the slot count", () => {
    const ranked = [
      ...Array.from({ length: 4 }, (_, i) => brain(i, "live")),
      brain(4, "standard", { status: "claimed" }),
      brain(5, "standard", { seated: true }),
    ];
    const live = selectLive(ranked, 2);
    expect(live.has("b4")).toBe(true);
    expect(live.has("b5")).toBe(true);
  });
});
