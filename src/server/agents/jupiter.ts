/**
 * Jupiter Swap API v1 (quote + swap transaction) and Tokens v2 lists for the agents process. One limiter for the whole
 * Jupiter host: keyless lite-api.jup.ag allows ~5 requests per ~10 s per IP (measured 2026-10-22, x-ratelimit-* headers),
 * shared with the worker's token enrichment; a JUPITER_API_KEY raises it to ~1 req/s on api.jup.ag.
 */
import { env } from "@/lib/env";
import { fetchJson, HttpError, RateLimiter } from "@/server/ingest/http";
import { jupiterDataBase, jupiterHeaders, jupiterSwapBase, SOL_MINT } from "./config";

let limiter: RateLimiter | null = null;
export function jupLimiter(): RateLimiter {
  limiter ??= env().JUPITER_API_KEY ? new RateLimiter(1, 1_050) : new RateLimiter(4, 10_500);
  return limiter;
}

export interface JupQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: { swapInfo: { label?: string; ammKey?: string }; percent: number }[];
  contextSlot?: number;
}

export class NoRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoRouteError";
  }
}

/** GET /quote. Throws NoRouteError when Jupiter can't route the pair (dead/unsupported token). */
export async function getQuote(p: { inputMint: string; outputMint: string; amount: string; slippageBps: number }): Promise<JupQuote> {
  const url = `${jupiterSwapBase()}/quote?inputMint=${p.inputMint}&outputMint=${p.outputMint}&amount=${p.amount}&slippageBps=${p.slippageBps}&restrictIntermediateTokens=true`;
  try {
    const q = await fetchJson<JupQuote & { error?: string }>(url, { limiter: jupLimiter(), init: { headers: jupiterHeaders() }, retries: 4, timeoutMs: 10_000 });
    if (!q.outAmount || q.outAmount === "0") throw new NoRouteError(q.error ?? "Jupiter returned no output amount");
    return q;
  } catch (err) {
    if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) {
      throw new NoRouteError(`no Jupiter route: ${err.message.slice(0, 200)}`);
    }
    throw err;
  }
}

export const buyQuote = (mint: string, lamports: number, slippageBps: number) =>
  getQuote({ inputMint: SOL_MINT, outputMint: mint, amount: String(lamports), slippageBps });
export const sellQuote = (mint: string, qtyRaw: string, slippageBps: number) =>
  getQuote({ inputMint: mint, outputMint: SOL_MINT, amount: qtyRaw, slippageBps });

/** POST /swap → base64 unsigned VersionedTransaction for `userPublicKey`. */
export async function buildSwapTransaction(quote: JupQuote, userPublicKey: string, maxPriorityFeeLamports: number): Promise<{ swapTransaction: string; lastValidBlockHeight: number }> {
  const body = {
    quoteResponse: quote,
    userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    dynamicSlippage: false,
    prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: maxPriorityFeeLamports, priorityLevel: "veryHigh" } },
  };
  return fetchJson<{ swapTransaction: string; lastValidBlockHeight: number }>(`${jupiterSwapBase()}/swap`, {
    limiter: jupLimiter(),
    retries: 3,
    timeoutMs: 15_000,
    init: { method: "POST", headers: { "content-type": "application/json", ...jupiterHeaders() }, body: JSON.stringify(body) },
  });
}

// ---------------------------------------------------------------- Tokens v2 (discovery lists)

export interface JupTokenStats {
  priceChange?: number;
  buyVolume?: number;
  sellVolume?: number;
  numBuys?: number;
  numSells?: number;
  numTraders?: number;
}

export interface JupListToken {
  id: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  launchpad?: string;
  holderCount?: number;
  mcap?: number;
  fdv?: number;
  usdPrice?: number;
  liquidity?: number;
  createdAt?: string;
  graduatedPool?: string;
  graduatedAt?: string;
  firstPool?: { id?: string; createdAt?: string };
  stats5m?: JupTokenStats;
  stats1h?: JupTokenStats;
  audit?: { mintAuthorityDisabled?: boolean; freezeAuthorityDisabled?: boolean; topHoldersPercentage?: number };
  organicScore?: number;
  tokenProgram?: string;
}

/** "recent" (newest pools) or "toptrending/5m" / "toptraded/1h" etc. */
export async function jupTokenList(path: string, limit = 50): Promise<JupListToken[]> {
  const url = `${jupiterDataBase()}/tokens/v2/${path}${path.includes("top") ? `?limit=${limit}` : ""}`;
  return fetchJson<JupListToken[]>(url, { limiter: jupLimiter(), init: { headers: jupiterHeaders() }, retries: 2, timeoutMs: 15_000 });
}
