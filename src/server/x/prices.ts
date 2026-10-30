import { setTimeout as sleep } from "node:timers/promises";

/**
 * Historical USD price candles for a Solana token from the GeckoTerminal public API (no key,
 * ~30 req/min, history limited to the last 180 days). Used by promote-then-sell detection for the
 * price at tweet time and the post-tweet spike; trades themselves carry exact execution prices.
 */

export interface Candle {
  /** Candle start, unix seconds. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Volume in USD. */
  v: number;
}

const GT = "https://api.geckoterminal.com/api/v2/networks/solana";
export const CANDLE_SEC = 300; // 5-minute candles
const MIN_GAP_MS = 2_100;
const POOLS_TTL_MS = 6 * 3600_000;

let lastCall = 0;
let queue: Promise<unknown> = Promise.resolve();

/** Serialize GeckoTerminal calls with a minimum gap (public rate limit), retrying once on 429. */
function gtFetch<T>(path: string): Promise<T | null> {
  const run = async (): Promise<T | null> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const wait = lastCall + MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      const res = await fetch(`${GT}${path}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429) {
        await sleep(30_000);
        continue;
      }
      // 404: unknown token/pool; 401: outside the public 180-day window.
      if (res.status === 404 || res.status === 401) return null;
      if (!res.ok) throw new Error(`GeckoTerminal ${res.status} on ${path}`);
      return (await res.json()) as T;
    }
    throw new Error(`GeckoTerminal rate limit on ${path}`);
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

const poolsCache = new Map<string, { at: number; pools: string[] }>();

/** Pools to read: the most active one plus the pump.fun curve / PumpSwap pools (pre/post migration). */
async function poolsFor(mint: string): Promise<string[]> {
  const hit = poolsCache.get(mint);
  if (hit && Date.now() - hit.at < POOLS_TTL_MS) return hit.pools;
  const res = await gtFetch<{
    data?: { attributes: { address: string }; relationships: { dex: { data: { id: string } } } }[];
  }>(`/tokens/${mint}/pools?page=1`);
  const list = res?.data ?? [];
  const picked = new Set<string>();
  if (list[0]) picked.add(list[0].attributes.address);
  for (const dex of ["pump-fun", "pumpswap"]) {
    const p = list.find((x) => x.relationships.dex.data.id === dex);
    if (p) picked.add(p.attributes.address);
  }
  const pools = [...picked];
  poolsCache.set(mint, { at: Date.now(), pools });
  return pools;
}

/** 5-minute USD candles of `mint` covering [fromSec, toSec], merged across its pools (highest volume wins). */
export async function fetchCandles(mint: string, fromSec: number, toSec: number): Promise<Candle[]> {
  const byT = new Map<number, Candle>();
  for (const pool of await poolsFor(mint)) {
    let before = toSec + CANDLE_SEC;
    while (before > fromSec) {
      const res = await gtFetch<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>(
        `/pools/${pool}/ohlcv/minute?aggregate=5&limit=1000&currency=usd&token=${mint}&before_timestamp=${before}`,
      );
      const rows = res?.data?.attributes?.ohlcv_list ?? [];
      if (!rows.length) break;
      for (const [t, o, h, l, c, v] of rows) {
        if (t < fromSec - CANDLE_SEC || t > toSec) continue;
        const prev = byT.get(t);
        if (!prev || v > prev.v) byT.set(t, { t, o, h, l, c, v });
      }
      const oldest = Math.min(...rows.map((r) => r[0]));
      if (oldest >= before) break;
      before = oldest;
      if (rows.length < 1000) break;
    }
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}
