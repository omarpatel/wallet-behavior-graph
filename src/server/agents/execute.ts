/**
 * Order execution. Every order is a row in agent_orders keyed by (agent, clientKey) BEFORE anything is quoted or sent,
 * so the same intent can never execute twice; a retry after a failure uses a new attempt suffix (`…#2`).
 *
 * Paper: fill at a real Jupiter quote, minus a modelled-latency haircut (curve 150 bps, pools 50 bps), minus the
 * network fee, priority fee and token-account rent the live path would pay. Live: Jupiter swap/v1 transaction signed
 * with the agent key; the signature is stored (status "sent") before broadcast, the same bytes are re-broadcast until
 * confirmed or the blockhash expires, and the fill is read from the transaction meta (actual in/out).
 */
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { and, desc, eq, inArray, like, lt } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { withBusyRetry } from "@/db/retry";
import { BASE_FEE_LAMPORTS, LIVE_FEE_RESERVE_LAMPORTS, TOKEN_ACCOUNT_RENT_LAMPORTS } from "./config";
import { buildSwapTransaction, buyQuote, type JupQuote, NoRouteError, sellQuote } from "./jupiter";
import { agentConnection, closeTokenAccountIx, confirmSignature, fetchFill, getLamports, sendAndConfirm } from "./solana";
import type { ExitPlan } from "./types";
import { withAgentSigner } from "./vault";

export type AgentRow = typeof schema.agents.$inferSelect;
export type PositionRow = typeof schema.agentPositions.$inferSelect;
export type OrderRow = typeof schema.agentOrders.$inferSelect;

const nowSec = () => Math.floor(Date.now() / 1000);
const MAX_ATTEMPTS = 4;

export interface Mark {
  priceUsd: number | null;
  mcUsd: number | null;
  solUsd: number | null;
  phase: "curve" | "graduated" | "unknown";
}

export interface ExecResult {
  order: OrderRow;
  /** True when this call created and ran the order (false = an earlier attempt already owns the intent). */
  ran: boolean;
}

/**
 * Claim the next attempt of an intent. Returns null when the intent is already filled, in flight, or out of attempts.
 */
async function claimOrder(base: string, values: Omit<typeof schema.agentOrders.$inferInsert, "clientKey">): Promise<OrderRow | null> {
  const db = getDb();
  const prior = await db
    .select()
    .from(schema.agentOrders)
    .where(and(eq(schema.agentOrders.agentId, values.agentId), like(schema.agentOrders.clientKey, `${base}#%`)))
    .orderBy(desc(schema.agentOrders.id));
  if (prior.some((o) => o.status !== "failed") || prior.length >= MAX_ATTEMPTS) return null;
  const clientKey = `${base}#${prior.length + 1}`;
  const rows = await withBusyRetry(
    () => db.insert(schema.agentOrders).values({ ...values, clientKey }).onConflictDoNothing().returning(),
    { label: "agent order claim" },
  );
  return rows[0] ?? null;
}

async function fail(order: OrderRow, error: string): Promise<OrderRow> {
  const rows = await withBusyRetry(
    () => getDb().update(schema.agentOrders).set({ status: "failed", error: error.slice(0, 500) }).where(eq(schema.agentOrders.id, order.id)).returning(),
    { label: "agent order fail" },
  );
  return rows[0];
}

const latencyBps = (phase: Mark["phase"]) => (phase === "curve" ? 150 : 50);

/** USD per whole token from a SOL leg and a token leg. */
function effectivePrice(lamports: number, tokenRaw: bigint, decimals: number, solUsd: number | null): number | null {
  if (solUsd == null || tokenRaw <= 0n) return null;
  return ((lamports / 1e9) * solUsd) / (Number(tokenRaw) / 10 ** decimals);
}

// ---------------------------------------------------------------- buy

export interface BuyIntent {
  mint: string;
  symbol: string | null;
  decimals: number;
  lamports: number; // SOL into the swap
  decisionId: number | null;
  slippageBps: number;
  priorityFeeLamports: number;
  exitPlan: ExitPlan;
  mark: Mark;
  /** Idempotency base, e.g. `buy:<mint>:<decisionId>`. */
  key: string;
}

export async function executeBuy(agent: AgentRow, b: BuyIntent): Promise<ExecResult | null> {
  const order = await claimOrder(b.key, {
    agentId: agent.id,
    decisionId: b.decisionId,
    side: "buy",
    mint: b.mint,
    symbol: b.symbol,
    inAmount: String(b.lamports),
    paper: agent.mode === "paper",
    priceUsd: b.mark.priceUsd,
    mcUsd: b.mark.mcUsd,
    reason: "entry",
  });
  if (!order) return null;
  try {
    return { order: agent.mode === "paper" ? await paperBuy(agent, order, b) : await liveBuy(agent, order, b), ran: true };
  } catch (err) {
    return { order: await fail(order, err instanceof Error ? err.message : String(err)), ran: true };
  }
}

async function paperBuy(agent: AgentRow, order: OrderRow, b: BuyIntent): Promise<OrderRow> {
  const q = await buyQuote(b.mint, b.lamports, b.slippageBps);
  const tokens = (BigInt(q.outAmount) * BigInt(10_000 - latencyBps(b.mark.phase))) / 10_000n;
  const fees = BASE_FEE_LAMPORTS + b.priorityFeeLamports + TOKEN_ACCOUNT_RENT_LAMPORTS;
  const cost = b.lamports + fees;
  if (agent.paperCashLamports < cost) throw new Error(`paper cash ${agent.paperCashLamports} < ${cost} lamports needed`);
  return applyBuyFill(agent, order, b, { tokens, costLamports: cost, feeLamports: fees, decimals: b.decimals, signature: null, paperCashDelta: -cost });
}

async function liveBuy(agent: AgentRow, order: OrderRow, b: BuyIntent): Promise<OrderRow> {
  const balance = (await getLamports([agent.walletPubkey])).get(agent.walletPubkey) ?? 0;
  if (balance < b.lamports + LIVE_FEE_RESERVE_LAMPORTS) throw new Error(`wallet holds ${balance} lamports; need ${b.lamports} + ${LIVE_FEE_RESERVE_LAMPORTS} reserve`);
  const q = await buyQuote(b.mint, b.lamports, b.slippageBps);
  const sent = await signAndSend(agent, order, q, b.priorityFeeLamports);
  if (!sent.ok) return fail(order, sent.error);
  const fill = await fetchFill(sent.signature, agent.walletPubkey, b.mint);
  if (!fill || fill.tokenDeltaRaw <= 0n) return fail(order, `landed (${sent.signature}) but no token delta found in the transaction meta`);
  return applyBuyFill(agent, order, b, {
    tokens: fill.tokenDeltaRaw,
    costLamports: -fill.solDeltaLamports,
    feeLamports: fill.feeLamports,
    decimals: fill.decimals ?? b.decimals,
    signature: sent.signature,
    paperCashDelta: 0,
  });
}

async function applyBuyFill(
  agent: AgentRow,
  order: OrderRow,
  b: BuyIntent,
  f: { tokens: bigint; costLamports: number; feeLamports: number; decimals: number; signature: string | null; paperCashDelta: number },
): Promise<OrderRow> {
  const now = nowSec();
  const solUsd = b.mark.solUsd;
  const entryPrice = effectivePrice(b.lamports, f.tokens, f.decimals, solUsd) ?? b.mark.priceUsd;
  const entryMc = b.mark.mcUsd != null && b.mark.priceUsd && entryPrice ? (b.mark.mcUsd * entryPrice) / b.mark.priceUsd : b.mark.mcUsd;
  const db = getDb();
  return withBusyRetry(
    () =>
      db.transaction(async (tx) => {
        const [o] = await tx
          .update(schema.agentOrders)
          .set({
            status: "filled",
            outAmount: f.tokens.toString(),
            lamports: f.costLamports,
            feeLamports: f.feeLamports,
            signature: f.signature,
            priceUsd: entryPrice,
            mcUsd: entryMc,
            filledAt: now,
            error: null,
          })
          .where(eq(schema.agentOrders.id, order.id))
          .returning();
        if (f.paperCashDelta) {
          const [a] = await tx.select({ cash: schema.agents.paperCashLamports }).from(schema.agents).where(eq(schema.agents.id, agent.id));
          await tx.update(schema.agents).set({ paperCashLamports: a.cash + f.paperCashDelta, updatedAt: now }).where(eq(schema.agents.id, agent.id));
        }
        await tx.insert(schema.agentPositions).values({
          agentId: agent.id,
          mint: b.mint,
          symbol: b.symbol,
          qtyRaw: f.tokens.toString(),
          peakQtyRaw: f.tokens.toString(),
          decimals: f.decimals,
          costLamports: f.costLamports,
          realizedLamports: 0,
          exitPlanJson: JSON.stringify(b.exitPlan),
          entryPriceUsd: entryPrice,
          entryMcUsd: entryMc,
          peakPriceUsd: entryPrice,
          lastPriceUsd: entryPrice,
          lastPriceAt: now,
          status: "open",
          openedAt: now,
          lastTradeAt: now,
        });
        return o;
      }),
    { label: "agent buy fill", attempts: 3 },
  );
}

// ---------------------------------------------------------------- sell

export interface SellIntent {
  qtyRaw: bigint; // tokens to sell (≤ position qty)
  reason: string;
  /** Exit tag ("sl", "tp1", "closeall", …): part of the idempotency key with the position's openedAt. */
  tag: string;
  slippageBps: number;
  priorityFeeLamports: number;
  mark: Mark;
  /** Ladder/initials bookkeeping applied on fill. */
  advanceTp?: boolean;
  setInitialsOut?: boolean;
}

export async function executeSell(agent: AgentRow, pos: PositionRow, s: SellIntent): Promise<ExecResult | null> {
  const qty = BigInt(pos.qtyRaw);
  const sell = s.qtyRaw > qty ? qty : s.qtyRaw;
  if (sell <= 0n) return null;
  const order = await claimOrder(`sell:${pos.mint}:${pos.openedAt}:${s.tag}`, {
    agentId: agent.id,
    side: "sell",
    mint: pos.mint,
    symbol: pos.symbol,
    inAmount: sell.toString(),
    paper: agent.mode === "paper",
    priceUsd: s.mark.priceUsd,
    mcUsd: s.mark.mcUsd,
    reason: s.reason,
  });
  if (!order) return null;
  try {
    return { order: agent.mode === "paper" ? await paperSell(agent, pos, order, sell, s) : await liveSell(agent, pos, order, sell, s), ran: true };
  } catch (err) {
    if (err instanceof NoRouteError && s.tag === "dead") return { order: await writeOff(agent, pos, order, err.message), ran: true };
    return { order: await fail(order, err instanceof Error ? err.message : String(err)), ran: true };
  }
}

async function paperSell(agent: AgentRow, pos: PositionRow, order: OrderRow, sell: bigint, s: SellIntent): Promise<OrderRow> {
  const q = await sellQuote(pos.mint, sell.toString(), s.slippageBps);
  const closes = sell === BigInt(pos.qtyRaw);
  const gross = Number((BigInt(q.outAmount) * BigInt(10_000 - latencyBps(s.mark.phase))) / 10_000n);
  const fees = BASE_FEE_LAMPORTS + s.priorityFeeLamports;
  const received = gross - fees + (closes ? TOKEN_ACCOUNT_RENT_LAMPORTS : 0);
  return applySellFill(agent, pos, order, s, { sold: sell, receivedLamports: received, feeLamports: fees, signature: null, paperCashDelta: received });
}

async function liveSell(agent: AgentRow, pos: PositionRow, order: OrderRow, sell: bigint, s: SellIntent): Promise<OrderRow> {
  const q = await sellQuote(pos.mint, sell.toString(), s.slippageBps);
  const sent = await signAndSend(agent, order, q, s.priorityFeeLamports);
  if (!sent.ok) return fail(order, sent.error);
  const fill = await fetchFill(sent.signature, agent.walletPubkey, pos.mint);
  if (!fill || fill.tokenDeltaRaw >= 0n) return fail(order, `landed (${sent.signature}) but no token decrease found in the transaction meta`);
  const sold = -fill.tokenDeltaRaw;
  let received = fill.solDeltaLamports;
  const closes = sold >= BigInt(pos.qtyRaw);
  if (closes) received += await closeEmptyTokenAccounts(agent, pos.mint).catch(() => 0);
  return applySellFill(agent, pos, order, s, { sold, receivedLamports: received, feeLamports: fill.feeLamports, signature: sent.signature, paperCashDelta: 0 });
}

async function applySellFill(
  agent: AgentRow,
  pos: PositionRow,
  order: OrderRow,
  s: SellIntent,
  f: { sold: bigint; receivedLamports: number; feeLamports: number; signature: string | null; paperCashDelta: number },
): Promise<OrderRow> {
  const now = nowSec();
  const qty = BigInt(pos.qtyRaw);
  const remaining = qty > f.sold ? qty - f.sold : 0n;
  const costPart = qty > 0n ? Math.round((pos.costLamports * Number(f.sold)) / Number(qty)) : pos.costLamports;
  const solUsd = s.mark.solUsd;
  const db = getDb();
  return withBusyRetry(
    () =>
      db.transaction(async (tx) => {
        const [o] = await tx
          .update(schema.agentOrders)
          .set({
            status: "filled",
            outAmount: String(f.receivedLamports),
            lamports: f.receivedLamports,
            feeLamports: f.feeLamports,
            signature: f.signature,
            priceUsd: effectivePrice(f.receivedLamports, f.sold, pos.decimals, solUsd) ?? s.mark.priceUsd,
            filledAt: now,
            error: null,
          })
          .where(eq(schema.agentOrders.id, order.id))
          .returning();
        if (f.paperCashDelta) {
          const [a] = await tx.select({ cash: schema.agents.paperCashLamports }).from(schema.agents).where(eq(schema.agents.id, agent.id));
          await tx.update(schema.agents).set({ paperCashLamports: a.cash + f.paperCashDelta, updatedAt: now }).where(eq(schema.agents.id, agent.id));
        }
        await tx
          .update(schema.agentPositions)
          .set({
            qtyRaw: remaining.toString(),
            costLamports: remaining === 0n ? 0 : pos.costLamports - costPart,
            realizedLamports: pos.realizedLamports + f.receivedLamports - (remaining === 0n ? pos.costLamports : costPart),
            tpStepsHit: pos.tpStepsHit + (s.advanceTp ? 1 : 0),
            initialsOutDone: pos.initialsOutDone || !!s.setInitialsOut,
            status: remaining === 0n ? "closed" : "open",
            closedAt: remaining === 0n ? now : null,
            lastTradeAt: now,
          })
          .where(and(eq(schema.agentPositions.agentId, agent.id), eq(schema.agentPositions.mint, pos.mint), eq(schema.agentPositions.openedAt, pos.openedAt)));
        return o;
      }),
    { label: "agent sell fill", attempts: 3 },
  );
}

/** Dead token with no route: the position is written off at 0 (realised loss = remaining cost). */
async function writeOff(agent: AgentRow, pos: PositionRow, order: OrderRow, why: string): Promise<OrderRow> {
  const now = nowSec();
  const db = getDb();
  return withBusyRetry(
    () =>
      db.transaction(async (tx) => {
        const [o] = await tx
          .update(schema.agentOrders)
          .set({ status: "filled", outAmount: "0", lamports: 0, feeLamports: 0, priceUsd: 0, filledAt: now, error: `written off: ${why}`.slice(0, 500) })
          .where(eq(schema.agentOrders.id, order.id))
          .returning();
        await tx
          .update(schema.agentPositions)
          .set({ qtyRaw: "0", costLamports: 0, realizedLamports: pos.realizedLamports - pos.costLamports, status: "closed", closedAt: now, lastTradeAt: now, lastPriceUsd: 0, lastPriceAt: now })
          .where(and(eq(schema.agentPositions.agentId, agent.id), eq(schema.agentPositions.mint, pos.mint), eq(schema.agentPositions.openedAt, pos.openedAt)));
        return o;
      }),
    { label: "agent write-off" },
  );
}

// ---------------------------------------------------------------- live signing

type Sent = { ok: true; signature: string } | { ok: false; error: string };

/** Build the Jupiter swap, sign with the agent key, persist the signature, then broadcast + confirm. */
async function signAndSend(agent: AgentRow, order: OrderRow, quote: JupQuote, maxPriorityFeeLamports: number): Promise<Sent> {
  const swap = await buildSwapTransaction(quote, agent.walletPubkey, maxPriorityFeeLamports);
  const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
  await withAgentSigner(agent, async (signer) => tx.sign([signer]));
  const signature = bs58.encode(tx.signatures[0]);
  // persisted BEFORE broadcast: a crash after this point is reconciled by signature, never re-sent as a new tx
  await withBusyRetry(() => getDb().update(schema.agentOrders).set({ status: "sent", signature }).where(eq(schema.agentOrders.id, order.id)), {
    label: "agent order sent",
  });
  const res = await sendAndConfirm(tx.serialize(), signature, swap.lastValidBlockHeight);
  return res.landed ? { ok: true, signature } : { ok: false, error: res.error };
}

/** Close the agent's empty token accounts for `mint` (refunds rent). Returns lamports refunded. */
async function closeEmptyTokenAccounts(agent: AgentRow, mint: string): Promise<number> {
  const c = agentConnection();
  const owner = new PublicKey(agent.walletPubkey);
  const accounts = await c.getTokenAccountsByOwner(owner, { mint: new PublicKey(mint) }, "confirmed");
  // SPL Token / Token-2022 account layout: mint[32] owner[32] amount u64 LE at offset 64
  const empty = accounts.value.filter((a) => a.account.data.length >= 72 && a.account.data.readBigUInt64LE(64) === 0n);
  if (!empty.length) return 0;
  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: owner, recentBlockhash: blockhash });
  for (const a of empty) tx.add(closeTokenAccountIx(a.pubkey, owner, owner, a.account.owner));
  await withAgentSigner(agent, async (signer) => tx.sign(signer));
  const sig = bs58.encode(tx.signature!);
  const res = await sendAndConfirm(tx.serialize(), sig, lastValidBlockHeight);
  return res.landed ? empty.reduce((s, a) => s + a.account.lamports, 0) - BASE_FEE_LAMPORTS : 0;
}

/**
 * Startup / periodic reconciliation of live orders left "sent" by a crash: landed → the fill is read from the chain and
 * applied exactly like a normal fill; not landed → failed. "queued" orders older than 2 min never got a signature, so
 * they were never broadcast → failed.
 */
export async function reconcileOrders(log: (m: string) => void): Promise<void> {
  const db = getDb();
  const now = nowSec();
  const stuck = await db
    .select()
    .from(schema.agentOrders)
    .where(and(inArray(schema.agentOrders.status, ["queued", "sent"]), lt(schema.agentOrders.createdAt, now - 120)));
  for (const o of stuck) {
    if (o.status === "queued" || !o.signature) {
      await fail(o, "never broadcast (process stopped before signing)");
      continue;
    }
    const res = await confirmSignature(o.signature, 0);
    const agent = (await db.select().from(schema.agents).where(eq(schema.agents.id, o.agentId)))[0];
    const fill = res.landed && agent ? await fetchFill(o.signature, agent.walletPubkey, o.mint) : null;
    if (!fill || !agent) {
      await fail(o, `reconciled: ${res.landed ? "landed but the fill could not be read" : res.error}`);
      log(`reconcile: order ${o.id} ${o.signature} ${res.landed ? "landed, fill unreadable" : "did not land"}`);
      continue;
    }
    const mark: Mark = { priceUsd: o.priceUsd, mcUsd: o.mcUsd, solUsd: null, phase: "unknown" };
    if (o.side === "buy" && fill.tokenDeltaRaw > 0n) {
      const strategy = JSON.parse(agent.strategyJson) as { exit: ExitPlan };
      const intent: BuyIntent = {
        mint: o.mint,
        symbol: o.symbol,
        decimals: fill.decimals ?? 6,
        lamports: Number(o.inAmount),
        decisionId: o.decisionId,
        slippageBps: 0,
        priorityFeeLamports: 0,
        exitPlan: strategy.exit,
        mark,
        key: "",
      };
      await applyBuyFill(agent, o, intent, { tokens: fill.tokenDeltaRaw, costLamports: -fill.solDeltaLamports, feeLamports: fill.feeLamports, decimals: intent.decimals, signature: o.signature, paperCashDelta: 0 });
    } else if (o.side === "sell" && fill.tokenDeltaRaw < 0n) {
      const pos = (
        await db
          .select()
          .from(schema.agentPositions)
          .where(and(eq(schema.agentPositions.agentId, agent.id), eq(schema.agentPositions.mint, o.mint), eq(schema.agentPositions.status, "open")))
      )[0];
      if (pos) {
        const s: SellIntent = { qtyRaw: -fill.tokenDeltaRaw, reason: o.reason, tag: "", slippageBps: 0, priorityFeeLamports: 0, mark };
        await applySellFill(agent, pos, o, s, { sold: -fill.tokenDeltaRaw, receivedLamports: fill.solDeltaLamports, feeLamports: fill.feeLamports, signature: o.signature, paperCashDelta: 0 });
      } else await fail(o, "reconciled: landed but no open position to apply the sell to");
    } else await fail(o, "reconciled: landed but the token delta does not match the order side");
    log(`reconcile: order ${o.id} ${o.signature} landed; fill applied from chain`);
  }
}

/**
 * Live path proof without funds: quote + build the real Jupiter swap for the agent wallet, sign it with the agent key,
 * and `simulateTransaction` it (sigVerify on). An unfunded wallet is expected to fail with insufficient funds.
 */
export async function simulateLiveSwap(agent: AgentRow, mint: string, lamports: number, slippageBps: number) {
  const q = await buyQuote(mint, lamports, slippageBps);
  const swap = await buildSwapTransaction(q, agent.walletPubkey, 100_000);
  const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
  await withAgentSigner(agent, async (signer) => tx.sign([signer]));
  const sim = await agentConnection().simulateTransaction(tx, { sigVerify: true, commitment: "processed" });
  return {
    quote: { inAmount: q.inAmount, outAmount: q.outAmount, priceImpactPct: q.priceImpactPct, route: q.routePlan.map((r) => r.swapInfo.label).join(" → ") },
    signature: bs58.encode(tx.signatures[0]),
    txBytes: tx.serialize().length,
    err: sim.value.err,
    logs: sim.value.logs?.slice(-8) ?? [],
  };
}
