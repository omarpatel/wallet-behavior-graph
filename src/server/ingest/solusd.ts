/**
 * SOL/USD at minute resolution from Binance public market data (data-api.binance.vision, keyless),
 * cached in sol_usd_1m. Backfill fetches 1,000-minute windows in bulk.
 */
import { and, gte, lte } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { withBusyRetry } from "@/db/retry";
import { fetchJson, RateLimiter } from "./http";

const BINANCE = "https://data-api.binance.vision/api/v3/klines";
const binanceLimiter = new RateLimiter(10, 1000);
/** Nearest-candle tolerance when Binance has a gap. */
const MAX_GAP_SEC = 10 * 60;

type Kline = [number, string, string, string, string, string, number, ...unknown[]];

const minuteOf = (ts: number) => Math.floor(ts / 60) * 60;

async function fetchWindow(startMinute: number, limit = 1000): Promise<{ minuteTs: number; close: number; closed: boolean }[]> {
  const url = `${BINANCE}?symbol=SOLUSDT&interval=1m&startTime=${startMinute * 1000}&limit=${limit}`;
  const rows = await fetchJson<Kline[]>(url, { limiter: binanceLimiter });
  const now = Date.now();
  return rows.map((k) => ({ minuteTs: k[0] / 1000, close: Number(k[4]), closed: k[6] < now }));
}

/**
 * SOL/USD close for every minute covering `timestamps` (unix s). Missing minutes are fetched from Binance in
 * 1,000-minute windows and cached (closed candles only). Returns minuteTs → close; minutes Binance can't
 * serve fall back to the nearest cached candle within 10 minutes, else are absent.
 */
export async function ensureSolUsd(timestamps: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!timestamps.length) return out;
  const minutes = [...new Set(timestamps.map(minuteOf))].sort((a, b) => a - b);
  const db = getDb();
  const lo = minutes[0] - MAX_GAP_SEC;
  const hi = minutes[minutes.length - 1] + MAX_GAP_SEC;
  const known = new Map<number, number>();
  // chunked range reads keep memory bounded for long backfills
  for (let start = lo; start <= hi; start += 30 * 86_400) {
    const rows = await db
      .select()
      .from(schema.solUsd1m)
      .where(and(gte(schema.solUsd1m.minuteTs, start), lte(schema.solUsd1m.minuteTs, Math.min(hi, start + 30 * 86_400 - 1))));
    for (const r of rows) known.set(r.minuteTs, r.close);
  }

  const missing = minutes.filter((m) => !known.has(m));
  for (let i = 0; i < missing.length; ) {
    const windowStart = missing[i];
    const fetched = await fetchWindow(windowStart);
    const closed = fetched.filter((k) => k.closed);
    for (const k of fetched) known.set(k.minuteTs, k.close);
    for (let j = 0; j < closed.length; j += 500) {
      const values = closed.slice(j, j + 500).map(({ minuteTs, close }) => ({ minuteTs, close }));
      await withBusyRetry(() => db.insert(schema.solUsd1m).values(values).onConflictDoNothing(), { label: "sol_usd insert" });
    }
    const windowEnd = windowStart + 999 * 60;
    while (i < missing.length && missing[i] <= windowEnd) i++;
  }

  const sortedKnown = [...known.keys()].sort((a, b) => a - b);
  for (const m of minutes) {
    const exact = known.get(m);
    if (exact != null) {
      out.set(m, exact);
      continue;
    }
    // nearest candle within tolerance (binary search)
    let l = 0;
    let r = sortedKnown.length - 1;
    while (l < r) {
      const mid = (l + r) >> 1;
      if (sortedKnown[mid] < m) l = mid + 1;
      else r = mid;
    }
    const candidates = [sortedKnown[l - 1], sortedKnown[l]].filter((x) => x != null && Math.abs(x - m) <= MAX_GAP_SEC);
    candidates.sort((a, b) => Math.abs(a - m) - Math.abs(b - m));
    if (candidates.length) out.set(m, known.get(candidates[0])!);
  }
  return out;
}

/** SOL/USD at a unix timestamp (minute close), or null if unavailable. */
export async function solUsdAt(ts: number): Promise<number | null> {
  return (await ensureSolUsd([ts])).get(minuteOf(ts)) ?? null;
}

/** Worker tick: cache the latest closed minutes. Returns the newest close. */
export async function refreshCurrentSolUsd(): Promise<number | null> {
  const start = minuteOf(Date.now() / 1000) - 5 * 60;
  const rows = await fetchWindow(start, 6);
  const closed = rows.filter((k) => k.closed);
  if (closed.length) {
    await getDb()
      .insert(schema.solUsd1m)
      .values(closed.map(({ minuteTs, close }) => ({ minuteTs, close })))
      .onConflictDoNothing();
  }
  return rows.length ? rows[rows.length - 1].close : null;
}

export { minuteOf };
