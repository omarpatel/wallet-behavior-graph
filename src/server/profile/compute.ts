/**
 * computeProfile: pure function from a wallet's trades + token rows to a BrainProfile.
 * Methodology: the /methodology page.
 */
import { MIN_PRICED_SOL, WINDOW_DAYS } from "@/server/ingest/constants";
import { classifyArchetype, overlayFlags, type ArchetypeStats } from "./archetypes";
import { bucketize, buildPositions, mean, median, quantile, share, type Position, type ProfileToken, type ProfileTrade } from "./metrics";
import { copyability, DEFAULT_WIN_RATE_BASE, shrinkWinRate, tierFor, trackScore } from "./score";
import { PROFILE_SCHEMA_VERSION, type BrainProfile, type Buckets, type Labelled, type TokenResult } from "./types";

const CURVE_VENUES = new Set(["pump_curve", "raydium_launchlab", "meteora_dbc", "moonshot"]);

export interface ComputeOptions {
  wallet?: string;
  /** Claimed + X-linked brains only (detectPromoteThenSell); null otherwise. */
  promoteThenSell?: BrainProfile["promoteThenSell"];
  promoteThenSellFlag?: Labelled<"promote_then_sell"> | null;
  /** Population win rate (pooled closed positions across brains) the win rate is shrunk toward. */
  winRateBase?: number;
}

const launchpadGroup = (lp: string | null) => {
  if (!lp) return "unknown";
  const l = lp.toLowerCase();
  if (l.includes("pump")) return "pump.fun";
  if (l.includes("bonk")) return "bonk";
  return "other";
};

/** Best 6-hour UTC window (circular). */
function sessionWindow(hours: number[], total: number): { label: string; share: number } | null {
  if (total < 20) return null;
  let best = { start: 0, count: -1 };
  for (let start = 0; start < 24; start++) {
    let c = 0;
    for (let k = 0; k < 6; k++) c += hours[(start + k) % 24];
    if (c > best.count) best = { start, count: c };
  }
  const s = best.count / total;
  if (s < 0.7) return null;
  const pad = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;
  return { label: `${pad(best.start)}–${pad(best.start + 6)} UTC`, share: s };
}

function tokenResult(p: Position, tokens: Map<string, ProfileToken>): TokenResult {
  const t = tokens.get(p.mint);
  return {
    mint: p.mint,
    symbol: t?.symbol ?? null,
    icon: t?.icon ?? null,
    buyUsd: p.buyUsd,
    realizedUsd: p.realizedUsd,
    roi: p.buyUsd > 0 ? p.realizedUsd / p.buyUsd : null,
    firstBuyAt: p.firstBuyAt,
    holdSec: p.firstSellAt != null ? p.firstSellAt - p.firstBuyAt : null,
    entryMcUsd: p.entryMcUsd,
    open: !p.closed,
  };
}

export function computeProfile(
  allTrades: ProfileTrade[],
  tokenList: ProfileToken[] | Map<string, ProfileToken>,
  now: number,
  opts: ComputeOptions = {},
): BrainProfile {
  const tokens = tokenList instanceof Map ? tokenList : new Map(tokenList.map((t) => [t.mint, t]));
  const since = now - WINDOW_DAYS * 86_400;
  const trades = allTrades.filter((t) => t.blockTime >= since && t.blockTime <= now);
  const buys = trades.filter((t) => t.side === "buy");
  const sells = trades.filter((t) => t.side === "sell");
  const mints = new Set(trades.map((t) => t.mint));
  const times = trades.map((t) => t.blockTime);
  const firstTradeAt = times.length ? Math.min(...times) : null;
  const lastTradeAt = times.length ? Math.max(...times) : null;
  const activeDays = new Set(times.map((t) => Math.floor(t / 86_400))).size;
  const rated = trades.length >= 20 && mints.size >= 5;

  // ---------------- positions / PnL
  const positions = buildPositions(trades);
  const closed = positions.filter((p) => p.closed);
  const roiOf = (p: Position) => (p.buyUsd > 0 ? p.realizedUsd / p.buyUsd : 0);
  const realizedUsd = positions.reduce((s, p) => s + p.realizedUsd, 0);
  const realizedSol = positions.reduce((s, p) => s + p.realizedSol, 0);
  const costUsd = positions.reduce((s, p) => s + p.soldBasisUsd, 0);
  const wins = positions.filter((p) => p.realizedUsd > 0).reduce((s, p) => s + p.realizedUsd, 0);
  const losses = -positions.filter((p) => p.realizedUsd < 0).reduce((s, p) => s + p.realizedUsd, 0);
  const winRate = share(closed, (p) => p.realizedUsd > 0);
  const deepLossShare = share(closed, (p) => roiOf(p) < -0.5);
  const winRateBase = opts.winRateBase ?? DEFAULT_WIN_RATE_BASE;
  const winRateShrunk = closed.length
    ? shrinkWinRate(closed.filter((p) => p.realizedUsd > 0).length, closed.length, winRateBase)
    : null;
  const pnlBuckets: Buckets = bucketize(
    closed.map(roiOf),
    ["< −50%", "−50–0%", "0–2x", "2–5x", ">5x"],
    [-0.5, 0, 1, 4],
  ).reverse();

  // ---------------- timing
  const delays = positions.map((p) => p.entryDelaySec).filter((d): d is number => d != null);
  const pumpPositions = positions.filter((p) => launchpadGroup(tokens.get(p.mint)?.launchpad ?? p.launchpad) === "pump.fun");
  const timingBuckets = bucketize(delays, ["same block", "≤10s", "<1m", "1–5m", "5–60m", "1–24h", ">24h"], [1, 11, 60, 300, 3600, 86_400]);

  // ---------------- entry MC
  const entryMcs = positions.map((p) => p.entryMcUsd).filter((x): x is number => x != null && x > 0);
  const medianEntryMc = median(entryMcs);

  // ---------------- hold (copy window)
  const windows = positions.filter((p) => p.firstSellAt != null).map((p) => p.firstSellAt! - p.firstBuyAt);
  const medianHoldSec = windows.length >= 3 ? median(windows) : null;
  const soldWithin = (sec: number) => share(positions, (p) => p.firstSellAt != null && p.firstSellAt - p.firstBuyAt <= sec);
  const holdBuckets: Buckets = [
    ...bucketize(windows, ["<1m", "1–5m", "5–60m", "1–24h", "1–7d", ">7d"], [60, 300, 3600, 86_400, 7 * 86_400]),
    { label: "still open", count: positions.filter((p) => p.firstSellAt == null).length },
  ];

  // ---------------- sizing
  // Dust buys (fixed-cost micro-trades) would otherwise define the "usual" size of bot-heavy wallets.
  const sizedBuys = buys.filter((t) => t.solValue == null || t.solValue >= MIN_PRICED_SOL);
  const buyUsd = sizedBuys.map((t) => t.usdValue).filter((x): x is number => x != null);
  const buySol = sizedBuys.map((t) => t.solValue).filter((x): x is number => x != null);
  const perToken = positions.map((p) => p.buyUsd);
  const mu = mean(perToken);
  const cv =
    mu && perToken.length >= 3 ? Math.sqrt(perToken.reduce((s, x) => s + (x - mu) ** 2, 0) / perToken.length) / mu : null;

  // ---------------- exits
  const exited = positions.filter((p) => p.sellFills.length > 0);
  const avgBuysPerToken = mean(positions.map((p) => p.buys));
  const avgSellsPerToken = mean(positions.map((p) => p.sells));

  // ---------------- mix
  const lpCounts = new Map<string, number>([["pump.fun", 0], ["bonk", 0], ["other", 0], ["unknown", 0]]);
  for (const p of positions) {
    const g = launchpadGroup(tokens.get(p.mint)?.launchpad ?? p.launchpad);
    lpCounts.set(g, lpCounts.get(g)! + 1);
  }
  const venueCounts = new Map<string, number>();
  for (const t of trades) venueCounts.set(t.venue ?? "unknown", (venueCounts.get(t.venue ?? "unknown") ?? 0) + 1);

  // ---------------- activity
  const spanDays = firstTradeAt != null && lastTradeAt != null ? Math.max(1, (lastTradeAt - firstTradeAt) / 86_400) : null;
  const tradesPerDay = spanDays ? trades.length / spanDays : null;
  const hours = Array.from({ length: 24 }, () => 0);
  for (const t of times) hours[new Date(t * 1000).getUTCHours()]++;
  const session = sessionWindow(hours, trades.length);

  // ---------------- archetype
  const knownVenue = positions.filter((p) => p.firstBuyVenue && p.firstBuyVenue !== "unknown");
  const launchBlock = positions.filter((p) => p.entryDelaySec != null && p.entryDelaySec <= 1);
  const launchDevs = new Set(launchBlock.map((p) => tokens.get(p.mint)?.dev ?? `mint:${p.mint}`));
  const aged = positions.filter((p) => p.firstBuyAt <= now - 30 * 86_400);
  const archetypeStats: ArchetypeStats = {
    rated,
    trades: trades.length,
    tokens: mints.size,
    tradesPerDay,
    trades7d: trades.filter((t) => t.blockTime >= now - 7 * 86_400).length,
    devTokenShare: opts.wallet ? share(positions, (p) => tokens.get(p.mint)?.dev === opts.wallet) : null,
    flashFlipShare: share(positions, (p) => p.firstSellAt != null && p.firstSellAt - p.firstBuyAt <= 5),
    launchBlockEntryShare: delays.length ? launchBlock.length / delays.length : null,
    launchBlockDistinctDevs: launchDevs.size,
    medianHoldSec,
    medianEntryMcUsd: medianEntryMc,
    medianEntryDelaySec: median(delays),
    preGraduationShare: share(positions, (p) => CURVE_VENUES.has(p.firstBuyVenue ?? "")),
    postGraduationShare: share(knownVenue, (p) => !CURVE_VENUES.has(p.firstBuyVenue!)),
    openAfter30dShare: share(aged, (p) => !p.closed),
    avgBuysPerToken,
    avgSellsPerToken,
  };
  const archetype = classifyArchetype(archetypeStats);

  // ---------------- scores
  const scored = rated && closed.length >= 5;
  const score = scored
    ? trackScore({
        deepLossShare,
        profitShare: wins + losses > 0 ? wins / (wins + losses) : null,
        roi: costUsd > 0 ? realizedUsd / costUsd : null,
        winRateShrunk,
        winRateBase,
        tokens: positions.length,
        deployer: archetype.id === "deployer",
      })
    : null;
  const copy = copyability({
    medianEntryMcUsd: medianEntryMc,
    profitPerPositionUsd: mean(closed.map((p) => p.realizedUsd)),
    medianHoldSec,
    tradesPerWeek: tradesPerDay != null ? tradesPerDay * 7 : null,
    archetype: archetype.id,
    winRateShrunk,
    winRateBase,
  });

  const sortedBuy = [...perToken].sort((a, b) => b - a);
  const totalBuy = sortedBuy.reduce((a, b) => a + b, 0);
  // A position "rode a rug" when the wallet itself took the hit: closed ≥80% down, or still holds a token that is
  // now dead (< $4k liquidity). Current liquidity alone would flag every memecoin trader (most coins die later).
  const rugRidden = positions.filter((p) => {
    if (p.closed) return p.buyUsd > 0 && p.realizedUsd / p.buyUsd <= -0.8;
    const liq = tokens.get(p.mint)?.liquidityUsd;
    return liq != null && liq < 4000;
  }).length;
  const flags = overlayFlags({
    tokens: positions.length,
    winRate,
    closedPositions: closed.length,
    tokensOver5x: positions.filter((p) => roiOf(p) > 4).length,
    deepLossShare,
    realizedUsd,
    avgBuysPerToken,
    avgSellsPerToken,
    top3BuyShare: totalBuy > 0 ? sortedBuy.slice(0, 3).reduce((a, b) => a + b, 0) / totalBuy : null,
    avgBuyUsd: mean(buyUsd),
    buys: buys.length,
    sells: sells.length,
    deadTokenShare: positions.length ? rugRidden / positions.length : null,
    deadTokenKnown: positions.length,
    sessionWindowUtc: session?.label ?? null,
    sessionShare: session?.share ?? null,
    copyabilityScore: copy.score,
    trackScore: score,
    promoteThenSell: opts.promoteThenSellFlag ?? null,
  });

  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    computedAt: now,
    windowDays: WINDOW_DAYS,
    sample: { trades: trades.length, buys: buys.length, sells: sells.length, tokens: mints.size, firstTradeAt, lastTradeAt, activeDays },
    rated,
    archetype,
    flags,
    pnl: {
      realizedUsd,
      realizedSol,
      costUsd,
      roi: costUsd > 0 ? realizedUsd / costUsd : null,
      winRate,
      winRateShrunk,
      winRateBase,
      closedPositions: closed.length,
      openPositions: positions.length - closed.length,
      profitFactor: losses > 0 ? wins / losses : null,
      buckets: pnlBuckets,
    },
    timing: {
      medianEntryDelaySec: median(delays),
      p25EntryDelaySec: quantile(delays, 0.25),
      p75EntryDelaySec: quantile(delays, 0.75),
      buckets: timingBuckets,
      preGraduationShare: share(pumpPositions, (p) => p.firstBuyVenue === "pump_curve"),
      firstMinuteShare: share(delays, (d) => d < 60),
    },
    entryMc: {
      medianUsd: medianEntryMc,
      buckets: bucketize(entryMcs, ["<$10k", "$10–30k", "$30–100k", "$100k–1M", "$1–10M", "$10–100M", "≥$100M"], [1e4, 3e4, 1e5, 1e6, 1e7, 1e8]),
    },
    hold: {
      medianHoldSec,
      flashFlipShare: archetypeStats.flashFlipShare,
      soldWithin5mShare: soldWithin(300),
      soldWithin1hShare: soldWithin(3600),
      soldWithin24hShare: soldWithin(86_400),
      buckets: holdBuckets,
    },
    sizing: {
      medianBuySol: median(buySol),
      medianBuyUsd: median(buyUsd),
      avgBuyUsd: mean(buyUsd),
      cv,
      style: cv == null ? null : cv < 0.5 ? "fixed" : cv <= 1 ? "variable" : "conviction",
    },
    exits: {
      avgBuysPerToken,
      avgSellsPerToken,
      fullDumpShare: share(exited, (p) => p.sellFills.some((f) => f.qty >= 0.9 * f.peakQty)),
      ladderShare: share(exited, (p) => p.sellFills.length >= 3),
      initialsOutShare: share(exited, (p) => {
        const f = p.sellFills[0];
        return f.proceedsUsd >= f.costBeforeUsd && f.qtyBefore - f.qty > f.peakQty * 0.01;
      }),
      stopOutShare: share(exited, (p) => (p.sellFills[0].roi ?? 0) <= -0.3),
    },
    coinMix: {
      launchpads: [...lpCounts].map(([label, count]) => ({ label, count })),
      venues: [...venueCounts].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })),
    },
    activity: { tradesPerDay, hourHistogramUtc: hours, sessionWindowUtc: session?.label ?? null },
    copyability: copy,
    trackScore: score,
    tier: tierFor(score, scored),
    topWins: positions.filter((p) => p.realizedUsd > 0).sort((a, b) => b.realizedUsd - a.realizedUsd).slice(0, 5).map((p) => tokenResult(p, tokens)),
    topLosses: positions.filter((p) => p.realizedUsd < 0).sort((a, b) => a.realizedUsd - b.realizedUsd).slice(0, 5).map((p) => tokenResult(p, tokens)),
    recentTokens: [...positions].sort((a, b) => b.firstBuyAt - a.firstBuyAt).slice(0, 20).map((p) => tokenResult(p, tokens)),
    promoteThenSell: opts.promoteThenSell ?? null,
  };
}
