/**
 * Token safety for agent candidates: on-chain mint/freeze
 * authority, top-10 holder share excluding the bonding curve / pool, and the RugCheck 0–100 score. Called only for
 * candidates that already passed every market rule, so the RPC/RugCheck cost stays at a few calls per minute.
 */
import { PublicKey } from "@solana/web3.js";
import { jsonRpc, type RateLimiter } from "@/server/ingest/http";
import { fetchRugCheck } from "@/server/ingest/tokens";
import { PUMP_PROGRAM } from "./curve";

export interface SafetyInfo {
  mintRevoked: boolean | null;
  freezeRevoked: boolean | null;
  topHoldersPct: number | null; // top-10 holders, % of supply, excluding curve/pool accounts
  rugScore: number | null;
  decimals: number | null;
  checkedAt: number;
}

/** Token accounts owned by these never count as "holders" (AMM vault authorities). */
const AMM_AUTHORITIES = new Set([
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", // Raydium AMM v4
  "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL", // Raydium CPMM
  "WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh", // Raydium LaunchLab
]);

interface ParsedMint {
  value: { owner: string; data: { parsed?: { info?: { mintAuthority?: string | null; freezeAuthority?: string | null; supply?: string; decimals?: number } } } } | null;
}
interface LargestAccounts {
  value: { address: string; amount: string }[];
}
interface ParsedAccounts {
  value: ({ data: { parsed?: { info?: { owner?: string } } } } | null)[];
}

export function bondingCurvePda(mint: string): string {
  return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], new PublicKey(PUMP_PROGRAM))[0].toBase58();
}

const rugCache = new Map<string, { at: number; score: number | null }>();
const RUG_TTL_SEC = 6 * 3600;

export async function checkSafety(rpcUrl: string, limiter: RateLimiter, mint: string, excludeOwners: string[]): Promise<SafetyInfo> {
  const now = Math.floor(Date.now() / 1000);
  const mintInfo = await jsonRpc<ParsedMint>(rpcUrl, "getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }], limiter);
  const info = mintInfo.value?.data.parsed?.info;
  const mintRevoked = info ? info.mintAuthority == null : null;
  const freezeRevoked = info ? info.freezeAuthority == null : null;

  let topHoldersPct: number | null = null;
  const supply = info?.supply ? Number(info.supply) : 0;
  if (supply > 0) {
    const largest = await jsonRpc<LargestAccounts>(rpcUrl, "getTokenLargestAccounts", [mint, { commitment: "confirmed" }], limiter);
    const accounts = largest.value.slice(0, 20);
    const owners = accounts.length
      ? await jsonRpc<ParsedAccounts>(rpcUrl, "getMultipleAccounts", [accounts.map((a) => a.address), { encoding: "jsonParsed", commitment: "confirmed" }], limiter)
      : { value: [] };
    const excluded = new Set([...excludeOwners, ...AMM_AUTHORITIES]);
    let held = 0;
    let counted = 0;
    accounts.forEach((a, i) => {
      const owner = owners.value[i]?.data.parsed?.info?.owner;
      if (counted >= 10 || (owner && excluded.has(owner))) return;
      held += Number(a.amount);
      counted++;
    });
    topHoldersPct = (held / supply) * 100;
  }

  let rug = rugCache.get(mint);
  if (!rug || now - rug.at > (rug.score == null ? 600 : RUG_TTL_SEC)) {
    const r = await fetchRugCheck(mint).catch(() => null);
    rug = { at: now, score: r?.rugScore ?? null };
    rugCache.set(mint, rug);
  }
  return { mintRevoked, freezeRevoked, topHoldersPct, rugScore: rug.score, decimals: info?.decimals ?? null, checkedAt: now };
}
