/** Wallet history and trades are mainnet data; seats live on the configured seat cluster. */
const SEAT_CLUSTER = process.env.NEXT_PUBLIC_SOLANA_CLUSTER === "mainnet-beta" ? "mainnet-beta" : "devnet";

export function solscan(kind: "account" | "tx" | "token", id: string, network: "data" | "seats" = "data"): string {
  const suffix = network === "seats" && SEAT_CLUSTER === "devnet" ? "?cluster=devnet" : "";
  return `https://solscan.io/${kind}/${id}${suffix}`;
}

export const dexscreenerToken = (mint: string) => `https://dexscreener.com/solana/${mint}`;
export const pumpFunCoin = (mint: string) => `https://pump.fun/coin/${mint}`;
export const xStatusUrl = (tweetId: string) => `https://x.com/i/web/status/${tweetId}`;
