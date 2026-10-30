/**
 * Token metadata + safety context: Jupiter Tokens API v2 (≤100 mints per call), DexScreener fallback
 * (≤30 mints per call). Upserts `tokens`.
 * RugCheck summary (keyless) adds a 0–100 risk score, LP-locked share and named risks, cached 6 h.
 */
import { and, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { withBusyRetry } from "@/db/retry";
import { env } from "@/lib/env";
import type { RugRisk } from "@/server/alerts/types";
import { fetchJson, HttpError, RateLimiter } from "./http";

export type TokenRow = typeof schema.tokens.$inferSelect;
type TokenInsert = typeof schema.tokens.$inferInsert;

const jupKeyed = new RateLimiter(1, 1100); // free key: 1 rps
const jupKeyless = new RateLimiter(1, 2100); // keyless: 0.5 rps
const dexLimiter = new RateLimiter(4, 1000); // 300 req/min

/** Rows that resolved nowhere are retried after this long. */
const UNRESOLVED_RETRY_SEC = 6 * 3600;

interface JupToken {
  id: string;
  name?: string;
  symbol?: string;
  icon?: string;
  decimals?: number;
  dev?: string;
  totalSupply?: number;
  launchpad?: string;
  holderCount?: number;
  mcap?: number;
  usdPrice?: number;
  liquidity?: number;
  organicScore?: number;
  createdAt?: string;
  firstPool?: { id?: string; createdAt?: string };
  audit?: { mintAuthorityDisabled?: boolean; freezeAuthorityDisabled?: boolean; topHoldersPercentage?: number };
}

interface DexPair {
  dexId?: string;
  baseToken?: { address: string; name?: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: { imageUrl?: string };
}

const isoToUnix = (s?: string) => {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

const nowSec = () => Math.floor(Date.now() / 1000);

async function fetchJupiter(mints: string[]): Promise<TokenInsert[]> {
  const key = env().JUPITER_API_KEY;
  const base = key ? "https://api.jup.ag" : "https://lite-api.jup.ag";
  const out: TokenInsert[] = [];
  for (let i = 0; i < mints.length; i += 100) {
    const batch = mints.slice(i, i + 100);
    const list = await fetchJson<JupToken[]>(`${base}/tokens/v2/search?query=${batch.join(",")}`, {
      limiter: key ? jupKeyed : jupKeyless,
      init: key ? { headers: { "x-api-key": key } } : undefined,
    });
    const wanted = new Set(batch);
    for (const t of list) {
      if (!wanted.has(t.id)) continue; // search may return fuzzy matches
      const createdAt = isoToUnix(t.createdAt);
      const poolAt = isoToUnix(t.firstPool?.createdAt);
      out.push({
        mint: t.id,
        symbol: t.symbol ?? null,
        name: t.name ?? null,
        icon: t.icon ?? null,
        decimals: t.decimals ?? null,
        totalSupply: t.totalSupply ?? null,
        launchpad: t.launchpad ?? null,
        createdAtTs: createdAt != null && poolAt != null ? Math.min(createdAt, poolAt) : (createdAt ?? poolAt),
        firstPoolCreatedAt: poolAt,
        dev: t.dev ?? null,
        liquidityUsd: t.liquidity ?? null,
        mcapUsd: t.mcap ?? null,
        usdPrice: t.usdPrice ?? null,
        holderCount: t.holderCount ?? null,
        organicScore: t.organicScore ?? null,
        topHoldersPct: t.audit?.topHoldersPercentage ?? null,
        mintAuthorityDisabled: t.audit?.mintAuthorityDisabled ?? null,
        freezeAuthorityDisabled: t.audit?.freezeAuthorityDisabled ?? null,
        source: "jupiter",
        updatedAt: nowSec(),
      });
    }
  }
  return out;
}

async function fetchDexScreener(mints: string[]): Promise<TokenInsert[]> {
  const out: TokenInsert[] = [];
  for (let i = 0; i < mints.length; i += 30) {
    const batch = mints.slice(i, i + 30);
    const pairs = await fetchJson<DexPair[]>(`https://api.dexscreener.com/tokens/v1/solana/${batch.join(",")}`, {
      limiter: dexLimiter,
    });
    const byMint = new Map<string, DexPair[]>();
    for (const p of pairs) {
      const m = p.baseToken?.address;
      if (!m || !batch.includes(m)) continue;
      byMint.set(m, [...(byMint.get(m) ?? []), p]);
    }
    for (const [mint, list] of byMint) {
      const best = [...list].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      const created = list.map((p) => p.pairCreatedAt).filter((x): x is number => typeof x === "number");
      const firstPool = created.length ? Math.floor(Math.min(...created) / 1000) : null;
      const price = best.priceUsd ? Number(best.priceUsd) : null;
      const fdv = best.fdv ?? null;
      out.push({
        mint,
        symbol: best.baseToken?.symbol ?? null,
        name: best.baseToken?.name ?? null,
        icon: best.info?.imageUrl ?? null,
        totalSupply: price && fdv ? fdv / price : null,
        launchpad: list.some((p) => p.dexId === "pumpfun") ? "pump.fun" : null,
        createdAtTs: firstPool,
        firstPoolCreatedAt: firstPool,
        liquidityUsd: list.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0),
        mcapUsd: best.marketCap ?? fdv,
        usdPrice: price,
        source: "dexscreener",
        updatedAt: nowSec(),
      });
    }
  }
  return out;
}

async function upsert(rows: TokenInsert[]): Promise<void> {
  const db = getDb();
  for (const row of rows) {
    const { mint, ...rest } = row;
    // never overwrite known values with nulls from a thinner source
    const set = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== null && v !== undefined));
    await withBusyRetry(() => db.insert(schema.tokens).values(row).onConflictDoUpdate({ target: schema.tokens.mint, set }), {
      label: "tokens upsert",
    });
  }
}

export interface EnsureTokensOptions {
  /** Refetch rows older than this (seconds). Default: only fetch unknown mints. */
  maxAgeSec?: number;
  /** Decimals observed on-chain, stored when no API knows the mint. */
  decimals?: Map<string, number>;
}

/**
 * Make sure `tokens` has fresh rows for `mints`. Jupiter first, DexScreener for the rest; mints neither knows get a
 * minimal row (source "unresolved", retried after 6 h). Returns resolved rows keyed by mint.
 */
export async function ensureTokens(mints: string[], opts: EnsureTokensOptions = {}): Promise<Map<string, TokenRow>> {
  const db = getDb();
  const unique = [...new Set(mints)];
  const result = new Map<string, TokenRow>();
  if (!unique.length) return result;

  const existing = new Map<string, TokenRow>();
  for (let i = 0; i < unique.length; i += 500) {
    const rows = await db.select().from(schema.tokens).where(inArray(schema.tokens.mint, unique.slice(i, i + 500)));
    for (const r of rows) existing.set(r.mint, r);
  }
  const now = nowSec();
  const stale = unique.filter((m) => {
    const r = existing.get(m);
    if (!r) return true;
    if (r.source === "unresolved") return now - r.updatedAt > UNRESOLVED_RETRY_SEC;
    return opts.maxAgeSec != null && now - r.updatedAt > opts.maxAgeSec;
  });

  if (stale.length) {
    const jup = await fetchJupiter(stale);
    const got = new Set(jup.map((r) => r.mint));
    const rest = stale.filter((m) => !got.has(m));
    const dex = rest.length ? await fetchDexScreener(rest) : [];
    for (const r of dex) got.add(r.mint);
    const unresolved: TokenInsert[] = stale
      .filter((m) => !got.has(m) && !existing.has(m))
      .map((mint) => ({ mint, decimals: opts.decimals?.get(mint) ?? null, source: "unresolved", updatedAt: now }));
    const touchedOnly = stale.filter((m) => !got.has(m) && existing.has(m));
    await upsert([...jup, ...dex.map((r) => ({ ...r, decimals: r.decimals ?? opts.decimals?.get(r.mint) ?? null })), ...unresolved]);
    if (touchedOnly.length) {
      await withBusyRetry(() => db.update(schema.tokens).set({ updatedAt: now }).where(inArray(schema.tokens.mint, touchedOnly)), {
        label: "tokens touch",
      });
    }
    const fresh = await db.select().from(schema.tokens).where(inArray(schema.tokens.mint, stale));
    for (const r of fresh) existing.set(r.mint, r);
  }
  for (const m of unique) {
    const r = existing.get(m);
    if (r && r.source !== "unresolved") result.set(m, r);
  }
  return result;
}

/** Worker tick: refresh safety context for mints traded by any brain in the last 24 h whose row is > 10 min old. */
export async function refreshStaleTokens(limit = 300): Promise<number> {
  const db = getDb();
  const since = nowSec() - 86_400;
  const recent = await db
    .selectDistinct({ mint: schema.trades.mint })
    .from(schema.trades)
    .where(gte(schema.trades.blockTime, since));
  if (!recent.length) return 0;
  const mints = recent.map((r) => r.mint);
  const old: string[] = [];
  for (let i = 0; i < mints.length && old.length < limit; i += 500) {
    const rows = await db
      .select({ mint: schema.tokens.mint })
      .from(schema.tokens)
      .where(and(inArray(schema.tokens.mint, mints.slice(i, i + 500)), lt(schema.tokens.updatedAt, nowSec() - 600)));
    old.push(...rows.map((r) => r.mint));
  }
  if (!old.length) return 0;
  await ensureTokens(old.slice(0, limit), { maxAgeSec: 600 });
  return Math.min(old.length, limit);
}

// ---------------------------------------------------------------- RugCheck

/** api.rugcheck.xyz advertises X-Rate-Limit-Limit: 15 (keyless); stay well under it. 429s pause via fetchJson. */
const rugLimiter = new RateLimiter(4, 1000);
export const RUGCHECK_TTL_SEC = 6 * 3600;

interface RugSummary {
  score?: number;
  score_normalised?: number;
  lpLockedPct?: number;
  risks?: { name?: string; value?: string; description?: string; level?: string }[];
}

export interface RugCheckResult {
  rugScore: number | null; // 0–100, higher = riskier
  lpLockedPct: number | null;
  risks: RugRisk[];
}

/** GET /v1/tokens/{mint}/report/summary. Null when RugCheck doesn't know the mint (4xx). */
export async function fetchRugCheck(mint: string): Promise<RugCheckResult | null> {
  let r: RugSummary;
  try {
    r = await fetchJson<RugSummary>(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, {
      limiter: rugLimiter,
      retries: 3,
      timeoutMs: 15_000,
    });
  } catch (err) {
    if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) return null;
    throw err;
  }
  // score_normalised is already 0–100 (observed: 1 for clean tokens, ~30 for a $500-liquidity pump coin)
  const norm = typeof r.score_normalised === "number" ? Math.round(Math.min(100, Math.max(0, r.score_normalised))) : null;
  return {
    rugScore: norm,
    lpLockedPct: typeof r.lpLockedPct === "number" ? r.lpLockedPct : null,
    risks: (r.risks ?? [])
      .filter((x) => x.name)
      .map((x) => ({ name: x.name!, level: x.level ?? "info", description: x.description ?? null, value: x.value ?? null })),
  };
}

/**
 * RugCheck the given mints whose check is missing or older than `maxAgeSec` (only mints that already have a tokens
 * row). Unknown mints are stamped too so they are retried after the TTL, not every tick. Returns mints checked.
 */
export async function ensureRugChecks(mints: string[], maxAgeSec = RUGCHECK_TTL_SEC): Promise<number> {
  const db = getDb();
  const unique = [...new Set(mints)];
  if (!unique.length) return 0;
  const cutoff = nowSec() - maxAgeSec;
  const stale: string[] = [];
  for (let i = 0; i < unique.length; i += 500) {
    const rows = await db
      .select({ mint: schema.tokens.mint })
      .from(schema.tokens)
      .where(
        and(
          inArray(schema.tokens.mint, unique.slice(i, i + 500)),
          or(isNull(schema.tokens.rugCheckedAt), lt(schema.tokens.rugCheckedAt, cutoff)),
        ),
      );
    stale.push(...rows.map((r) => r.mint));
  }
  let checked = 0;
  let failuresInRow = 0;
  for (const mint of stale) {
    let r: RugCheckResult | null;
    try {
      r = await fetchRugCheck(mint);
      failuresInRow = 0;
    } catch (err) {
      // RugCheck down/limited: leave the row due and stop after 3 failures in a row
      if (++failuresInRow >= 3) throw err;
      continue;
    }
    await db
      .update(schema.tokens)
      .set(
        r
          ? { rugScore: r.rugScore, lpLockedPct: r.lpLockedPct, rugRisksJson: JSON.stringify(r.risks), rugCheckedAt: nowSec() }
          : { rugCheckedAt: nowSec() },
      )
      .where(eq(schema.tokens.mint, mint));
    checked++;
  }
  return checked;
}

/**
 * Worker tick: RugCheck tokens in recent swarms first, then tokens any brain traded in the last 24 h,
 * at most `limit` calls per tick (6 h cache).
 */
export async function refreshRugChecks(limit = 120): Promise<number> {
  const db = getDb();
  const now = nowSec();
  const cutoff = now - RUGCHECK_TTL_SEC;
  const due = or(isNull(schema.tokens.rugCheckedAt), lt(schema.tokens.rugCheckedAt, cutoff));
  const swarmMints = await db
    .selectDistinct({ mint: schema.tokens.mint })
    .from(schema.swarms)
    .innerJoin(schema.tokens, eq(schema.tokens.mint, schema.swarms.mint))
    .where(and(gte(schema.swarms.lastJoinAt, now - 86_400), due))
    .limit(limit);
  const picked = new Set(swarmMints.map((r) => r.mint));
  if (picked.size < limit) {
    const traded = await db
      .selectDistinct({ mint: schema.tokens.mint })
      .from(schema.trades)
      .innerJoin(schema.tokens, eq(schema.tokens.mint, schema.trades.mint))
      .where(and(gte(schema.trades.blockTime, now - 86_400), due))
      .limit(limit - picked.size);
    for (const r of traded) picked.add(r.mint);
  }
  return ensureRugChecks([...picked]);
}
