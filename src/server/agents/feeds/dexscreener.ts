/** DexScreener tokens/v1 (keyless, 300 req/min, ≤30 mints per call): price, liquidity, MC, 5m flow, price change. */
import { fetchJson, RateLimiter } from "@/server/ingest/http";

interface DexPair {
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  txns?: { m5?: { buys?: number; sells?: number }; h1?: { buys?: number; sells?: number } };
  priceChange?: { m5?: number; h1?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

export interface DexSnapshot {
  mint: string;
  symbol: string | null;
  name: string | null;
  dexId: string | null; // "pumpfun" = still on the curve; "pumpswap", "raydium", "meteora", …
  pairAddress: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  mcUsd: number | null;
  buys5m: number | null;
  sells5m: number | null;
  change5mPct: number | null;
  change1hPct: number | null;
  pairCreatedAt: number | null; // unix s of the oldest pair
}

const limiter = new RateLimiter(3, 1_000);

export async function fetchDexSnapshots(mints: string[]): Promise<Map<string, DexSnapshot>> {
  const out = new Map<string, DexSnapshot>();
  for (let i = 0; i < mints.length; i += 30) {
    const batch = mints.slice(i, i + 30);
    const pairs = await fetchJson<DexPair[]>(`https://api.dexscreener.com/tokens/v1/solana/${batch.join(",")}`, { limiter, retries: 2, timeoutMs: 10_000 });
    const byMint = new Map<string, DexPair[]>();
    for (const p of pairs) {
      const m = p.baseToken?.address;
      if (m && batch.includes(m)) byMint.set(m, [...(byMint.get(m) ?? []), p]);
    }
    for (const [mint, list] of byMint) {
      // most liquid pair prices the token; flow counts sum over its pairs
      const best = [...list].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      const created = list.map((p) => p.pairCreatedAt).filter((x): x is number => typeof x === "number");
      const sum = (f: (p: DexPair) => number | undefined) => {
        const vals = list.map(f).filter((x): x is number => typeof x === "number");
        return vals.length ? vals.reduce((s, x) => s + x, 0) : null;
      };
      const price = best.priceUsd != null ? Number(best.priceUsd) : NaN;
      out.set(mint, {
        mint,
        symbol: best.baseToken?.symbol ?? null,
        name: best.baseToken?.name ?? null,
        dexId: best.dexId ?? null,
        pairAddress: best.pairAddress ?? null,
        priceUsd: Number.isFinite(price) && price > 0 ? price : null,
        liquidityUsd: sum((p) => p.liquidity?.usd),
        mcUsd: best.marketCap ?? best.fdv ?? null,
        buys5m: sum((p) => p.txns?.m5?.buys),
        sells5m: sum((p) => p.txns?.m5?.sells),
        change5mPct: best.priceChange?.m5 ?? null,
        change1hPct: best.priceChange?.h1 ?? null,
        pairCreatedAt: created.length ? Math.floor(Math.min(...created) / 1000) : null,
      });
    }
  }
  return out;
}
