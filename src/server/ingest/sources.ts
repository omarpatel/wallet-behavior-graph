/**
 * Wallet transaction sources. Both return getTransaction-shaped txs (jsonParsed,
 * maxSupportedTransactionVersion 1) ordered by (slot, transactionIndex) ascending.
 *
 * - Helius (`HELIUS_API_KEY`): getTransactionsForAddress full mode.
 * - Plain RPC (`DATA_RPC_URL`): getSignaturesForAddress + getTransaction, rate-limited for public endpoints
 *   (≈40 req/10 s per method, 100 req/10 s per IP). Failed signatures are dropped before any getTransaction.
 *
 * Note: popular wallets receive a constant stream of copy-bot / spam transactions that reference them
 * without moving their balances. The normalizer ignores those; the fetch budget still counts them.
 */
import { env } from "@/lib/env";
import { jsonRpc, RateLimiter, RpcError } from "./http";
import type { RawTx } from "./normalize";

export interface Cursor {
  signature: string;
  slot: number;
}

export interface FetchResult {
  txs: RawTx[];
  /** Newest position covered by this fetch (live cursor). null when the wallet has no history. */
  cursor: Cursor | null;
  scannedSignatures: number;
  /** Successful signatures not fetched because a live poll exceeded its budget (flooded wallets). */
  skipped?: number;
  /** A live fetch stopped at a failed page; `txs`/`cursor` cover the pages before it and the next poll resumes there. */
  incomplete?: string;
}

export interface TxSource {
  readonly name: "helius" | "rpc";
  /** Newest-first history within `sinceTs`, capped at `maxTxs`, returned ascending. */
  backfill(wallet: string, opts: { maxTxs: number; sinceTs: number }): Promise<FetchResult>;
  /** Everything after `cursor` (live mode). With a null cursor only establishes the cursor. */
  since(wallet: string, cursor: Cursor | null, opts?: { maxTxs?: number }): Promise<FetchResult>;
}

const TX_CONFIG = {
  encoding: "jsonParsed",
  maxSupportedTransactionVersion: 1,
  commitment: "confirmed",
} as const;

const byPosition = (a: RawTx, b: RawTx) =>
  a.slot - b.slot || (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0);

// ---------------------------------------------------------------- plain RPC

interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
  blockTime: number | null;
  transactionIndex?: number;
}

/**
 * Process-wide limiters for the data RPC. The public mainnet endpoint documents 40 req/10 s per method, but in
 * practice (measured 2026-10-20) it starts returning 429 + `Retry-After: 10` after ~10 jsonParsed getTransaction
 * calls in 10 s, so it gets an even ~0.9 req/s. Private RPCs (any other DATA_RPC_URL) get the documented 40/10 s with headroom.
 */
function limitersFor(url: string) {
  if (/api\.mainnet-beta\.solana\.com/.test(url)) {
    // one shared, evenly spread budget: bursts of 9 already trip the per-IP limiter
    const shared = new RateLimiter(1, 1100);
    return { signatures: shared, transaction: shared };
  }
  return { signatures: new RateLimiter(35, 10_000), transaction: new RateLimiter(35, 10_000) };
}

const MAX_SIGNATURE_PAGES = 50;
const TX_FETCH_CONCURRENCY = 3;
const DEFAULT_LIVE_MAX_TXS = 25;
const LIVE_SIGNATURE_PAGES = 5;

class RpcSource implements TxSource {
  readonly name = "rpc" as const;
  private readonly limiters: ReturnType<typeof limitersFor>;
  constructor(private readonly url: string) {
    this.limiters = limitersFor(url);
  }

  private async signaturesPage(wallet: string, opts: { before?: string; until?: string }) {
    return jsonRpc<SignatureInfo[]>(
      this.url,
      "getSignaturesForAddress",
      [wallet, { limit: 1000, commitment: "confirmed", ...opts }],
      this.limiters.signatures,
    );
  }

  private async fetchTxs(sigs: SignatureInfo[]): Promise<RawTx[]> {
    const out: RawTx[] = [];
    let next = 0;
    const worker = async () => {
      while (next < sigs.length) {
        const s = sigs[next++];
        let tx: RawTx | null = null;
        for (let attempt = 0; attempt < 3 && !tx; attempt++) {
          try {
            tx = await jsonRpc<RawTx | null>(this.url, "getTransaction", [s.signature, TX_CONFIG], this.limiters.transaction);
            if (!tx) break; // not found at this commitment (very recent); skipped
          } catch (err) {
            if (err instanceof RpcError && attempt < 2) continue;
            throw err;
          }
        }
        if (tx) out.push({ ...tx, transactionIndex: tx.transactionIndex ?? s.transactionIndex });
      }
    };
    await Promise.all(Array.from({ length: Math.min(TX_FETCH_CONCURRENCY, sigs.length) }, worker));
    return out.sort(byPosition);
  }

  async backfill(wallet: string, opts: { maxTxs: number; sinceTs: number }): Promise<FetchResult> {
    const wanted: SignatureInfo[] = [];
    let cursor: Cursor | null = null;
    let before: string | undefined;
    let scanned = 0;
    scan: for (let page = 0; page < MAX_SIGNATURE_PAGES; page++) {
      const sigs = await this.signaturesPage(wallet, { before });
      if (!sigs.length) break;
      cursor ??= { signature: sigs[0].signature, slot: sigs[0].slot };
      for (const s of sigs) {
        scanned++;
        if (s.blockTime != null && s.blockTime < opts.sinceTs) break scan;
        if (s.err) continue;
        wanted.push(s);
        if (wanted.length >= opts.maxTxs) break scan;
      }
      if (sigs.length < 1000) break;
      before = sigs[sigs.length - 1].signature;
    }
    return { txs: await this.fetchTxs(wanted), cursor, scannedSignatures: scanned };
  }

  async since(wallet: string, cursor: Cursor | null, opts: { maxTxs?: number } = {}): Promise<FetchResult> {
    const maxTxs = opts.maxTxs ?? DEFAULT_LIVE_MAX_TXS;
    if (!cursor) {
      const [newest] = await jsonRpc<SignatureInfo[]>(
        this.url,
        "getSignaturesForAddress",
        [wallet, { limit: 1, commitment: "confirmed" }],
        this.limiters.signatures,
      );
      return { txs: [], cursor: newest ? { signature: newest.signature, slot: newest.slot } : null, scannedSignatures: 0 };
    }
    // newest-first pages down to (excluding) the cursor
    const fresh: SignatureInfo[] = [];
    let before: string | undefined;
    for (let page = 0; page < LIVE_SIGNATURE_PAGES; page++) {
      const sigs = await this.signaturesPage(wallet, { until: cursor.signature, before });
      fresh.push(...sigs);
      if (sigs.length < 1000) break;
      before = sigs[sigs.length - 1].signature;
    }
    if (!fresh.length) return { txs: [], cursor, scannedSignatures: 0 };
    fresh.sort((a, b) => a.slot - b.slot || (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0));
    const newest = fresh[fresh.length - 1];
    const ok = fresh.filter((s) => !s.err);
    // Flooded wallets (copy-bot spam) can produce more successful txs per poll than a public RPC can fetch.
    // Live alerts care about the newest activity, so keep the newest slice and move the cursor to the head;
    // the skipped count is reported so operators can switch to Helius for such wallets.
    const slice = ok.length > maxTxs ? ok.slice(-maxTxs) : ok;
    return {
      txs: await this.fetchTxs(slice),
      cursor: { signature: newest.signature, slot: newest.slot },
      scannedSignatures: fresh.length,
      skipped: ok.length - slice.length,
    };
  }
}

// ---------------------------------------------------------------- Helius gTFA

interface GtfaResult {
  data: RawTx[];
  paginationToken: string | null;
}

/** Helius Developer plan: 50 RPC rps; stay well below on any plan (Free = 10 rps). */
const heliusLimiter = new RateLimiter(8, 1000);

/**
 * Only txs that move a token in/out of the wallet. Every swap does; the copy-bot / lamport spam that floods
 * busy trading wallets (~60 tx/min on the busiest) does not. Measured on such a wallet: 0/100 → 35/100 txs signed by it.
 * Helius requires finalized commitment for `tokenTransfer` (~13 s behind confirmed; live alerts come from the webhook).
 */
const GTFA_FILTERS = { status: "succeeded", tokenAccounts: "balanceChanged", tokenTransfer: { direction: "any" } } as const;
const GTFA_FULL_PAGE = 100;

class HeliusSource implements TxSource {
  readonly name = "helius" as const;
  private readonly url: string;
  constructor(apiKey: string) {
    this.url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  }

  /**
   * Full-mode pages are capped at GTFA_FULL_PAGE txs: a 1000-tx jsonParsed page is ~20 MB (measured on swonzon,
   * 2026-10-22) and one stalled body read used to fail the whole backfill/reconcile; 100 txs ≈ 1.5–2 MB.
   */
  private gtfa(wallet: string, opts: Record<string, unknown>) {
    return jsonRpc<GtfaResult>(
      this.url,
      "getTransactionsForAddress",
      [wallet, { transactionDetails: "full", ...TX_CONFIG, limit: GTFA_FULL_PAGE, ...opts }],
      heliusLimiter,
    );
  }

  async backfill(wallet: string, opts: { maxTxs: number; sinceTs: number }): Promise<FetchResult> {
    const txs: RawTx[] = [];
    let paginationToken: string | undefined;
    do {
      const page = await this.gtfa(wallet, {
        commitment: "finalized",
        sortOrder: "desc",
        limit: Math.min(GTFA_FULL_PAGE, opts.maxTxs - txs.length),
        paginationToken,
        filters: { ...GTFA_FILTERS, blockTime: { gte: opts.sinceTs } },
      });
      txs.push(...page.data);
      paginationToken = page.paginationToken ?? undefined;
    } while (paginationToken && txs.length < opts.maxTxs);
    txs.sort(byPosition);
    const newest = txs[txs.length - 1];
    const cursor = newest ? { signature: newest.transaction.signatures[0], slot: newest.slot } : await this.newestCursor(wallet);
    return { txs, cursor, scannedSignatures: txs.length };
  }

  private async newestCursor(wallet: string): Promise<Cursor | null> {
    const res = await jsonRpc<{ data: { signature: string; slot: number }[] }>(
      this.url,
      "getTransactionsForAddress",
      [wallet, { transactionDetails: "signatures", sortOrder: "desc", limit: 1 }],
      heliusLimiter,
    );
    const s = res.data[0];
    return s ? { signature: s.signature, slot: s.slot } : null;
  }

  /**
   * Ascending pages after the cursor, at most `maxTxs` per call. When the call stops early (budget reached, or a page
   * failed after earlier pages succeeded) it returns everything fetched, but the cursor stops at the last tx before
   * the newest fetched slot: the filter is `slot > cursor.slot`, so a slot split across pages is re-read whole by the
   * next poll (re-inserts dedupe on trades_dedupe and don't re-alert). `incomplete` carries the page error.
   */
  async since(wallet: string, cursor: Cursor | null, opts: { maxTxs?: number } = {}): Promise<FetchResult> {
    if (!cursor) return { txs: [], cursor: await this.newestCursor(wallet), scannedSignatures: 0 };
    const maxTxs = opts.maxTxs ?? 5000;
    const txs: RawTx[] = [];
    let paginationToken: string | undefined;
    let incomplete: string | undefined;
    do {
      let page: GtfaResult;
      try {
        page = await this.gtfa(wallet, {
          commitment: "finalized",
          sortOrder: "asc",
          paginationToken,
          filters: { ...GTFA_FILTERS, slot: { gt: cursor.slot } },
        });
      } catch (err) {
        if (!txs.length) throw err;
        incomplete = err instanceof Error ? err.message : String(err);
        break;
      }
      txs.push(...page.data);
      paginationToken = page.paginationToken ?? undefined;
    } while (paginationToken && txs.length < maxTxs);
    txs.sort(byPosition);
    let head: RawTx | undefined = txs[txs.length - 1];
    if (head && (paginationToken || incomplete)) {
      const lastSlot = head.slot;
      head = txs.findLast((t) => t.slot < lastSlot);
    }
    return {
      txs,
      cursor: head ? { signature: head.transaction.signatures[0], slot: head.slot } : cursor,
      scannedSignatures: txs.length,
      ...(incomplete ? { incomplete } : {}),
    };
  }
}

let cached: TxSource | undefined;

/** Helius when `HELIUS_API_KEY` is set, otherwise the plain RPC at `DATA_RPC_URL`. */
export function getTxSource(): TxSource {
  if (!cached) {
    const { HELIUS_API_KEY, DATA_RPC_URL } = env();
    cached = HELIUS_API_KEY ? new HeliusSource(HELIUS_API_KEY) : new RpcSource(DATA_RPC_URL);
  }
  return cached;
}
