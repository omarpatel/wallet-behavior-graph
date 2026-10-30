import { describe, expect, it } from "vitest";
import { classifyArchetype, type ArchetypeStats } from "./archetypes";
import { computeProfile } from "./compute";
import { bucketize, replayPosition, type ProfileToken, type ProfileTrade } from "./metrics";
import { tierFor, trackScore } from "./score";

const NOW = 1_800_000_000;
let slot = 1;

function tr(p: Partial<ProfileTrade> & Pick<ProfileTrade, "side" | "mint" | "tokenAmount" | "usdValue">): ProfileTrade {
  slot++;
  return {
    signature: `sig${slot}`,
    slot,
    txIndex: 0,
    blockTime: NOW - 86_400 + slot,
    solValue: p.usdValue != null ? p.usdValue / 100 : null,
    feesSol: 0,
    solUsd: 100,
    mcUsd: null,
    venue: "pump_curve",
    launchpad: "pump.fun",
    entryDelaySec: null,
    ...p,
  };
}

describe("replayPosition (average cost)", () => {
  it("partial sells realize against average cost and leave an open position", () => {
    const p = replayPosition([
      tr({ side: "buy", mint: "A", tokenAmount: 100, usdValue: 100 }),
      tr({ side: "buy", mint: "A", tokenAmount: 100, usdValue: 300 }), // avg 2.0
      tr({ side: "sell", mint: "A", tokenAmount: 50, usdValue: 150 }), // 3.0 per token
    ])!;
    expect(p.realizedUsd).toBeCloseTo(50, 9); // 150 − 50×2
    expect(p.qty).toBe(150);
    expect(p.openCostUsd).toBeCloseTo(300, 9);
    expect(p.closed).toBe(false);
    expect(p.sellFills[0].roi).toBeCloseTo(0.5, 9);
  });

  it("oversell (tokens without basis) only realizes the matched quantity", () => {
    const p = replayPosition([
      tr({ side: "buy", mint: "A", tokenAmount: 100, usdValue: 100 }),
      tr({ side: "sell", mint: "A", tokenAmount: 300, usdValue: 600 }), // 2.0/token, only 100 matched
    ])!;
    expect(p.realizedUsd).toBeCloseTo(100, 9); // 200 proceeds for 100 tokens − 100 cost
    expect(p.qty).toBe(0);
    expect(p.closed).toBe(true);
  });

  it("sell-only history (no basis) yields no position", () => {
    expect(replayPosition([tr({ side: "sell", mint: "A", tokenAmount: 10, usdValue: 10 })])).toBeNull();
  });

  it("fees are part of cost and reduce proceeds", () => {
    const p = replayPosition([
      tr({ side: "buy", mint: "A", tokenAmount: 100, usdValue: 100, feesSol: 0.01 }), // +$1
      tr({ side: "sell", mint: "A", tokenAmount: 100, usdValue: 200, feesSol: 0.01 }), // −$1
    ])!;
    expect(p.realizedUsd).toBeCloseTo(98, 9);
  });

  it("unvalued trades carry no basis and are skipped", () => {
    const p = replayPosition([
      tr({ side: "buy", mint: "A", tokenAmount: 100, usdValue: null }),
      tr({ side: "buy", mint: "A", tokenAmount: 100, usdValue: 50 }),
      tr({ side: "sell", mint: "A", tokenAmount: 200, usdValue: 100 }),
    ])!;
    expect(p.buys).toBe(1);
    expect(p.realizedUsd).toBeCloseTo(0, 9); // 100 matched tokens: 50 proceeds − 50 cost
  });
});

describe("bucket boundaries", () => {
  const labels = ["<$10k", "$10–30k", "$30–100k", "$100k–1M", "$1–10M", "$10–100M", "≥$100M"];
  const edges = [1e4, 3e4, 1e5, 1e6, 1e7, 1e8];
  it("lower edge is inclusive for the next bucket", () => {
    const b = bucketize([9_999, 10_000, 29_999, 30_000, 99_999.99, 100_000, 1e8, 5e9], labels, edges);
    expect(b.map((x) => x.count)).toEqual([1, 2, 2, 1, 0, 0, 2]);
  });

  it("entry-delay buckets in profile order", () => {
    const mk = (mint: string, delay: number) => [
      tr({ side: "buy", mint, tokenAmount: 1, usdValue: 10, entryDelaySec: delay }),
      tr({ side: "sell", mint, tokenAmount: 1, usdValue: 12 }),
    ];
    const trades = [mk("a", 0), mk("b", 10), mk("c", 11), mk("d", 59), mk("e", 60), mk("f", 3599), mk("g", 86_400)].flat();
    const p = computeProfile(trades, [], NOW);
    expect(p.timing.buckets).toEqual([
      { label: "same block", count: 1 },
      { label: "≤10s", count: 1 },
      { label: "<1m", count: 2 },
      { label: "1–5m", count: 1 },
      { label: "5–60m", count: 1 },
      { label: "1–24h", count: 0 },
      { label: ">24h", count: 1 },
    ]);
    expect(p.pnl.buckets.map((b) => b.label)).toEqual([">5x", "2–5x", "0–2x", "−50–0%", "< −50%"]);
    expect(p.pnl.buckets[2].count).toBe(7); // +20% each
  });
});

const baseStats: ArchetypeStats = {
  rated: true,
  trades: 200,
  tokens: 40,
  tradesPerDay: 5,
  trades7d: 50,
  devTokenShare: 0,
  flashFlipShare: 0,
  launchBlockEntryShare: 0,
  launchBlockDistinctDevs: 0,
  medianHoldSec: 3600,
  medianEntryMcUsd: 50_000,
  medianEntryDelaySec: 600,
  preGraduationShare: 0.8,
  postGraduationShare: 0.2,
  openAfter30dShare: 0,
  avgBuysPerToken: 1,
  avgSellsPerToken: 1,
};

describe("archetype precedence (first match wins)", () => {
  it("thin sample is unrated before anything else", () => {
    expect(classifyArchetype({ ...baseStats, rated: false, devTokenShare: 1 }).id).toBe("unrated");
  });
  it("deployer beats bot", () => {
    expect(classifyArchetype({ ...baseStats, devTokenShare: 0.6, tradesPerDay: 500 }).id).toBe("deployer");
  });
  it("bot beats sniper", () => {
    expect(
      classifyArchetype({ ...baseStats, flashFlipShare: 0.3, launchBlockEntryShare: 0.9, launchBlockDistinctDevs: 20, medianHoldSec: 30 }).id,
    ).toBe("bot_flipper");
  });
  it("sniper needs ≥10 distinct deployers and a short hold", () => {
    expect(classifyArchetype({ ...baseStats, launchBlockEntryShare: 0.6, launchBlockDistinctDevs: 12, medianHoldSec: 120 }).id).toBe("sniper");
    expect(classifyArchetype({ ...baseStats, launchBlockEntryShare: 0.6, launchBlockDistinctDevs: 9, medianHoldSec: 120 }).id).toBe("early_ape");
  });
  it("early ape beats intraday when curve entries dominate", () => {
    expect(classifyArchetype(baseStats).id).toBe("early_ape");
    expect(classifyArchetype({ ...baseStats, preGraduationShare: 0.5 }).id).toBe("intraday");
  });
  it("momentum chaser: graduated entries, $100k–$20M, 5 min–24 h hold", () => {
    expect(classifyArchetype({ ...baseStats, medianEntryMcUsd: 2e6, preGraduationShare: 0.1, postGraduationShare: 0.9 }).id).toBe("momentum_chaser");
  });
  it("swing vs diamond hands by hold time", () => {
    const big = { ...baseStats, medianEntryMcUsd: 5e7, preGraduationShare: 0, postGraduationShare: 1 };
    expect(classifyArchetype({ ...big, medianHoldSec: 3 * 86_400, tradesPerDay: 2 }).id).toBe("swing");
    expect(classifyArchetype({ ...big, medianHoldSec: 10 * 86_400, tradesPerDay: 0.5 }).id).toBe("diamond_hands");
  });
});

describe("score + tier", () => {
  it("weights add up to 100 for a perfect record and deployer is ×0.45", () => {
    const perfect = { deepLossShare: 0, profitShare: 1, roi: 0.5, winRateShrunk: 0.7, winRateBase: 0.45, tokens: 400, deployer: false };
    expect(trackScore(perfect)).toBe(100);
    expect(trackScore({ ...perfect, deployer: true })).toBe(45);
    expect(tierFor(80, true)).toBe("S");
    expect(tierFor(79.9, true)).toBe("A");
    expect(tierFor(50, true)).toBe("B");
    expect(tierFor(10, true)).toBe("C");
    expect(tierFor(95, false)).toBe("unrated");
  });

  it("computeProfile end to end: rated sample gets archetype, PnL and tier", () => {
    const trades: ProfileTrade[] = [];
    const tokens: ProfileToken[] = [];
    for (let i = 0; i < 12; i++) {
      const mint = `M${i}`;
      tokens.push({ mint, symbol: `T${i}`, icon: null, launchpad: "pump.fun", dev: null, liquidityUsd: 20_000 });
      trades.push(tr({ side: "buy", mint, tokenAmount: 1000, usdValue: 100, mcUsd: 40_000, entryDelaySec: 120 }));
      trades.push(tr({ side: "sell", mint, tokenAmount: 1000, usdValue: i % 4 === 0 ? 40 : 160, blockTime: NOW - 86_400 + 2000 + i * 900 }));
    }
    const p = computeProfile(trades, tokens, NOW, { wallet: "W" });
    expect(p.rated).toBe(true);
    expect(p.sample).toMatchObject({ trades: 24, buys: 12, sells: 12, tokens: 12 });
    expect(p.pnl.closedPositions).toBe(12);
    expect(p.pnl.winRate).toBeCloseTo(9 / 12, 9);
    expect(p.pnl.realizedUsd).toBeCloseTo(9 * 60 - 3 * 60, 6);
    expect(p.entryMc.medianUsd).toBe(40_000);
    expect(p.archetype.id).toBe("early_ape");
    expect(p.tier).not.toBe("unrated");
    expect(p.topWins).toHaveLength(5);
    expect(p.topLosses).toHaveLength(3);
    expect(p.promoteThenSell).toBeNull();
  });

  it("dust buys (< 0.01 SOL) don't define the wallet's usual buy size", () => {
    const trades: ProfileTrade[] = [];
    // 3 real 1-SOL buys, 9 micro-buys of 0.0016 SOL on the same mint
    for (let i = 0; i < 3; i++) trades.push(tr({ side: "buy", mint: `R${i}`, tokenAmount: 1000, usdValue: 100, solValue: 1 }));
    for (let i = 0; i < 9; i++) trades.push(tr({ side: "buy", mint: "D", tokenAmount: 1, usdValue: 0.16, solValue: 0.0016 }));
    const p = computeProfile(trades, [], NOW);
    expect(p.sizing.medianBuySol).toBe(1);
    expect(p.sizing.medianBuyUsd).toBe(100);
  });
});
