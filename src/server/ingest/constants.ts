/** Mints and program IDs used by the normalizer and enrichment. */

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

export type QuoteSymbol = "SOL" | "USDC" | "USDT";

/** Quote assets: their deltas price a trade instead of being traded themselves. */
export const QUOTE_MINTS: Record<string, QuoteSymbol> = {
  [WSOL_MINT]: "SOL",
  [USDC_MINT]: "USDC",
  [USDT_MINT]: "USDT",
};

export type Venue =
  | "pump_curve"
  | "pumpswap"
  | "raydium"
  | "raydium_launchlab"
  | "meteora"
  | "meteora_dbc"
  | "orca"
  | "moonshot"
  | "jupiter"
  | "unknown";

/** DEX / launchpad program → venue. */
export const VENUE_PROGRAMS: Record<string, Venue> = {
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump_curve",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "pumpswap",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "raydium", // AMM v4
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "raydium", // CPMM
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "raydium", // CLMM
  LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj: "raydium_launchlab", // letsbonk
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "meteora", // DLMM
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: "meteora", // dynamic AMM pools
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: "meteora", // DAMM v2
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: "meteora_dbc",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "orca",
  MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG: "moonshot",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "jupiter",
};

/** Order used when several AMMs appear without an aggregator (most specific launch venue first). */
export const VENUE_PRIORITY: readonly Venue[] = [
  "pump_curve",
  "pumpswap",
  "raydium_launchlab",
  "meteora_dbc",
  "moonshot",
  "raydium",
  "meteora",
  "orca",
];

/** Jito tip accounts: tips paid by the wallet count as trading cost (feesSol), not quote. */
export const JITO_TIP_ACCOUNTS: Record<string, true> = {
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5": true,
  HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe: true,
  Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY: true,
  ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49: true,
  DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh: true,
  ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt: true,
  DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL: true,
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT": true,
};

/** Trailing window used by backfill and the profile engine. */
export const WINDOW_DAYS = 90;

/**
 * Below this size, per-transaction fixed costs routed through the quote (router/platform minimums) dominate
 * the execution price (observed: 0.0016 SOL micro-buys priced ~3.7× the market). Such trades get no price/MC
 * and are excluded from sizing statistics.
 */
export const MIN_PRICED_SOL = 0.01;
