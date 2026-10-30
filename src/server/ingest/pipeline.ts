/**
 * Ingestion pipeline: source → normalize → enrich → insert (dedupe on trades_dedupe) → alerts (live only).
 *
 * Lock contention: the site (webhook) and the worker write the same SQLite file. Every write here is a single
 * autocommit statement wrapped in withBusyRetry: a SQLITE_BUSY statement wrote nothing, so the retry is exact.
 * Retrying a whole ingest call instead would NOT be safe: trades are deduped by onConflictDoNothing and only the rows
 * returned as newly inserted get alerts, so trades inserted by a failed attempt would never be alerted on retry.
 */
import { and, eq, gt, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { withBusyRetry } from "@/db/retry";
import { env } from "@/lib/env";
import { createAlertsForTrades, type TradeRow } from "@/server/alerts";
import { BACKFILL_MAX_ATTEMPTS, BACKFILL_RETRY_BASE_SEC } from "@/server/directory/tracking";
import { recomputeProfile } from "@/server/profile";
import { WINDOW_DAYS } from "./constants";
import { enrichTrades } from "./enrich";
import { accountKeysOf, normalizeTransaction, type NormalizedTrade, type NormalizedTransfer, type RawTx } from "./normalize";
import { getTxSource, type Cursor } from "./sources";

type Brain = typeof schema.brains.$inferSelect;

export interface IngestResult {
  txs: number;
  trades: TradeRow[];
  transfers: number;
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** Normalize + enrich + insert one brain's txs. Returns only rows that were actually new. */
async function ingestForBrain(brain: Pick<Brain, "id" | "wallet">, txs: RawTx[], source: "backfill" | "live"): Promise<IngestResult> {
  const trades: NormalizedTrade[] = [];
  const transfers: NormalizedTransfer[] = [];
  for (const tx of txs) {
    const n = normalizeTransaction(tx, brain.wallet);
    trades.push(...n.trades);
    transfers.push(...n.transfers);
  }
  const db = getDb();
  const rows = await enrichTrades(brain.id, brain.wallet, trades, source);
  const inserted: TradeRow[] = [];
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    inserted.push(...(await withBusyRetry(() => db.insert(schema.trades).values(chunk).onConflictDoNothing().returning(), { label: "trades insert" })));
  }
  let transferCount = 0;
  for (let i = 0; i < transfers.length; i += 200) {
    const values = transfers.slice(i, i + 200).map((t) => ({
      brainId: brain.id,
      signature: t.signature,
      blockTime: t.blockTime,
      mint: t.mint,
      amount: t.amount,
      direction: t.direction,
    }));
    const res = await withBusyRetry(
      () => db.insert(schema.tokenTransfers).values(values).onConflictDoNothing().returning({ id: schema.tokenTransfers.id }),
      { label: "token_transfers insert" },
    );
    transferCount += res.length;
  }
  return { txs: txs.length, trades: inserted, transfers: transferCount };
}

async function loadBrain(id: string): Promise<Brain> {
  const [brain] = await getDb().select().from(schema.brains).where(eq(schema.brains.id, id));
  if (!brain) throw new Error(`Unknown brain ${id}`);
  return brain;
}

/**
 * The live cursor (lastSlot/lastSignature) is written only here, by backfill and by pollBrain (worker reconcile),
 * and only after that fetch's trades are committed. The webhook path never touches it, so a failed webhook ingest
 * leaves the cursor behind the lost trades and the next reconcile (every 10 min for the live tier) re-fetches them.
 */
async function saveCursor(id: string, cursor: Cursor | null): Promise<void> {
  if (!cursor) return;
  await withBusyRetry(
    () => getDb().update(schema.brains).set({ lastSignature: cursor.signature, lastSlot: cursor.slot }).where(eq(schema.brains.id, id)),
    { label: "cursor update" },
  );
}

/**
 * First-time history pull (trailing 90 days, capped at BACKFILL_MAX_TXS newest txs), then profile.
 * Backfill rows never alert. On failure the brain goes to "error" with an attempt count and a retry time.
 */
export async function backfillBrain(id: string): Promise<IngestResult & { scannedSignatures: number }> {
  const db = getDb();
  const brain = await loadBrain(id);
  await db.update(schema.brains).set({ backfillStatus: "running", backfillError: null }).where(eq(schema.brains.id, id));
  try {
    const res = await getTxSource().backfill(brain.wallet, {
      maxTxs: env().BACKFILL_MAX_TXS,
      sinceTs: nowSec() - WINDOW_DAYS * 86_400,
    });
    const out = await ingestForBrain(brain, res.txs, "backfill");
    // keep a newer live cursor if polling already advanced it
    if (!brain.lastSlot || (res.cursor && res.cursor.slot > brain.lastSlot)) await saveCursor(id, res.cursor);
    await withBusyRetry(
      () =>
        db
          .update(schema.brains)
          .set({ backfillStatus: "done", backfillError: null, backfillAttempts: 0, backfillRetryAt: null })
          .where(eq(schema.brains.id, id)),
      { label: "backfill done" },
    );
    await recomputeProfile(id);
    return { ...out, scannedSignatures: res.scannedSignatures };
  } catch (err) {
    const attempts = brain.backfillAttempts + 1;
    await withBusyRetry(
      () =>
        db
          .update(schema.brains)
          .set({
            backfillStatus: "error",
            backfillError: err instanceof Error ? err.message.slice(0, 500) : String(err),
            backfillAttempts: attempts,
            backfillRetryAt: attempts < BACKFILL_MAX_ATTEMPTS ? nowSec() + BACKFILL_RETRY_BASE_SEC * attempts : null,
          })
          .where(eq(schema.brains.id, id)),
      { label: "backfill error" },
    );
    throw err;
  }
}

/**
 * Live mode for one brain: everything after the stored cursor (RPC: getSignaturesForAddress until=lastSignature;
 * Helius: gTFA slot > lastSlot). New live trades create alerts. The cursor is saved only after the trades are
 * inserted; if ingest throws, it stays put and the next poll re-fetches the same range. `incomplete` = the fetch
 * stopped at a failed page after partial progress (resumed next poll).
 */
export async function pollBrain(id: string): Promise<IngestResult & { alerts: number; skipped: number; incomplete?: string }> {
  const brain = await loadBrain(id);
  const cursor = brain.lastSignature && brain.lastSlot != null ? { signature: brain.lastSignature, slot: brain.lastSlot } : null;
  const res = await getTxSource().since(brain.wallet, cursor);
  const out = await ingestForBrain(brain, res.txs, "live");
  if (res.cursor && res.cursor.signature !== cursor?.signature) await saveCursor(id, res.cursor);
  const alerts = await createAlertsForTrades(out.trades);
  return { ...out, alerts, skipped: res.skipped ?? 0, incomplete: res.incomplete };
}

/**
 * Helius raw webhook entry: route each tx to every tracked brain whose wallet it touches (account keys or
 * token-balance owners), dedupe by signature, insert as live, alert. Never moves a brain's live cursor (see
 * saveCursor): whatever a failed call loses is re-fetched by the worker's reconcile pass.
 */
export async function ingestRawTransactions(txs: RawTx[]): Promise<{ trades: number; alerts: number }> {
  const seen = new Set<string>();
  const unique = txs.filter((tx) => {
    const sig = tx?.transaction?.signatures?.[0];
    if (!sig || seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
  if (!unique.length) return { trades: 0, alerts: 0 };

  const touched = new Set<string>();
  for (const tx of unique) {
    for (const k of accountKeysOf(tx)) touched.add(k);
    for (const b of [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]) if (b.owner) touched.add(b.owner);
  }
  const db = getDb();
  const candidates = [...touched];
  const brains: Pick<Brain, "id" | "wallet">[] = [];
  for (let i = 0; i < candidates.length; i += 500) {
    brains.push(
      ...(await db
        .select({ id: schema.brains.id, wallet: schema.brains.wallet })
        .from(schema.brains)
        .where(inArray(schema.brains.wallet, candidates.slice(i, i + 500)))),
    );
  }
  let trades = 0;
  let alerts = 0;
  for (const brain of brains) {
    const mine = unique.filter((tx) => {
      if (accountKeysOf(tx).includes(brain.wallet)) return true;
      return [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])].some((b) => b.owner === brain.wallet);
    });
    const out = await ingestForBrain(brain, mine, "live");
    trades += out.trades.length;
    alerts += await createAlertsForTrades(out.trades);
  }
  return { trades, alerts };
}

/** Brains (backfilled) with trades inserted after their last profile computation, at most once per `debounceSec`. */
export async function brainsNeedingProfile(debounceSec: number): Promise<string[]> {
  const db = getDb();
  const now = nowSec();
  const done = await db
    .select({ id: schema.brains.id, profileUpdatedAt: schema.brains.profileUpdatedAt })
    .from(schema.brains)
    .where(eq(schema.brains.backfillStatus, "done"));
  const out: string[] = [];
  for (const b of done) {
    const since = b.profileUpdatedAt ?? 0;
    if (now - since < debounceSec) continue;
    const [fresh] = await db
      .select({ id: schema.trades.id })
      .from(schema.trades)
      .where(and(eq(schema.trades.brainId, b.id), gt(schema.trades.createdAt, since)))
      .limit(1);
    if (fresh || b.profileUpdatedAt == null) out.push(b.id);
  }
  return out;
}
