import { describe, expect, it } from "vitest";
import type { Candle } from "./prices";
import {
  baselineAnchors,
  candleSeries,
  classifySDE,
  computeLift,
  entryMcBucket,
  matchAnchor,
  mentionFeatures,
  positionAt,
  promoteThenSellLabel,
  type Fill,
  type PriceSeries,
} from "./shill";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 8, 1, 12); // first buy
const TWEET = T0 + 10 * HOUR;

const buy = (tMs: number, qty: number, priceUsd: number, sig = `b${tMs}`): Fill => ({
  tMs,
  kind: "buy",
  qty,
  usd: qty * priceUsd,
  mcUsd: priceUsd * 1e9,
  signature: sig,
});
const sell = (tMs: number, qty: number, sig = `s${tMs}`): Fill => ({ tMs, kind: "sell", qty, usd: null, mcUsd: null, signature: sig });

/** Flat price p0 before the tweet, then a spike to p1 within the next hour. */
const series = (p0: number, p1 = p0): PriceSeries => ({
  priceAt: (t) => (t <= TWEET ? p0 : p1),
  maxIn: () => Math.max(p0, p1),
});

describe("promote-then-sell SDE rule (§2.4 step 4)", () => {
  const fills = [buy(T0, 1_000_000, 0.001), sell(TWEET + 30 * MIN, 600_000), sell(TWEET + 2 * HOUR, 300_000)];

  it("flags a bullish call on a pre-position bought cheaper and mostly sold within 24h", () => {
    const f = mentionFeatures({ tMs: TWEET, text: "this is going higher" }, fills, series(0.003, 0.004))!;
    expect(f.prePosUsd).toBeCloseTo(3000);
    expect(f.leadTimeSec).toBe(10 * 3600);
    expect(f.entryDiscount).toBeCloseTo(3);
    expect(f.soldFrac.m15).toBe(0);
    expect(f.soldFrac.h1).toBeCloseTo(0.6);
    expect(f.soldFrac.h24).toBeCloseTo(0.9);
    expect(f.firstSellAfterSec).toBe(30 * 60);
    expect(f.pump1h).toBeCloseTo(1 / 3);
    expect(f.sellsAfter.map((s) => s.signature)).toEqual([fills[1].signature, fills[2].signature]);
    expect(classifySDE(true, f)).toEqual({ sde: true, strong: false, strongReasons: [] });
  });

  it("is strong when ≥80% is sold within 1h, the first sell is within 15 min, or the post contradicts the selling", () => {
    const fast = [buy(T0, 1_000_000, 0.001), sell(TWEET + 10 * MIN, 900_000)];
    const r1 = classifySDE(true, mentionFeatures({ tMs: TWEET, text: "" }, fast, series(0.003))!);
    expect(r1.strong).toBe(true);
    expect(r1.strongReasons).toEqual(["sold ≥80% within 1h", "first sell within 15 min"]);

    const half = [buy(T0, 1_000_000, 0.001), sell(TWEET + 40 * MIN, 500_000)];
    const r2 = classifySDE(true, mentionFeatures({ tMs: TWEET, text: "Still holding every bag" }, half, series(0.003))!);
    expect(r2).toEqual({ sde: true, strong: true, strongReasons: ["post said holding while ≥50% was sold within 1h"] });
  });

  it("requires every condition", () => {
    const f = (fs: Fill[], price = 0.003, tMs = TWEET) => mentionFeatures({ tMs, text: "" }, fs, series(price))!;
    expect(classifySDE(false, f(fills)).sde).toBe(false); // not a bullish call
    expect(classifySDE(true, f(fills, 0.0012)).sde).toBe(false); // entry discount 1.2 < 1.5
    expect(classifySDE(true, f([buy(T0, 100_000, 0.001), sell(TWEET + HOUR, 90_000)])).sde).toBe(false); // $300 pre-position
    const early = [buy(TWEET - 73 * HOUR, 1_000_000, 0.001), sell(TWEET + HOUR, 900_000)];
    expect(classifySDE(true, f(early)).sde).toBe(false); // lead 73h > 72h
    const little = [buy(T0, 1_000_000, 0.001), sell(TWEET + HOUR, 400_000), sell(TWEET + 25 * HOUR, 600_000)];
    expect(classifySDE(true, f(little)).sde).toBe(false); // 40% within 24h
    expect(mentionFeatures({ tMs: TWEET, text: "" }, [sell(T0, 1)], series(0.003))).toBeNull(); // no position
  });

  it("measures a reopened position from its own first buy and nets transfers out", () => {
    const fs: Fill[] = [
      buy(T0 - 100 * HOUR, 1_000_000, 0.0001),
      sell(T0 - 90 * HOUR, 1_000_000),
      buy(T0, 2_000_000, 0.001),
      { tMs: T0 + HOUR, kind: "out", qty: 1_000_000, usd: null, mcUsd: null, signature: "t1" },
      sell(TWEET + 5 * MIN, 1_000_000),
    ];
    const pos = positionAt(fs, TWEET);
    expect(pos.qty).toBe(1_000_000);
    expect(pos.firstBuyMs).toBe(T0);
    expect(pos.avgEntryPriceUsd).toBeCloseTo(0.001);
    const f = mentionFeatures({ tMs: TWEET, text: "" }, fs, series(0.002))!;
    expect(f.leadTimeSec).toBe(10 * 3600);
    expect(f.soldFrac.m5).toBe(1);
    expect(classifySDE(true, f)).toMatchObject({ sde: true, strong: true });
  });
});

describe("baseline lift (§2.4 step 5)", () => {
  it("compares the tweeted 1h sell-through rate with matched un-tweeted spikes", () => {
    // tweeted: 4 of 5 sold ≥ 50% in 1h → 0.8; baseline 1 of 4 → 0.25
    expect(computeLift([0.9, 0.8, 0.6, 0.1, 0.7], [0.6, 0.1, 0.2, 0])).toBeCloseTo(3.2);
  });

  it("needs ≥ 5 tweeted pre-positioned mentions and a non-empty baseline", () => {
    expect(computeLift([1, 1, 1, 1], [0, 0])).toBeNull();
    expect(computeLift([1, 1, 1, 1, 1], [])).toBeNull();
  });

  it("uses a 0.5 continuity correction when the baseline never sold", () => {
    expect(computeLift([1, 1, 1, 1, 1], [0, 0, 0])).toBeCloseTo(1 / (0.5 / 4));
  });

  it("matches un-tweeted positions at the first moment with a spike at least as large", () => {
    const start = Math.floor(T0 / 300_000) * 300_000;
    const candles: Candle[] = [];
    for (let i = 0; i < 48; i++) {
      const t = start / 1000 + i * 300;
      const p = i < 24 ? 0.002 : 0.004; // doubles 2h in
      candles.push({ t, o: p, h: p, l: p, c: p, v: 1000 });
    }
    const fills = [buy(start, 1_000_000, 0.001), sell(start + 2 * HOUR + 20 * MIN, 700_000)];
    const anchors = baselineAnchors(fills, candleSeries(candles), start, start + 4 * HOUR);
    expect(anchors[0]).toEqual({ tMs: start, pump1h: 0, soldFrac1h: 0 });
    const spike = matchAnchor(anchors, 0.5)!;
    // first anchor whose next hour contains the jump: 1h before it (12 candles = 60 min, inclusive window)
    expect(spike.tMs).toBe(start + HOUR + 5 * MIN);
    expect(spike.pump1h).toBeCloseTo(1);
    expect(spike.soldFrac1h).toBe(0);
    expect(matchAnchor(anchors, 1.5)).toBeNull();
    const late = matchAnchor(anchors.filter((a) => a.tMs >= start + 1.5 * HOUR), 0.5)!;
    expect(late.soldFrac1h).toBeCloseTo(0.7);
  });

  it("buckets entry market caps like the profile", () => {
    expect([5e3, 10e3, 50e3, 500e3, 5e6, 50e6, 5e8, null].map(entryMcBucket)).toEqual([0, 1, 2, 3, 4, 5, 6, -1]);
  });
});

describe("wallet label (§2.4 step 6)", () => {
  const base = { bullishMentions: 12, events: 4, strongEvents: 2, rate: 0.5, lift: 2.4 };
  it("needs ≥ 3 events, rate ≥ 40% and lift ≥ 2", () => {
    expect(promoteThenSellLabel(base)?.reason).toBe(
      "4 of 8 pre-positioned bullish posts were followed by selling ≥50% within 24h (50%); 2.4× the wallet's selling rate after comparable un-posted price spikes",
    );
    expect(promoteThenSellLabel({ ...base, events: 2, rate: 0.5 })).toBeNull();
    expect(promoteThenSellLabel({ ...base, rate: 0.39 })).toBeNull();
    expect(promoteThenSellLabel({ ...base, lift: 1.9 })).toBeNull();
    expect(promoteThenSellLabel({ ...base, lift: null })).toBeNull();
    expect(promoteThenSellLabel(null)).toBeNull();
  });
});
