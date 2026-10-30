/** Agent runtime configuration derived from env (src/lib/env.ts). Mainnet only: agents never touch SOLANA_CLUSTER. */
import { env } from "@/lib/env";
import { LAMPORTS_PER_SOL } from "./strategy";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

/** Mainnet RPC for agent wallets: AGENT_RPC_URL, else Helius mainnet, else DATA_RPC_URL. */
export function agentRpcUrl(): string {
  const e = env();
  if (e.AGENT_RPC_URL) return e.AGENT_RPC_URL;
  if (e.HELIUS_API_KEY) return `https://mainnet.helius-rpc.com/?api-key=${e.HELIUS_API_KEY}`;
  return e.DATA_RPC_URL;
}

export function jupiterSwapBase(): string {
  const e = env();
  return (e.JUPITER_SWAP_API ?? (e.JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1")).replace(/\/$/, "");
}

export function jupiterHeaders(): Record<string, string> {
  const key = env().JUPITER_API_KEY;
  return key ? { "x-api-key": key } : {};
}

/** Base for Jupiter tokens/price APIs (same key rule). */
export function jupiterDataBase(): string {
  return env().JUPITER_API_KEY ? "https://api.jup.ag" : "https://lite-api.jup.ag";
}

export function maxDepositLamports(): number {
  return Math.round(env().AGENT_MAX_DEPOSIT_SOL * LAMPORTS_PER_SOL);
}

/** Never act on a price older than this (stale-price guard). */
export const PRICE_MAX_AGE_SEC = 30;
/** Base network fee per signature. */
export const BASE_FEE_LAMPORTS = 5_000;
/** Rent locked in a token account opened by a buy (refunded when the account is closed after a full exit). */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280;
/** Rent-exempt minimum of a plain system account. */
export const SYSTEM_RENT_EXEMPT_LAMPORTS = 890_880;
/** SOL kept in a live wallet for fees + token-account rent so exits can always be paid for. */
export const LIVE_FEE_RESERVE_LAMPORTS = 20_000_000;
