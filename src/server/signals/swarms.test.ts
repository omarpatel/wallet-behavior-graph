import { describe, expect, it } from "vitest";
import { computeSwarmOutcome } from "./outcomes";
import { safetyChips } from "./safety";
import { detectSwarms, type FirstBuy } from "./swarms";
import { swarmStage, type SwarmMemberRecord } from "./types";

let n = 0;
const fb = (brainId: string, at: number, extra: Partial<FirstBuy> = {}): FirstBuy => ({
  brainId,
  mint: "M",
  at,
  slot: at * 10,
  signature: `sig${++n}`,
  solValue: 1,
  mcUsd: 10_000 + at,
  ...extra,
});

describe("detectSwarms", () => {
  it("needs 3 distinct brains within 10 min of the first", () => {
    expect(detectSwarms([fb("a", 0), fb("b", 300)])).toHaveLength(0);
    expect(detectSwarms([fb("a", 0), fb("b", 300), fb("c", 601)])).toHaveLength(0);
    const [s] = detectSwarms([fb("a", 0), fb("b", 300), fb("c", 600)]);
    expect(s.members.map((m) => m.brainId)).toEqual(["a", "b", "c"]);
    expect(s).toMatchObject({ startedAt: 0, lastJoinAt: 600, publishAt: 600, mcAtStartUsd: 10_000 });
  });

  it("starts at the first entry whose window qualifies (same as live growth would)", () => {
    // 0 and 540 alone don't make a window with 3; 540, 900, 1080 do
    const [s] = detectSwarms([fb("a", 0), fb("b", 540), fb("c", 900), fb("d", 1080)]);
    expect(s.startedAt).toBe(540);
    expect(s.members.map((m) => m.brainId)).toEqual(["b", "c", "d"]);
  });

  it("a later wave on the same token is its own swarm; one brain counts once", () => {
    const list = [fb("a", 0), fb("b", 10), fb("c", 20), fb("a", 30), fb("d", 5000), fb("e", 5100), fb("f", 5200)];
    const swarms = detectSwarms(list);
    expect(swarms.map((s) => [s.startedAt, s.members.length])).toEqual([
      [0, 3],
      [5000, 3],
    ]);
  });

  it("same-slot entries are members (bundles are marked downstream, not dropped)", () => {
    const [s] = detectSwarms([fb("a", 5, { slot: 7 }), fb("b", 5, { slot: 7 }), fb("c", 6, { slot: 8 })]);
    expect(s.members).toHaveLength(3);
    expect(new Set(s.members.map((m) => m.slot)).size).toBe(2);
  });

  it("stages follow the swarm thresholds", () => {
    expect([3, 4, 5, 9, 10].map(swarmStage)).toEqual(["forming", "forming", "swarm", "swarm", "large"]);
  });
});

describe("computeSwarmOutcome", () => {
  const members: SwarmMemberRecord[] = [
    { brainId: "a", at: 100, slot: 1, signature: "s1", solValue: 1, mcUsd: 10_000 },
    { brainId: "b", at: 160, slot: 2, signature: "s2", solValue: 1, mcUsd: 20_000 },
    { brainId: "c", at: 200, slot: 3, signature: "s3", solValue: 1, mcUsd: 40_000 },
  ];
  const row = {
    id: 1,
    mint: "M",
    startedAt: 100,
    lastJoinAt: 200,
    members: 3,
    membersJson: JSON.stringify(members),
    mcAtStartUsd: 10_000,
    publishAt: 200,
    createdAt: 0,
  };

  it("peak within 24 h vs start and vs detection; later trades ignored", () => {
    const o = computeSwarmOutcome(
      row,
      [
        { at: 100, mcUsd: 10_000 },
        { at: 150, mcUsd: 90_000 }, // before detection: not catchable by a follower
        { at: 300, mcUsd: 60_000 },
        { at: 100 + 86_401, mcUsd: 5_000_000 }, // outside the window
      ],
      200_000,
    );
    expect(o).toMatchObject({
      mcAtStartUsd: 10_000,
      peakMcUsd: 90_000,
      peakAt: 150,
      multiple: 9,
      mcAtPublishUsd: 40_000,
      peakAfterPublishMcUsd: 60_000,
      multipleFromPublish: 1.5,
      windowComplete: true,
      observedTrades: 3,
    });
  });

  it("open window and no observations are reported as such", () => {
    const o = computeSwarmOutcome(row, [], 1000);
    expect(o).toMatchObject({ peakMcUsd: null, multiple: null, windowComplete: false, observedTrades: 0 });
  });
});

describe("safetyChips", () => {
  const base = {
    liquidityUsd: 120_000,
    topHoldersPct: 18,
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: false,
    organicScore: null,
    warnings: [],
  };
  it("risk ≤30 good, ≤60 warn, else bad; LP ≥80 good, ≥1 warn, 0 bad", () => {
    const tones = (s: Parameters<typeof safetyChips>[0]) => safetyChips(s).map((c) => `${c.label}:${c.tone}`);
    expect(tones({ ...base, rugScore: 30, lpLockedPct: 80 })).toEqual([
      "risk 30/100:good",
      "mint revoked:good",
      "freeze live:bad",
      "LP 80% locked:good",
      "top holders 18%:good",
      "liquidity $120K:good",
    ]);
    expect(safetyChips({ ...base, rugScore: 61, lpLockedPct: 0 }).slice(0, 4).map((c) => c.tone)).toEqual(["bad", "good", "bad", "bad"]);
    expect(safetyChips({ ...base, rugScore: 45, lpLockedPct: 5 })[0].tone).toBe("warn");
  });
  it("no LP chip on a bonding curve; stored alerts without RugCheck fields still render", () => {
    expect(safetyChips({ ...base, lpLockedPct: 0 }, { onCurve: true }).some((c) => c.label.startsWith("LP"))).toBe(false);
    expect(safetyChips(base).map((c) => c.label)).not.toContain("risk");
  });
});
