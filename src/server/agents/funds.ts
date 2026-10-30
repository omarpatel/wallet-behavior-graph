/**
 * Agent wallet funds: deposit detection (balance poll → signature scan, recorded by signature), the per-agent deposit
 * cap (excess can't be refused on-chain, so it is flagged and the agent halts), owner withdrawals (SOL transfer to the
 * owner wallet only, any status, audit-logged) and the browser deposit relay.
 */
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { withBusyRetry } from "@/db/retry";
import { maxDepositLamports } from "./config";
import type { AgentRow } from "./execute";
import { agentConnection, buildWithdrawTransaction, FundsError, getLamports, sendAndConfirm, verifyDepositTransaction } from "./solana";
import { sol } from "./strategy";
import type { AgentDepositInfoDTO } from "./types";
import { withAgentSigner } from "./vault";

const nowSec = () => Math.floor(Date.now() / 1000);
const audit = (msg: string) => console.log(`${new Date().toISOString()} [agents] funds: ${msg}`);

export async function netDepositsLamports(agentId: string): Promise<number> {
  const r = await getDb()
    .select({
      net: sql<number>`coalesce(sum(case when ${schema.agentLedger.kind} = 'deposit' then ${schema.agentLedger.amountLamports} when ${schema.agentLedger.kind} = 'withdraw' then -${schema.agentLedger.amountLamports} else 0 end), 0)`,
    })
    .from(schema.agentLedger)
    .where(eq(schema.agentLedger.agentId, agentId));
  return Number(r[0]?.net ?? 0);
}

/**
 * Record incoming SOL transfers not signed by the agent (deposits), newest 25 signatures. Idempotent by signature.
 * When net deposits exceed `maxLamports` (AGENT_MAX_DEPOSIT_SOL; null = uncapped, platform agents) the row is flagged
 * and the agent halted. Returns new deposits.
 */
export async function scanDeposits(agent: AgentRow, log: (m: string) => void, maxLamports: number | null = maxDepositLamports()): Promise<number> {
  const db = getDb();
  const c = agentConnection();
  const sigs = await c.getSignaturesForAddress(new PublicKey(agent.walletPubkey), { limit: 25 }, "confirmed");
  const [ledgerSigs, orderSigs] = await Promise.all([
    db.select({ s: schema.agentLedger.signature }).from(schema.agentLedger).where(and(eq(schema.agentLedger.agentId, agent.id), isNotNull(schema.agentLedger.signature))),
    db.select({ s: schema.agentOrders.signature }).from(schema.agentOrders).where(and(eq(schema.agentOrders.agentId, agent.id), isNotNull(schema.agentOrders.signature))),
  ]);
  const known = new Set([...ledgerSigs, ...orderSigs].map((r) => r.s));
  let found = 0;
  for (const s of [...sigs].reverse()) {
    if (s.err || known.has(s.signature)) continue;
    const tx = await c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx?.meta) continue;
    const msg = tx.transaction.message;
    const keys = msg.staticAccountKeys.map((k) => k.toBase58());
    const idx = keys.indexOf(agent.walletPubkey);
    if (idx < 0 || idx < msg.header.numRequiredSignatures) continue; // signed by the agent: our own swap/withdraw
    const delta = tx.meta.postBalances[idx] - tx.meta.preBalances[idx];
    const net = (await netDepositsLamports(agent.id)) + delta;
    const over = maxLamports != null && net > maxLamports;
    const inserted = await withBusyRetry(
      () =>
        db
          .insert(schema.agentLedger)
          .values({
            agentId: agent.id,
            kind: "deposit",
            amountLamports: delta,
            signature: s.signature,
            counterparty: keys[0],
            flagged: over ? `over AGENT_MAX_DEPOSIT_SOL (net ${sol(net)} > ${sol(maxLamports ?? 0)})` : null,
            createdAt: s.blockTime ?? nowSec(),
          })
          .onConflictDoNothing()
          .returning(),
      { label: "agent deposit" },
    );
    if (!inserted.length) continue;
    found++;
    audit(`${agent.id} deposit ${sol(delta)} from ${keys[0]} (${s.signature}); net deposits now ${sol(net)}`);
    if (over) {
      await withBusyRetry(
        () =>
          db
            .update(schema.agents)
            .set({ status: "halted", haltedReason: `Deposits exceed the ${sol(maxLamports ?? 0)} limit (net ${sol(net)}). Withdraw the excess to resume.`, updatedAt: nowSec() })
            .where(eq(schema.agents.id, agent.id)),
        { label: "agent deposit halt" },
      );
      log(`${agent.id} halted: net deposits ${sol(net)} over limit`);
    }
  }
  return found;
}

/** SOL → owner wallet. 'all' sweeps the wallet; positions are not sold (close-all first). */
export async function withdraw(agent: AgentRow, request: number | "all"): Promise<{ signature: string; lamports: number }> {
  const c = agentConnection();
  const balance = (await getLamports([agent.walletPubkey])).get(agent.walletPubkey) ?? 0;
  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash("confirmed");
  const plan = buildWithdrawTransaction({ from: agent.walletPubkey, to: agent.owner, balance, request, blockhash });
  await withAgentSigner(agent, async (signer) => plan.tx.sign(signer));
  const signature = bs58.encode(plan.tx.signature!);
  audit(`${agent.id} withdraw ${sol(plan.lamports)} → owner ${agent.owner} (${signature}) requested=${request}`);
  const res = await sendAndConfirm(plan.tx.serialize(), signature, lastValidBlockHeight);
  if (!res.landed) {
    audit(`${agent.id} withdraw ${signature} failed: ${res.error}`);
    throw new FundsError(`Withdrawal did not land: ${res.error}`);
  }
  await withBusyRetry(
    () =>
      getDb()
        .insert(schema.agentLedger)
        .values({ agentId: agent.id, kind: "withdraw", amountLamports: plan.lamports, signature, counterparty: agent.owner })
        .onConflictDoNothing(),
    { label: "agent withdraw ledger" },
  );
  await getDb().update(schema.agents).set({ chainLamports: balance - plan.lamports - 5_000, updatedAt: nowSec() }).where(eq(schema.agents.id, agent.id));
  audit(`${agent.id} withdraw ${signature} confirmed`);
  return { signature, lamports: plan.lamports };
}

export async function depositInfo(agent: AgentRow): Promise<AgentDepositInfoDTO> {
  const { blockhash, lastValidBlockHeight } = await agentConnection().getLatestBlockhash("confirmed");
  const max = maxDepositLamports();
  return { to: agent.walletPubkey, blockhash, lastValidBlockHeight, maxLamports: max, remainingLamports: Math.max(0, max - (await netDepositsLamports(agent.id))) };
}

/** Relay an owner-signed deposit (browser wallets can't reach mainnet RPC): verified, sent, confirmed, recorded. */
export async function relayDeposit(agent: AgentRow, ownerWallet: string, signedBase64: string): Promise<{ signature: string; lamports: number }> {
  const remaining = Math.max(0, maxDepositLamports() - (await netDepositsLamports(agent.id)));
  const v = verifyDepositTransaction(signedBase64, { from: ownerWallet, to: agent.walletPubkey, maxLamports: remaining });
  const { lastValidBlockHeight } = await agentConnection().getLatestBlockhash("confirmed");
  const res = await sendAndConfirm(v.raw, v.signature, lastValidBlockHeight + 150);
  if (!res.landed) throw new FundsError(`Deposit did not land: ${res.error}`);
  await withBusyRetry(
    () =>
      getDb()
        .insert(schema.agentLedger)
        .values({ agentId: agent.id, kind: "deposit", amountLamports: v.lamports, signature: v.signature, counterparty: ownerWallet })
        .onConflictDoNothing(),
    { label: "agent deposit relay" },
  );
  audit(`${agent.id} deposit relayed ${sol(v.lamports)} from ${ownerWallet} (${v.signature})`);
  return { signature: v.signature, lamports: v.lamports };
}
