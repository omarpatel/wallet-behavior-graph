/**
 * Position accounting + statistics primitives (pure).
 * Average-cost realized PnL ignoring oversell.
 */

/** The trade fields the profile engine needs (a subset of a `trades` row). */
export interface ProfileTrade {
  signature: string;
  slot: number;
  txIndex: number;
  blockTime: number;
  side: "buy" | "sell";
  mint: string;
  tokenAmount: number;
  solValue: number | null;
  usdValue: number | null;
  feesSol: number;
  solUsd: number | null;
  mcUsd: number | null;
  venue: string | null;
  launchpad: string | null;
  entryDelaySec: number | null;
}

/** Token fields the profile engine reads (a subset of a `tokens` row). */
export interface ProfileToken {
  mint: string;
  symbol: string | null;
  icon: string | null;
  launchpad: string | null;
  dev: string | null;
  liquidityUsd: number | null;
}

export interface SellFill {
  blockTime: number;
  signature: string;
  qty: number; // matched against basis (oversell excluded)
  qtyBefore: number; // position before this sell
  peakQty: number;
  proceedsUsd: number;
  basisUsd: number;
  realizedUsd: number;
  roi: number | null; // proceeds / basis − 1
  costBeforeUsd: number; // open cost basis before the sell
}

export interface Position {
  mint: string;
  buys: number;
  sells: number;
  qty: number;
  peakQty: number;
  buyUsd: number; // Σ buy value + buy fees
  buySol: number;
  openCostUsd: number;
  openCostSol: number;
  realizedUsd: number;
  realizedSol: number;
  soldBasisUsd: number;
  firstBuyAt: number;
  firstBuySlot: number;
  lastActivityAt: number;
  firstSellAt: number | null;
  entryMcUsd: number | null; // first buy
  entryDelaySec: number | null; // first buy
  firstBuyVenue: string | null;
  launchpad: string | null;
  sellFills: SellFill[];
  /** ≤1% of peak left. */
  closed: boolean;
}

const DUST_FRACTION = 0.01;

const feeUsdOf = (t: ProfileTrade) => {
  const rate = t.solUsd ?? (t.usdValue != null && t.solValue ? t.usdValue / t.solValue : null);
  return rate != null ? t.feesSol * rate : 0;
};

export const tradeOrder = (a: ProfileTrade, b: ProfileTrade) =>
  a.slot - b.slot || a.txIndex - b.txIndex || (a.side === b.side ? 0 : a.side === "buy" ? -1 : 1);

/**
 * Replay one mint's trades (any order; sorted here) into an average-cost position.
 * Trades without a USD value carry no basis and are skipped. Sells beyond the held quantity (tokens that
 * arrived by transfer, or bought before the window) only realize PnL on the matched part.
 * Returns null when there is no valued buy (sell-only history has no basis).
 */
export function replayPosition(trades: ProfileTrade[]): Position | null {
  const sorted = [...trades].sort(tradeOrder);
  let p: Position | null = null;
  for (const t of sorted) {
    if (t.usdValue == null || !(t.tokenAmount > 0)) continue;
    const feeUsd = feeUsdOf(t);
    const sol = t.solValue ?? 0;
    if (t.side === "buy") {
      p ??= {
        mint: t.mint,
        buys: 0,
        sells: 0,
        qty: 0,
        peakQty: 0,
        buyUsd: 0,
        buySol: 0,
        openCostUsd: 0,
        openCostSol: 0,
        realizedUsd: 0,
        realizedSol: 0,
        soldBasisUsd: 0,
        firstBuyAt: t.blockTime,
        firstBuySlot: t.slot,
        lastActivityAt: t.blockTime,
        firstSellAt: null,
        entryMcUsd: t.mcUsd,
        entryDelaySec: t.entryDelaySec,
        firstBuyVenue: t.venue,
        launchpad: t.launchpad,
        sellFills: [],
        closed: false,
      };
      p.buys++;
      p.qty += t.tokenAmount;
      p.peakQty = Math.max(p.peakQty, p.qty);
      p.buyUsd += t.usdValue + feeUsd;
      p.buySol += sol + t.feesSol;
      p.openCostUsd += t.usdValue + feeUsd;
      p.openCostSol += sol + t.feesSol;
      p.lastActivityAt = t.blockTime;
      continue;
    }
    if (!p || p.qty <= 0) continue; // oversell without basis
    const q = Math.min(t.tokenAmount, p.qty);
    const frac = q / t.tokenAmount;
    const proceedsUsd = (t.usdValue - feeUsd) * frac;
    const proceedsSol = (sol - t.feesSol) * frac;
    const avgUsd = p.openCostUsd / p.qty;
    const avgSol = p.openCostSol / p.qty;
    const basisUsd = avgUsd * q;
    const basisSol = avgSol * q;
    const fill: SellFill = {
      blockTime: t.blockTime,
      signature: t.signature,
      qty: q,
      qtyBefore: p.qty,
      peakQty: p.peakQty,
      proceedsUsd,
      basisUsd,
      realizedUsd: proceedsUsd - basisUsd,
      roi: basisUsd > 0 ? proceedsUsd / basisUsd - 1 : null,
      costBeforeUsd: p.openCostUsd,
    };
    p.sells++;
    p.sellFills.push(fill);
    p.realizedUsd += fill.realizedUsd;
    p.realizedSol += proceedsSol - basisSol;
    p.soldBasisUsd += basisUsd;
    p.qty -= q;
    p.openCostUsd -= basisUsd;
    p.openCostSol -= basisSol;
    p.firstSellAt ??= t.blockTime;
    p.lastActivityAt = t.blockTime;
  }
  if (p) p.closed = p.qty <= p.peakQty * DUST_FRACTION;
  return p;
}

/** Group trades by mint and replay each into a position (positions without a valued buy are dropped). */
export function buildPositions(trades: ProfileTrade[]): Position[] {
  const byMint = new Map<string, ProfileTrade[]>();
  for (const t of trades) {
    const list = byMint.get(t.mint);
    if (list) list.push(t);
    else byMint.set(t.mint, [t]);
  }
  const out: Position[] = [];
  for (const list of byMint.values()) {
    const p = replayPosition(list);
    if (p) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- statistics

export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const median = (values: number[]) => quantile(values, 0.5);

export function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** share of items matching, null for an empty denominator */
export function share<T>(items: T[], pred: (x: T) => boolean): number | null {
  return items.length ? items.filter(pred).length / items.length : null;
}

/**
 * Count values into ordered buckets. `edges[i]` is the exclusive upper bound of bucket i;
 * the last label takes everything ≥ the last edge.
 */
export function bucketize(values: number[], labels: string[], edges: number[]): { label: string; count: number }[] {
  const counts = labels.map((label) => ({ label, count: 0 }));
  for (const v of values) {
    let i = edges.findIndex((e) => v < e);
    if (i < 0) i = labels.length - 1;
    counts[i].count++;
  }
  return counts;
}
