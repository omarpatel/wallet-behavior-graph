/**
 * Trade enrichment: SOL/USD at the trade minute, USD/SOL value, execution price, market cap
 * (price × total supply), launchpad, token creation time, entry delay.
 */
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { MIN_PRICED_SOL } from "./constants";
import type { NormalizedTrade } from "./normalize";
import { ensureSolUsd, minuteOf } from "./solusd";
import { ensureTokens } from "./tokens";

export type TradeInsert = typeof schema.trades.$inferInsert;

/** Counter-token prices for token→token swaps are taken from the wallet's own trades within this window. */
const COUNTER_PRICE_WINDOW_SEC = 6 * 3600;
/** Token creation timestamps can be a little late (minute-rounded indexers); tolerate this much skew. */
const CREATION_SKEW_SEC = 120;

export async function enrichTrades(
  brainId: string,
  wallet: string,
  normalized: NormalizedTrade[],
  source: "backfill" | "live",
): Promise<TradeInsert[]> {
  if (!normalized.length) return [];
  const decimals = new Map(normalized.map((t) => [t.mint, t.decimals]));
  const tokenRows = await ensureTokens([...decimals.keys()], {
    decimals,
    // live alerts need current safety context
    maxAgeSec: source === "live" ? 600 : undefined,
  });
  const solUsd = await ensureSolUsd(normalized.map((t) => t.blockTime));
  const now = Math.floor(Date.now() / 1000);

  const rows: TradeInsert[] = normalized.map((t) => {
    const rate = solUsd.get(minuteOf(t.blockTime)) ?? null;
    let usd: number | null = null;
    let sol: number | null = null;
    if (t.quoteMint === "SOL") {
      sol = t.quoteAmount;
      usd = rate != null ? t.quoteAmount * rate : null;
    } else if (t.quoteMint === "USDC" || t.quoteMint === "USDT") {
      usd = t.quoteAmount;
      sol = rate ? t.quoteAmount / rate : null;
    }
    return {
      brainId,
      wallet,
      signature: t.signature,
      slot: t.slot,
      txIndex: t.txIndex,
      blockTime: t.blockTime,
      side: t.side,
      mint: t.mint,
      tokenAmount: t.tokenAmount,
      quoteMint: t.quoteMint,
      quoteAmount: t.quoteAmount,
      solValue: sol,
      usdValue: usd,
      feesSol: t.feesSol,
      solUsd: rate,
      venue: t.venue,
      source,
    };
  });

  // token→token legs: value the counter-token at the wallet's own nearest execution price
  const db = getDb();
  for (const r of rows) {
    if (r.usdValue != null || r.quoteMint === "SOL" || r.quoteMint === "USDC" || r.quoteMint === "USDT") continue;
    const counter = r.quoteMint;
    const fromBatch = rows
      .filter((o) => o !== r && o.mint === counter && o.usdValue != null && Math.abs(o.blockTime - r.blockTime) <= COUNTER_PRICE_WINDOW_SEC)
      .sort((a, b) => Math.abs(a.blockTime - r.blockTime) - Math.abs(b.blockTime - r.blockTime))[0];
    let price = fromBatch ? fromBatch.usdValue! / fromBatch.tokenAmount : null;
    if (price == null) {
      const [prior] = await db
        .select({ priceUsd: schema.trades.priceUsd })
        .from(schema.trades)
        .where(
          and(
            eq(schema.trades.wallet, wallet),
            eq(schema.trades.mint, counter),
            gte(schema.trades.blockTime, r.blockTime - COUNTER_PRICE_WINDOW_SEC),
            lte(schema.trades.blockTime, r.blockTime + COUNTER_PRICE_WINDOW_SEC),
          ),
        )
        .orderBy(desc(schema.trades.blockTime))
        .limit(1);
      price = prior?.priceUsd ?? null;
    }
    if (price == null && now - r.blockTime < 600) {
      const counterRow = (await ensureTokens([counter])).get(counter);
      price = counterRow?.usdPrice ?? null;
    }
    if (price != null) {
      r.usdValue = r.quoteAmount * price;
      r.solValue = r.solUsd ? r.usdValue / r.solUsd : null;
    }
  }

  for (const r of rows) {
    const token = tokenRows.get(r.mint);
    const priceable = r.usdValue != null && r.tokenAmount > 0 && (r.solValue == null || r.solValue >= MIN_PRICED_SOL);
    r.priceUsd = priceable ? r.usdValue! / r.tokenAmount : null;
    r.mcUsd = r.priceUsd != null && token?.totalSupply ? r.priceUsd * token.totalSupply : null;
    r.launchpad = token?.launchpad ?? null;
    r.tokenCreatedAt = token?.createdAtTs ?? null;
    if (r.side === "buy" && r.tokenCreatedAt != null) {
      const delay = r.blockTime - r.tokenCreatedAt;
      r.entryDelaySec = delay >= 0 ? delay : delay >= -CREATION_SKEW_SEC ? 0 : null;
    }
  }
  return rows;
}
