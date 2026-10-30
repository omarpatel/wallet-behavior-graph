/**
 * "Promote-then-sell" detection for claimed, X-linked brains
 *.
 *
 * Step 3 features per bullish mention, step 4 Shill-Dump Event (SDE) rule, step 5 baseline lift vs
 * un-tweeted positions after a matched price spike, step 6 wallet-level label thresholds.
 * Pure functions are exported for tests; detectPromoteThenSell() wires them to the DB and prices.
 */
import { and, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { brains, shillEvents, tokenTransfers, trades, tweets } from "@/db/schema";
import type { BrainProfile, Labelled } from "@/server/profile/types";
import type { TweetMention } from "./mentions";
import { CANDLE_SEC, fetchCandles, type Candle } from "./prices";

const MIN = 60_000;
const HOUR = 60 * MIN;
export const WINDOWS_MS = { m5: 5 * MIN, m15: 15 * MIN, h1: HOUR, h6: 6 * HOUR, h24: 24 * HOUR } as const;

export const SDE_RULE = {
  minPrePosUsd: 500,
  maxLeadSec: 72 * 3600,
  minEntryDiscount: 1.5,
  minSoldFrac24h: 0.5,
  strongSoldFrac1h: 0.8,
  strongFirstSellSec: 15 * 60,
} as const;
export const LIFT_RULE = { soldFrac1h: 0.5, minTweeted: 5 } as const;
export const LABEL_RULE = { minEvents: 3, minRate: 0.4, minLift: 2 } as const;

const WINDOW_DAYS = 90;
/** A position is closed once its balance falls to ≤ 1% of its peak (§2.1). */
const CLOSED_FRACTION = 0.01;
const BASELINE_MAX_POSITIONS = 40;
const CONTRADICTION_RE = /\b(holding|still holding|not selling|never selling|won'?t sell|not sold|haven'?t sold|diamond hand(?:s|ing)?|hodl(?:ing)?|still in)\b/i;

export interface Fill {
  tMs: number;
  kind: "buy" | "sell" | "in" | "out";
  qty: number;
  usd: number | null;
  mcUsd: number | null;
  signature: string;
}

export interface PriceSeries {
  /** USD price at tMs (null when no market data around it). */
  priceAt(tMs: number): number | null;
  /** Highest USD price traded in (fromMs, toMs]. */
  maxIn(fromMs: number, toMs: number): number | null;
}

/** Price series over 5-minute candles: price = open of the candle containing t, else last close within 6h. */
export function candleSeries(candles: Candle[]): PriceSeries {
  const sorted = [...candles].sort((a, b) => a.t - b.t);
  return {
    priceAt(tMs) {
      const t = tMs / 1000;
      let best: Candle | null = null;
      for (const c of sorted) {
        if (c.t > t) break;
        best = c;
      }
      if (!best) return null;
      if (t < best.t + CANDLE_SEC) return best.o;
      return t - (best.t + CANDLE_SEC) <= 6 * 3600 ? best.c : null;
    },
    maxIn(fromMs, toMs) {
      let max: number | null = null;
      for (const c of sorted) {
        if (c.t + CANDLE_SEC <= fromMs / 1000 || c.t >= toMs / 1000) continue;
        if (max == null || c.h > max) max = c.h;
      }
      return max;
    },
  };
}

/** Open position at tMs (fills strictly up to and including tMs), reset whenever it was closed. */
export function positionAt(fills: Fill[], tMs: number) {
  let qty = 0;
  let peak = 0;
  let cost = 0;
  let costQty = 0;
  let mcCost = 0;
  let mcUsd = 0;
  let firstBuyMs: number | null = null;
  let buys: Fill[] = [];
  for (const f of fills) {
    if (f.tMs > tMs) break;
    if (f.kind === "buy" || f.kind === "in") {
      if (qty <= peak * CLOSED_FRACTION) {
        peak = 0;
        cost = costQty = mcCost = mcUsd = 0;
        firstBuyMs = null;
        buys = [];
      }
      qty += f.qty;
      peak = Math.max(peak, qty);
      if (f.kind === "buy") {
        firstBuyMs ??= f.tMs;
        buys.push(f);
        if (f.usd != null) {
          cost += f.usd;
          costQty += f.qty;
          if (f.mcUsd != null) {
            mcCost += f.usd;
            mcUsd += f.usd * f.mcUsd;
          }
        }
      }
    } else {
      qty = Math.max(0, qty - f.qty);
    }
  }
  const open = qty > peak * CLOSED_FRACTION && qty > 0;
  return {
    qty: open ? qty : 0,
    firstBuyMs: open ? firstBuyMs : null,
    avgEntryPriceUsd: open && costQty > 0 ? cost / costQty : null,
    /** Cost-weighted market cap at entry. */
    entryMcUsd: open && mcCost > 0 ? mcUsd / mcCost : null,
    buys: open ? buys : [],
  };
}

export interface MentionFeatures {
  prePosTokens: number;
  prePosUsd: number;
  priceAtTweetUsd: number;
  avgEntryPriceUsd: number | null;
  entryMcUsd: number | null;
  leadTimeSec: number | null;
  /** MC(t_tweet) / MC(avg entry) = price ratio (same supply). */
  entryDiscount: number | null;
  soldFrac: Record<keyof typeof WINDOWS_MS, number>;
  firstSellAfterSec: number | null;
  pump1h: number | null;
  contradiction: boolean;
  entryBuys: Fill[];
  sellsAfter: Fill[];
}

/** Step 3 features for one mention at tMs. Null when the wallet held nothing or no price exists. */
export function mentionFeatures(input: { tMs: number; text: string }, fills: Fill[], series: PriceSeries): MentionFeatures | null {
  const { tMs } = input;
  const pos = positionAt(fills, tMs);
  if (pos.qty <= 0) return null;
  const price = series.priceAt(tMs);
  if (price == null || price <= 0) return null;

  const after = fills.filter((f) => f.kind === "sell" && f.tMs > tMs);
  const soldWithin = (ms: number) =>
    Math.min(1, after.filter((f) => f.tMs <= tMs + ms).reduce((s, f) => s + f.qty, 0) / pos.qty);
  const soldFrac = Object.fromEntries(
    Object.entries(WINDOWS_MS).map(([k, ms]) => [k, soldWithin(ms)]),
  ) as Record<keyof typeof WINDOWS_MS, number>;
  const peak = series.maxIn(tMs, tMs + HOUR);

  return {
    prePosTokens: pos.qty,
    prePosUsd: pos.qty * price,
    priceAtTweetUsd: price,
    avgEntryPriceUsd: pos.avgEntryPriceUsd,
    entryMcUsd: pos.entryMcUsd,
    leadTimeSec: pos.firstBuyMs == null ? null : (tMs - pos.firstBuyMs) / 1000,
    entryDiscount: pos.avgEntryPriceUsd ? price / pos.avgEntryPriceUsd : null,
    soldFrac,
    firstSellAfterSec: after.length ? (after[0].tMs - tMs) / 1000 : null,
    pump1h: peak == null ? null : peak / price - 1,
    contradiction: CONTRADICTION_RE.test(input.text) && soldFrac.h1 >= 0.5,
    entryBuys: pos.buys,
    sellsAfter: after.filter((f) => f.tMs <= tMs + WINDOWS_MS.h24),
  };
}

export interface SDEResult {
  sde: boolean;
  strong: boolean;
  strongReasons: string[];
}

/** Step 4: SDE requires a bullish call, ≥ $500 pre-position, lead ≤ 72h, entry discount ≥ 1.5, ≥ 50% sold within 24h. */
export function classifySDE(bullish: boolean, f: MentionFeatures): SDEResult {
  const sde =
    bullish &&
    f.prePosUsd >= SDE_RULE.minPrePosUsd &&
    f.leadTimeSec != null &&
    f.leadTimeSec <= SDE_RULE.maxLeadSec &&
    f.entryDiscount != null &&
    f.entryDiscount >= SDE_RULE.minEntryDiscount &&
    f.soldFrac.h24 >= SDE_RULE.minSoldFrac24h;
  if (!sde) return { sde: false, strong: false, strongReasons: [] };
  const strongReasons = [
    f.soldFrac.h1 >= SDE_RULE.strongSoldFrac1h ? "sold ≥80% within 1h" : "",
    f.firstSellAfterSec != null && f.firstSellAfterSec <= SDE_RULE.strongFirstSellSec ? "first sell within 15 min" : "",
    f.contradiction ? "post said holding while ≥50% was sold within 1h" : "",
  ].filter(Boolean);
  return { sde, strong: strongReasons.length > 0, strongReasons };
}

/** Entry-MC buckets used for matching (same edges as the profile): <$10k … ≥$100M. */
export function entryMcBucket(mcUsd: number | null): number {
  if (mcUsd == null) return -1;
  const edges = [10e3, 30e3, 100e3, 1e6, 10e6, 100e6];
  const i = edges.findIndex((e) => mcUsd < e);
  return i < 0 ? edges.length : i;
}

/** A moment in an un-tweeted position comparable to a tweet: pre-positioned, ≤ 72h in, forward 1h pump. */
export interface BaselineAnchor {
  tMs: number;
  pump1h: number;
  soldFrac1h: number;
}

/**
 * Step 5 candidates for one un-tweeted position: every candle start in its first 72h where the
 * wallet held ≥ $500, with that moment's forward 1h pump and the share sold in the next hour.
 */
export function baselineAnchors(fills: Fill[], series: PriceSeries, fromMs: number, toMs: number): BaselineAnchor[] {
  const out: BaselineAnchor[] = [];
  const step = CANDLE_SEC * 1000;
  for (let t = Math.ceil(fromMs / step) * step; t <= toMs; t += step) {
    const pos = positionAt(fills, t);
    if (pos.qty <= 0 || pos.firstBuyMs == null || t - pos.firstBuyMs > SDE_RULE.maxLeadSec * 1000) continue;
    const price = series.priceAt(t);
    const peak = series.maxIn(t, t + HOUR);
    if (price == null || price <= 0 || peak == null || pos.qty * price < SDE_RULE.minPrePosUsd) continue;
    const sold = fills
      .filter((f) => f.kind === "sell" && f.tMs > t && f.tMs <= t + HOUR)
      .reduce((s, f) => s + f.qty, 0);
    out.push({ tMs: t, pump1h: peak / price - 1, soldFrac1h: Math.min(1, sold / pos.qty) });
  }
  return out;
}

/** First anchor whose spike is at least `minPump` (matched spike), or null. */
export function matchAnchor(anchors: BaselineAnchor[], minPump: number): BaselineAnchor | null {
  return anchors.find((a) => a.pump1h >= minPump) ?? null;
}

/**
 * lift = P(sold_frac_1h ≥ 0.5 | tweeted) / P(sold_frac_1h ≥ 0.5 | untweeted, matched spike).
 * Null with < 5 tweeted pre-positioned mentions or no matched baseline. A zero baseline rate uses a
 * 0.5 continuity correction (0.5 / (n + 1)) so the ratio stays finite.
 */
export function computeLift(tweeted: number[], baseline: number[]): number | null {
  if (tweeted.length < LIFT_RULE.minTweeted || baseline.length === 0) return null;
  const rate = (xs: number[]) => xs.filter((x) => x >= LIFT_RULE.soldFrac1h).length / xs.length;
  const pt = rate(tweeted);
  const pu = rate(baseline) || 0.5 / (baseline.length + 1);
  return pt / pu;
}

/** Step 6 wallet-level label: ≥ 3 SDEs (trailing 90d), SDE rate ≥ 40% of pre-positioned bullish mentions, lift ≥ 2. */
export function promoteThenSellLabel(s: BrainProfile["promoteThenSell"]): Labelled<"promote_then_sell"> | null {
  if (!s || s.rate == null || s.lift == null) return null;
  if (s.events < LABEL_RULE.minEvents || s.rate < LABEL_RULE.minRate || s.lift < LABEL_RULE.minLift) return null;
  return {
    id: "promote_then_sell",
    label: "Promote-then-sell pattern",
    reason: `${s.events} of ${Math.round(s.events / s.rate)} pre-positioned bullish posts were followed by selling ≥50% within 24h (${Math.round(s.rate * 100)}%); ${s.lift.toFixed(1)}× the wallet's selling rate after comparable un-posted price spikes`,
  };
}

/**
 * Recompute promote-then-sell events for a brain from stored posts × trades, upsert `shill_events`
 * (evidence: tweet id, signatures, fractions) and return the profile summary. Null unless the brain
 * is claimed and X-linked (no tweet correlation for unclaimed brains).
 */
export async function detectPromoteThenSell(brainId: string): Promise<BrainProfile["promoteThenSell"]> {
  const db = getDb();
  const [brain] = await db
    .select({ status: brains.status, xUserId: brains.xUserId })
    .from(brains)
    .where(eq(brains.id, brainId))
    .limit(1);
  if (!brain || brain.status !== "claimed" || !brain.xUserId) return null;

  const sinceMs = Date.now() - WINDOW_DAYS * 86_400_000;
  const posts = await db
    .select()
    .from(tweets)
    .where(and(eq(tweets.brainId, brainId), gte(tweets.createdAtMs, sinceMs)));
  const mentions = posts.flatMap((p) =>
    (JSON.parse(p.mentionsJson) as TweetMention[]).map((m) => ({
      tweetId: p.id,
      tMs: p.createdAtMs,
      text: p.text,
      mint: m.mint,
      bullish: p.stance === "bullish",
    })),
  );
  const mentionedMints = new Set(mentions.map((m) => m.mint));

  // Fills from the start of any position that could be open in the window (72h lead + margin).
  const fromSec = Math.floor(sinceMs / 1000) - 7 * 86_400;
  const [tradeRows, transferRows] = await Promise.all([
    db.select().from(trades).where(and(eq(trades.brainId, brainId), gte(trades.blockTime, fromSec))),
    db.select().from(tokenTransfers).where(and(eq(tokenTransfers.brainId, brainId), gte(tokenTransfers.blockTime, fromSec))),
  ]);
  const fillsByMint = new Map<string, Fill[]>();
  const push = (mint: string, f: Fill) => {
    const list = fillsByMint.get(mint) ?? [];
    list.push(f);
    fillsByMint.set(mint, list);
  };
  for (const t of tradeRows) {
    push(t.mint, { tMs: t.blockTime * 1000, kind: t.side, qty: t.tokenAmount, usd: t.usdValue, mcUsd: t.mcUsd, signature: t.signature });
  }
  for (const t of transferRows) {
    push(t.mint, { tMs: t.blockTime * 1000, kind: t.direction, qty: t.amount, usd: null, mcUsd: null, signature: t.signature });
  }
  for (const list of fillsByMint.values()) list.sort((a, b) => a.tMs - b.tMs);

  // Steps 3–4 over bullish mentions.
  const bullish = mentions.filter((m) => m.bullish);
  type Evaluated = { m: (typeof bullish)[number]; f: MentionFeatures; sde: SDEResult };
  const evaluated: Evaluated[] = [];
  for (const m of bullish) {
    const fills = fillsByMint.get(m.mint) ?? [];
    if (positionAt(fills, m.tMs).qty <= 0) continue; // nothing held: not pre-positioned, no price lookup needed
    const candles = await fetchCandles(m.mint, Math.floor(m.tMs / 1000) - 6 * 3600, Math.floor(m.tMs / 1000) + 3600);
    const f = mentionFeatures(m, fills, candleSeries(candles));
    if (f) evaluated.push({ m, f, sde: classifySDE(true, f) });
  }
  const prePositioned = evaluated.filter((e) => e.f.prePosUsd >= SDE_RULE.minPrePosUsd);
  const events = evaluated.filter((e) => e.sde.sde);

  // Step 5: matched baseline from un-tweeted positions.
  const liftSet = prePositioned.filter(
    (e) => e.f.pump1h != null && e.f.leadTimeSec != null && e.f.leadTimeSec <= SDE_RULE.maxLeadSec,
  );
  let lift: number | null = null;
  if (liftSet.length >= LIFT_RULE.minTweeted) {
    const buckets = new Set(liftSet.map((e) => entryMcBucket(e.f.entryMcUsd)));
    const positions: { bucket: number; mint: string; fromMs: number; toMs: number }[] = [];
    for (const [mint, fills] of fillsByMint) {
      if (mentionedMints.has(mint)) continue;
      for (const f of fills) {
        if (f.kind !== "buy" || f.tMs < sinceMs) continue;
        const pos = positionAt(fills, f.tMs);
        if (pos.firstBuyMs !== f.tMs) continue; // only the opening buy of each position
        const bucket = entryMcBucket(f.mcUsd);
        if (buckets.has(bucket)) positions.push({ bucket, mint, fromMs: f.tMs, toMs: f.tMs + SDE_RULE.maxLeadSec * 1000 });
      }
    }
    positions.sort((a, b) => b.fromMs - a.fromMs);
    const anchorsByBucket = new Map<number, BaselineAnchor[][]>();
    for (const p of positions.slice(0, BASELINE_MAX_POSITIONS)) {
      const fills = fillsByMint.get(p.mint)!;
      const candles = await fetchCandles(p.mint, Math.floor(p.fromMs / 1000), Math.floor(p.toMs / 1000) + 3600);
      const anchors = baselineAnchors(fills, candleSeries(candles), p.fromMs, p.toMs);
      if (!anchors.length) continue;
      const list = anchorsByBucket.get(p.bucket) ?? [];
      list.push(anchors);
      anchorsByBucket.set(p.bucket, list);
    }
    const baseline: number[] = [];
    for (const e of liftSet) {
      for (const anchors of anchorsByBucket.get(entryMcBucket(e.f.entryMcUsd)) ?? []) {
        const a = matchAnchor(anchors, e.f.pump1h!);
        if (a) baseline.push(a.soldFrac1h);
      }
    }
    lift = computeLift(
      liftSet.map((e) => e.f.soldFrac.h1),
      baseline,
    );
  }

  // Persist SDEs with receipts; drop events that no longer qualify.
  const keep: string[] = [];
  for (const e of events) {
    keep.push(`${e.m.tweetId}:${e.m.mint}`);
    const row = {
      brainId,
      tweetId: e.m.tweetId,
      mint: e.m.mint,
      strong: e.sde.strong,
      prePositionUsd: e.f.prePosUsd,
      leadTimeSec: e.f.leadTimeSec == null ? null : Math.round(e.f.leadTimeSec),
      entryDiscount: e.f.entryDiscount,
      soldFrac1h: e.f.soldFrac.h1,
      soldFrac24h: e.f.soldFrac.h24,
      firstSellAfterSec: e.f.firstSellAfterSec == null ? null : Math.round(e.f.firstSellAfterSec),
      evidenceJson: JSON.stringify({
        tweetId: e.m.tweetId,
        tweetAtMs: e.m.tMs,
        mint: e.m.mint,
        priceAtTweetUsd: e.f.priceAtTweetUsd,
        avgEntryPriceUsd: e.f.avgEntryPriceUsd,
        prePositionTokens: e.f.prePosTokens,
        pump1h: e.f.pump1h,
        soldFrac: e.f.soldFrac,
        contradiction: e.f.contradiction,
        strongReasons: e.sde.strongReasons,
        entryBuys: e.f.entryBuys.map((b) => ({ signature: b.signature, tMs: b.tMs, tokens: b.qty, usd: b.usd })),
        sellsAfter: e.f.sellsAfter.map((s) => ({ signature: s.signature, tMs: s.tMs, tokens: s.qty, usd: s.usd })),
      }),
    };
    const { brainId: _b, tweetId: _t, mint: _m, ...update } = row;
    await db
      .insert(shillEvents)
      .values(row)
      .onConflictDoUpdate({ target: [shillEvents.brainId, shillEvents.tweetId, shillEvents.mint], set: update });
  }
  const existing = await db
    .select({ id: shillEvents.id, tweetId: shillEvents.tweetId, mint: shillEvents.mint })
    .from(shillEvents)
    .where(eq(shillEvents.brainId, brainId));
  const stale = existing.filter((r) => !keep.includes(`${r.tweetId}:${r.mint}`)).map((r) => r.id);
  if (stale.length) await db.delete(shillEvents).where(and(eq(shillEvents.brainId, brainId), inArray(shillEvents.id, stale)));

  return {
    bullishMentions: bullish.length,
    events: events.length,
    strongEvents: events.filter((e) => e.sde.strong).length,
    rate: prePositioned.length ? events.length / prePositioned.length : null,
    lift,
  };
}
