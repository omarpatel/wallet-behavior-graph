/**
 * Live-trade alerts: deterministic facts + headline per inserted live trade, and the anti-scalp check
 * for claimed KOLs. The LLM explanation is filled later by explainPendingAlerts().
 * Live inserts also drive swarm detection (src/server/signals) and RugCheck for the alerted tokens.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { and, eq, gt, inArray, lte } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { withBusyRetry } from "@/db/retry";
import { fmtDuration, fmtPct, fmtSol, fmtUsd } from "@/lib/format";
import { ensureRugChecks, ensureTokens, type TokenRow } from "@/server/ingest/tokens";
import { replayPosition, tradeOrder } from "@/server/profile/metrics";
import type { BrainProfile } from "@/server/profile/types";
import { syncSwarmsForMints, type SwarmChange } from "@/server/signals/swarms";
import type { AlertFacts, RugRisk } from "./types";

export type TradeRow = typeof schema.trades.$inferSelect;

/** Trades older than this when ingested (worker downtime backlog) are stored but not alerted. */
const MAX_ALERT_AGE_SEC = 3600;
const LOW_LIQUIDITY_USD = 50_000;
const TOP_HOLDERS_WARN_PCT = 30;
const RUG_SCORE_WARN = 60;
/** RugCheck is awaited this long at most before an alert goes out without it (the worker fills it later). */
const RUGCHECK_ALERT_BUDGET_MS = 2_500;
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

const ratio = (a: number | null | undefined, b: number | null | undefined) =>
  a != null && b != null && b > 0 ? a / b : null;

/** "BUY 2.4 SOL of $WIF at $84k MC · 38s after launch" / "SELL 1.1 SOL of $WIF at $210k MC · held 4m · +120%" */
export function alertHeadline(f: AlertFacts): string {
  const ticker = f.symbol ? `$${f.symbol}` : `${f.mint.slice(0, 4)}…${f.mint.slice(-4)}`;
  const solDigits = f.solValue == null ? 2 : f.solValue >= 10 ? 1 : f.solValue >= 0.1 ? 2 : 4;
  const size =
    f.solValue != null
      ? fmtSol(f.solValue, solDigits)
      : f.usdValue != null
        ? fmtUsd(f.usdValue)
        : `${f.tokenAmount.toLocaleString("en-US", { maximumFractionDigits: 0 })} tokens`;
  const parts = [`${f.side.toUpperCase()} ${size} of ${ticker}`];
  if (f.mcUsd != null) parts[0] += ` at ${fmtUsd(f.mcUsd)} MC`;
  if (f.side === "buy" && f.entryDelaySec != null) {
    parts.push(f.entryDelaySec <= 0 ? "launch block" : `${fmtDuration(f.entryDelaySec)} after launch`);
  }
  if (f.side === "sell") {
    if (f.position.heldSec != null) parts.push(`held ${fmtDuration(f.position.heldSec)}`);
    if (f.position.roiOnSell != null) parts.push(`${f.position.roiOnSell >= 0 ? "+" : ""}${fmtPct(f.position.roiOnSell)}`);
  }
  if (f.swarm) {
    parts.push(
      f.swarm.rank === 1
        ? `first of ${f.swarm.members} tracked brains`
        : `${ordinal(f.swarm.rank)} tracked brain in ${fmtDuration(f.swarm.lagSec)}`,
    );
  }
  return parts.join(" · ");
}

function inCharacter(t: TradeRow, profile: BrainProfile | null): AlertFacts["inCharacter"] {
  const notes: string[] = [];
  if (!profile) return { sizeVsMedian: null, mcVsMedian: null, delayVsMedian: null, notes: ["no profile yet"] };
  const size = t.side === "buy" ? ratio(t.usdValue, profile.sizing.medianBuyUsd) : null;
  const mc = t.side === "buy" ? ratio(t.mcUsd, profile.entryMc.medianUsd) : null;
  const delay = t.side === "buy" ? ratio(t.entryDelaySec, profile.timing.medianEntryDelaySec) : null;
  if (size != null) {
    if (size >= 2) notes.push(`${size.toFixed(1)}× usual size`);
    else if (size <= 0.5) notes.push(`${size.toFixed(1)}× usual size (smaller than usual)`);
    else notes.push("typical size");
  }
  if (mc != null) {
    if (mc >= 3) notes.push(`entry market cap ${mc.toFixed(1)}× the usual`);
    else if (mc <= 1 / 3) notes.push(`entry market cap ${mc.toFixed(2)}× the usual (earlier/smaller than usual)`);
  }
  if (delay != null) {
    if (delay >= 3) notes.push(`entered ${delay.toFixed(1)}× later than usual`);
    else if (delay <= 1 / 3) notes.push("entered much earlier than usual");
  }
  return { sizeVsMedian: size, mcVsMedian: mc, delayVsMedian: delay, notes };
}

function safety(token: TokenRow | undefined): AlertFacts["safety"] {
  const warnings: string[] = [];
  const liq = token?.liquidityUsd ?? null;
  if (liq != null && liq < LOW_LIQUIDITY_USD) warnings.push(`liquidity under $50k (${fmtUsd(liq)})`);
  if (token?.mintAuthorityDisabled === false) warnings.push("mint authority enabled");
  if (token?.freezeAuthorityDisabled === false) warnings.push("freeze authority enabled");
  const top = token?.topHoldersPct ?? null;
  if (top != null && top > TOP_HOLDERS_WARN_PCT) warnings.push(`top holders own ${top.toFixed(0)}%`);
  if (!token || token.source === "unresolved") warnings.push("token not indexed by Jupiter/DexScreener");

  // RugCheck's summary prose can contradict the structured audit (we have seen "Mint Authority still enabled" on a
  // revoked mint): Jupiter's flags win for mint/freeze, and liquidity is already covered above.
  const risks = JSON.parse(token?.rugRisksJson ?? "[]") as RugRisk[];
  const rugRisks = risks.filter((r) => {
    if (r.level !== "danger" && r.level !== "warn") return false;
    const n = r.name.toLowerCase();
    if (n.includes("mint authority")) return token?.mintAuthorityDisabled !== true;
    if (n.includes("freeze authority")) return token?.freezeAuthorityDisabled !== true;
    return true;
  });
  const rugScore = token?.rugScore ?? null;
  if (rugScore != null && rugScore > RUG_SCORE_WARN) warnings.push(`RugCheck risk ${rugScore}/100`);
  for (const r of rugRisks) {
    if (r.level === "danger" && !r.name.toLowerCase().includes("liquidity")) warnings.push(`RugCheck: ${r.name.toLowerCase()}`);
  }
  return {
    liquidityUsd: liq,
    topHoldersPct: top,
    mintAuthorityDisabled: token?.mintAuthorityDisabled ?? null,
    freezeAuthorityDisabled: token?.freezeAuthorityDisabled ?? null,
    organicScore: token?.organicScore ?? null,
    rugScore,
    lpLockedPct: token?.lpLockedPct ?? null,
    rugRisks,
    warnings,
  };
}

/** Build AlertFacts for one trade given the brain's full history of that mint (ordered or not). */
export function buildAlertFacts(
  t: TradeRow,
  mintHistory: TradeRow[],
  token: TokenRow | undefined,
  profile: BrainProfile | null,
  swarm?: AlertFacts["swarm"],
): AlertFacts {
  const upTo = mintHistory.filter((o) => tradeOrder(o, t) <= 0 || o.id === t.id);
  if (!upTo.some((o) => o.id === t.id)) upTo.push(t);
  const before = upTo.filter((o) => o.id !== t.id);
  const pos = replayPosition(upTo);
  const buysSoFar = upTo.filter((o) => o.side === "buy").length;
  const sellsSoFar = upTo.filter((o) => o.side === "sell").length;
  const firstBuyAt = upTo.filter((o) => o.side === "buy").reduce<number | null>((m, o) => (m == null || o.blockTime < m ? o.blockTime : m), null);
  const fill = t.side === "sell" ? pos?.sellFills.find((f) => f.signature === t.signature) : undefined;
  const soldTotal = pos ? pos.sellFills.reduce((s, f) => s + f.qty, 0) : 0;

  return {
    side: t.side,
    signature: t.signature,
    blockTime: t.blockTime,
    mint: t.mint,
    symbol: token?.symbol ?? null,
    name: token?.name ?? null,
    icon: token?.icon ?? null,
    launchpad: t.launchpad ?? token?.launchpad ?? null,
    venue: t.venue,
    tokenAmount: t.tokenAmount,
    solValue: t.solValue,
    usdValue: t.usdValue,
    mcUsd: t.mcUsd,
    entryDelaySec: t.side === "buy" ? t.entryDelaySec : null,
    position: {
      isFirstBuy: t.side === "buy" && !before.some((o) => o.side === "buy"),
      buysSoFar,
      sellsSoFar,
      heldSec: firstBuyAt != null ? t.blockTime - firstBuyAt : null,
      soldFraction: t.side === "sell" && pos && pos.peakQty > 0 ? soldTotal / pos.peakQty : null,
      realizedUsd: fill?.realizedUsd ?? null,
      roiOnSell: fill?.roi ?? null,
    },
    inCharacter: inCharacter(t, profile),
    safety: safety(token),
    ...(swarm && t.side === "buy" && !before.some((o) => o.side === "buy") ? { swarm } : {}),
    links: {
      solscanTx: `https://solscan.io/tx/${t.signature}`,
      dexscreener: `https://dexscreener.com/solana/${t.mint}`,
      pumpfun: (t.launchpad ?? token?.launchpad ?? "").toLowerCase().includes("pump") ? `https://pump.fun/coin/${t.mint}` : null,
    },
  };
}

/** This trade's place in a swarm on its mint (from the live swarm sync), if its brain is a member. */
function swarmFor(t: TradeRow, changes: SwarmChange[]): AlertFacts["swarm"] {
  const s = changes.find((c) => c.mint === t.mint && c.brainIds.includes(t.brainId));
  if (!s) return undefined;
  const rank = s.brainIds.indexOf(t.brainId) + 1;
  return { id: s.id, stage: s.stage, members: s.members, rank, lagSec: t.blockTime - s.startedAt };
}

/**
 * Create one alert per freshly inserted live trade (never for backfill rows or stale backlog).
 * publishAt = blockTime + brain.alertDelaySec. Returns the number of alerts created.
 * Every inserted live buy (stale backlog too) first updates swarms for its token; alerted tokens get a RugCheck
 * (bounded wait, 6 h cache).
 */
export async function createAlertsForTrades(trades: TradeRow[]): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  let swarms: SwarmChange[] = [];
  const liveBuyMints = trades.filter((t) => t.source === "live" && t.side === "buy").map((t) => t.mint);
  try {
    swarms = await syncSwarmsForMints(liveBuyMints);
  } catch (err) {
    console.error(`[swarms] live sync failed: ${err instanceof Error ? err.message : err}`);
  }
  const live = trades.filter((t) => t.source === "live" && now - t.blockTime <= MAX_ALERT_AGE_SEC);
  if (!live.length) return 0;
  const db = getDb();
  const mints = [...new Set(live.map((t) => t.mint))];
  await ensureTokens(mints, { maxAgeSec: 600 });
  await Promise.race([
    ensureRugChecks(mints).catch((err) => console.error(`[rugcheck] ${err instanceof Error ? err.message : err}`)),
    sleep(RUGCHECK_ALERT_BUDGET_MS),
  ]);
  const tokens = await ensureTokens(mints, { maxAgeSec: 600 });
  const brainIds = [...new Set(live.map((t) => t.brainId))];
  const brainRows = await db
    .select({ id: schema.brains.id, alertDelaySec: schema.brains.alertDelaySec, profileJson: schema.brains.profileJson })
    .from(schema.brains)
    .where(inArray(schema.brains.id, brainIds));
  const brainById = new Map(brainRows.map((b) => [b.id, b]));

  let created = 0;
  for (const t of live) {
    const brain = brainById.get(t.brainId);
    if (!brain) continue;
    const history = await db
      .select()
      .from(schema.trades)
      .where(and(eq(schema.trades.brainId, t.brainId), eq(schema.trades.mint, t.mint)));
    const profile = brain.profileJson ? (JSON.parse(brain.profileJson) as BrainProfile) : null;
    const facts = buildAlertFacts(t, history, tokens.get(t.mint), profile, swarmFor(t, swarms));
    // single autocommit insert: a BUSY attempt wrote nothing, so retrying cannot duplicate the alert
    const inserted = await withBusyRetry(
      () =>
        db
          .insert(schema.alerts)
          .values({
            brainId: t.brainId,
            tradeId: t.id,
            headline: alertHeadline(facts),
            factsJson: JSON.stringify(facts),
            publishAt: t.blockTime + brain.alertDelaySec,
          })
          .onConflictDoNothing()
          .returning({ id: schema.alerts.id }),
      { label: "alert insert" },
    );
    created += inserted.length;
  }
  return created;
}

/**
 * Anti-scalping (claimed KOLs): if the KOL sold ≥ 50% of an alerted buy position within 60 min after the
 * alert's publishAt, hold revenue with the evidence as reason. Returns the number of brains newly held.
 */
export async function runAntiScalpCheck(): Promise<number> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const claimed = await db
    .select({ id: schema.brains.id })
    .from(schema.brains)
    .where(and(eq(schema.brains.status, "claimed"), eq(schema.brains.revenueHeld, false)));
  let held = 0;
  for (const { id } of claimed) {
    // alerted buys whose 60-min watch window overlaps the last 48 h
    const rows = await db
      .select({ alert: schema.alerts, trade: schema.trades })
      .from(schema.alerts)
      .innerJoin(schema.trades, eq(schema.alerts.tradeId, schema.trades.id))
      .where(
        and(
          eq(schema.alerts.brainId, id),
          eq(schema.trades.side, "buy"),
          lte(schema.alerts.publishAt, now),
          gt(schema.alerts.publishAt, now - 48 * 3600),
        ),
      );
    for (const { alert, trade } of rows) {
      const history = await db
        .select()
        .from(schema.trades)
        .where(and(eq(schema.trades.brainId, id), eq(schema.trades.mint, trade.mint), lte(schema.trades.blockTime, alert.publishAt + 3600)));
      const atBuy = replayPosition(history.filter((o) => tradeOrder(o, trade) <= 0));
      const posQty = atBuy?.qty ?? trade.tokenAmount;
      if (!(posQty > 0)) continue;
      const sells = history.filter((o) => o.side === "sell" && o.blockTime >= alert.publishAt && o.blockTime <= alert.publishAt + 3600);
      const soldQty = sells.reduce((s, o) => s + o.tokenAmount, 0);
      const frac = soldQty / posQty;
      if (frac < 0.5) continue;
      const lastSell = sells.reduce((a, b) => (b.blockTime > a.blockTime ? b : a));
      const facts = JSON.parse(alert.factsJson) as AlertFacts;
      const ticker = facts.symbol ? `$${facts.symbol}` : trade.mint;
      const reason =
        `Sold ${fmtPct(Math.min(frac, 1))} of the ${ticker} position within ${fmtDuration(lastSell.blockTime - alert.publishAt)} ` +
        `after alert #${alert.id} published (buy ${trade.signature}, last sell ${lastSell.signature}).`;
      await db.update(schema.brains).set({ revenueHeld: true, revenueHeldReason: reason }).where(eq(schema.brains.id, id));
      held++;
      break;
    }
  }
  return held;
}
