import bs58 from "bs58";
import { and, between, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { tokens, trades } from "@/db/schema";
import { env } from "@/lib/env";
import { jsonRpc } from "@/server/ingest/http";
import { ensureTokens } from "@/server/ingest/tokens";
import type { XTweet } from "./api";

/** One token referenced by a tweet (stored in tweets.mentions_json). */
export interface TweetMention {
  mint: string;
  symbol: string | null;
  source: "ca" | "url" | "cashtag";
  /** The text that produced the mention: the address, URL or "$TICKER". */
  raw: string;
  /** CA/URL resolve to an exact mint; cashtags are matched to a token the wallet traded within ±24h. */
  confidence: "high" | "medium";
}

const CA_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const URL_PATTERNS: { re: RegExp; kind: "mint" | "pair" }[] = [
  { re: /pump\.fun\/(?:coin\/)?([1-9A-HJ-NP-Za-km-z]{32,44})/, kind: "mint" },
  { re: /dexscreener\.com\/solana\/([1-9A-HJ-NP-Za-km-z]{32,44})/i, kind: "pair" },
  { re: /birdeye\.so\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})/, kind: "mint" },
];
const CASHTAG_WINDOW_SEC = 24 * 3600;

/** True when `s` decodes from base58 to exactly 32 bytes (a Solana public key). */
export function isPubkey(s: string): boolean {
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

/** Candidate CA strings and URL-derived ids from a tweet, before validation. Pure. */
export function scanTweet(tweet: Pick<XTweet, "text" | "entities">): {
  cas: string[];
  urls: { id: string; kind: "mint" | "pair"; url: string }[];
  cashtags: string[];
} {
  const expanded = (tweet.entities?.urls ?? []).map((u) => u.unwound_url ?? u.expanded_url ?? u.url);
  const urls: { id: string; kind: "mint" | "pair"; url: string }[] = [];
  for (const url of [...expanded, ...(tweet.text.match(/https?:\/\/\S+/g) ?? [])]) {
    for (const p of URL_PATTERNS) {
      const m = p.re.exec(url);
      if (m && isPubkey(m[1])) urls.push({ id: m[1], kind: p.kind, url });
    }
  }
  // Drop t.co shortlinks etc. from the text before scanning for bare addresses.
  const bare = tweet.text.replace(/https?:\/\/\S+/g, " ");
  const cas = [...new Set((bare.match(CA_RE) ?? []).filter(isPubkey))];
  const cashtags = [
    ...new Set(
      [
        ...(tweet.entities?.cashtags ?? []).map((c) => c.tag),
        ...[...tweet.text.matchAll(/\$([A-Za-z][A-Za-z0-9_]{0,14})\b/g)].map((m) => m[1]),
      ].map((t) => t.toUpperCase()),
    ),
  ];
  return { cas, urls, cashtags };
}

/** DexScreener pair → base token mint (free, no key). */
async function mintForPair(pair: string): Promise<string | null> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${pair}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { pairs?: { baseToken?: { address?: string } }[] | null; pair?: { baseToken?: { address?: string } } | null };
  return j.pair?.baseToken?.address ?? j.pairs?.[0]?.baseToken?.address ?? null;
}

const TOKEN_PROGRAMS: Record<string, true> = {
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: true,
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: true,
};

/** Addresses that are SPL / Token-2022 mint accounts on mainnet (getMultipleAccounts, jsonParsed). */
async function onChainMints(addresses: string[]): Promise<Set<string>> {
  const { HELIUS_API_KEY, DATA_RPC_URL } = env();
  const url = HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : DATA_RPC_URL;
  const mints = new Set<string>();
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    const res = await jsonRpc<{ value: ({ owner: string; data: { parsed?: { type?: string } } } | null)[] }>(
      url,
      "getMultipleAccounts",
      [chunk, { encoding: "jsonParsed", commitment: "confirmed" }],
    );
    res.value.forEach((acc, j) => {
      if (acc && TOKEN_PROGRAMS[acc.owner] && acc.data.parsed?.type === "mint") mints.add(chunk[j]);
    });
  }
  return mints;
}

/**
 * Resolve a tweet's token mentions for a brain:
 * - base58 CAs (32–44 chars, 32-byte key) that are a mint this wallet traded or already resolved, or
 *   that are verified as mint accounts on-chain and resolved by Jupiter/DexScreener (ensureTokens);
 * - pump.fun / dexscreener / birdeye token URLs (dexscreener pair → base mint);
 * - cashtags matched to a token this wallet traded within ±24h of the tweet (largest USD volume wins).
 */
export async function extractMentions(
  brainId: string,
  tweet: Pick<XTweet, "text" | "entities">,
  tweetMs: number,
): Promise<TweetMention[]> {
  const { cas, urls, cashtags } = scanTweet(tweet);
  const candidates = new Map<string, { source: "ca" | "url"; raw: string }>();
  for (const u of urls) {
    const mint = u.kind === "pair" ? ((await mintForPair(u.id)) ?? u.id) : u.id;
    if (!candidates.has(mint)) candidates.set(mint, { source: "url", raw: u.url });
  }
  for (const ca of cas) if (!candidates.has(ca)) candidates.set(ca, { source: "ca", raw: ca });

  const out: TweetMention[] = [];
  if (candidates.size) {
    const keys = [...candidates.keys()];
    const db = getDb();
    const [known, traded] = await Promise.all([
      db.select().from(tokens).where(inArray(tokens.mint, keys)),
      db.selectDistinct({ mint: trades.mint }).from(trades).where(and(eq(trades.brainId, brainId), inArray(trades.mint, keys))),
    ]);
    const tradedSet = new Set(traded.map((t) => t.mint));
    const rows = new Map(known.filter((r) => r.source !== "unresolved" || tradedSet.has(r.mint)).map((r) => [r.mint, r]));
    const unknown = keys.filter((k) => !rows.has(k));
    if (unknown.length) {
      const verified = [...(await onChainMints(unknown))];
      for (const [mint, r] of await ensureTokens(verified)) if (r.source !== "unresolved") rows.set(mint, r);
    }
    for (const [mint, c] of candidates) {
      const row = rows.get(mint);
      if (row) out.push({ mint, symbol: row.symbol ?? null, source: c.source, raw: c.raw, confidence: "high" });
    }
  }

  if (cashtags.length) {
    const t = Math.floor(tweetMs / 1000);
    const traded = await getDb()
      .select({ mint: trades.mint, symbol: tokens.symbol, usd: trades.usdValue })
      .from(trades)
      .innerJoin(tokens, eq(tokens.mint, trades.mint))
      .where(
        and(
          eq(trades.brainId, brainId),
          between(trades.blockTime, t - CASHTAG_WINDOW_SEC, t + CASHTAG_WINDOW_SEC),
          inArray(sql`upper(${tokens.symbol})`, cashtags),
        ),
      );
    const volume = new Map<string, { mint: string; symbol: string; usd: number }[]>();
    for (const r of traded) {
      if (!r.symbol) continue;
      const tag = r.symbol.toUpperCase();
      const list = volume.get(tag) ?? [];
      const hit = list.find((x) => x.mint === r.mint);
      if (hit) hit.usd += r.usd ?? 0;
      else list.push({ mint: r.mint, symbol: r.symbol, usd: r.usd ?? 0 });
      volume.set(tag, list);
    }
    for (const tag of cashtags) {
      const best = (volume.get(tag) ?? []).sort((a, b) => b.usd - a.usd)[0];
      if (best && !out.some((m) => m.mint === best.mint)) {
        out.push({ mint: best.mint, symbol: best.symbol, source: "cashtag", raw: `$${tag}`, confidence: "medium" });
      }
    }
  }
  return out;
}
