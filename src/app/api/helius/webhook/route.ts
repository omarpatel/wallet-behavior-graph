/**
 * Helius `raw` webhook: getTransaction-shaped txs for tracked wallets.
 * Auth: constant-time compare of the Authorization header with HELIUS_WEBHOOK_AUTH (Helius has no HMAC).
 * Responds immediately; ingestion runs after the response via `after()`. Helius retries for 24 h, so
 * duplicates are expected: signatures are deduped per payload and trades by the trades_dedupe index.
 *
 * Loss guarantee: every write in the ingest path retries SQLITE_BUSY per statement (src/db/retry.ts) because the
 * worker can hold the write lock past the 5 s busy timeout. If ingest still fails, nothing is lost for good: this
 * path never moves a brain's live cursor (lastSlot/lastSignature), so the worker's reconcile (`pollBrain`, every
 * 10 min for the live tier) re-fetches everything after the cursor, including the trades this call dropped.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { ingestRawTransactions } from "@/server/ingest/pipeline";
import type { RawTx } from "@/server/ingest/normalize";

const RawTxSchema = z
  .object({
    slot: z.number(),
    blockTime: z.number().nullable().optional(),
    meta: z.object({ err: z.unknown(), fee: z.number(), preBalances: z.array(z.number()), postBalances: z.array(z.number()) }).passthrough().nullable(),
    transaction: z
      .object({
        signatures: z.array(z.string()).min(1),
        message: z.object({ accountKeys: z.array(z.unknown()), instructions: z.array(z.unknown()) }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

const Payload = z.array(z.unknown());

function authorized(header: string | null, secret: string): boolean {
  if (!header) return false;
  // hash both sides so lengths match and timing doesn't leak the secret length
  const a = createHash("sha256").update(header).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<Response> {
  const secret = env().HELIUS_WEBHOOK_AUTH;
  if (!secret || !authorized(request.headers.get("authorization"), secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const list = Payload.safeParse(body);
  if (!list.success) return Response.json({ error: "expected an array of transactions" }, { status: 400 });

  const seen = new Set<string>();
  const txs: RawTx[] = [];
  for (const item of list.data) {
    const parsed = RawTxSchema.safeParse(item);
    if (!parsed.success) continue;
    const sig = parsed.data.transaction.signatures[0];
    if (seen.has(sig)) continue;
    seen.add(sig);
    // shape validated above for the fields the router reads; the normalizer tolerates missing optionals
    const tx: RawTx = item as RawTx;
    txs.push(tx);
  }

  after(async () => {
    try {
      const res = await ingestRawTransactions(txs);
      if (res.trades) console.log(`[helius-webhook] ${txs.length} txs → ${res.trades} trades, ${res.alerts} alerts`);
    } catch (err) {
      console.error("[helius-webhook] ingest failed (the next reconcile pass re-fetches these txs)", err);
    }
  });
  return Response.json({ received: txs.length });
}
