/**
 * Mainnet plumbing for agent wallets: balances, SOL withdraw/deposit transactions, send-and-confirm with resend,
 * and fill parsing from transaction metadata (actual in/out, not the quote).
 */
import {
  Connection,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import bs58 from "bs58";
import { setTimeout as sleep } from "node:timers/promises";
import { HttpError } from "@/server/auth/http";
import { agentRpcUrl, BASE_FEE_LAMPORTS, SYSTEM_RENT_EXEMPT_LAMPORTS } from "./config";

let conn: Connection | null = null;
export function agentConnection(): Connection {
  conn ??= new Connection(agentRpcUrl(), "confirmed");
  return conn;
}

/** User-facing funds error (bad amount, unfunded wallet, rejected deposit): 400 through withApi. */
export class FundsError extends HttpError {
  constructor(message: string) {
    super(400, message);
    this.name = "FundsError";
  }
}

/** Lamports per account (missing accounts = 0). */
export async function getLamports(pubkeys: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < pubkeys.length; i += 100) {
    const batch = pubkeys.slice(i, i + 100);
    const infos = await agentConnection().getMultipleAccountsInfo(batch.map((p) => new PublicKey(p)), "confirmed");
    batch.forEach((p, j) => out.set(p, infos[j]?.lamports ?? 0));
  }
  return out;
}

// ---------------------------------------------------------------- withdraw

export interface WithdrawPlan {
  lamports: number;
  tx: Transaction;
}

/**
 * SOL transfer agent → owner. 'all' sweeps the wallet to zero (balance − fee); a partial amount must leave the
 * account rent-exempt (or be the full sweep). Pure: no RPC, so the rules are unit-tested.
 */
export function buildWithdrawTransaction(p: { from: string; to: string; balance: number; request: number | "all"; blockhash: string }): WithdrawPlan {
  const max = p.balance - BASE_FEE_LAMPORTS;
  if (max <= 0) throw new FundsError("Agent wallet has no withdrawable SOL");
  let lamports: number;
  if (p.request === "all") lamports = max;
  else {
    if (!Number.isInteger(p.request) || p.request <= 0) throw new FundsError("lamports must be a positive integer");
    if (p.request > max) throw new FundsError(`Only ${max} lamports are withdrawable (balance minus the network fee)`);
    const left = max - p.request;
    if (left !== 0 && left < SYSTEM_RENT_EXEMPT_LAMPORTS)
      throw new FundsError(`Withdrawing ${p.request} would leave ${left} lamports, below the ${SYSTEM_RENT_EXEMPT_LAMPORTS} rent-exempt minimum; withdraw 'all' or less`);
    lamports = p.request;
  }
  const from = new PublicKey(p.from);
  const tx = new Transaction({ feePayer: from, recentBlockhash: p.blockhash }).add(
    SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(p.to), lamports }),
  );
  return { lamports, tx };
}

// ---------------------------------------------------------------- deposit relay

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

/**
 * A signed deposit from the owner's browser wallet: exactly one SystemProgram transfer from `from` (also the fee
 * payer and only signer) to `to`, ≤ maxLamports; ComputeBudget instructions allowed. Returns the amount.
 */
export function verifyDepositTransaction(base64: string, p: { from: string; to: string; maxLamports: number }): { lamports: number; raw: Uint8Array; signature: string } {
  const raw = Buffer.from(base64, "base64");
  let ixs: TransactionInstruction[];
  let feePayer: string;
  let signers: string[];
  let signature: string | null;
  try {
    const vtx = VersionedTransaction.deserialize(raw);
    const msg = vtx.message;
    if (msg.addressTableLookups.length) throw new FundsError("Deposit transaction may not use address lookup tables");
    const keys = msg.staticAccountKeys;
    feePayer = keys[0].toBase58();
    signers = keys.slice(0, msg.header.numRequiredSignatures).map((k) => k.toBase58());
    ixs = msg.compiledInstructions.map(
      (ci) =>
        new TransactionInstruction({
          programId: keys[ci.programIdIndex],
          keys: ci.accountKeyIndexes.map((i) => ({ pubkey: keys[i], isSigner: msg.isAccountSigner(i), isWritable: msg.isAccountWritable(i) })),
          data: Buffer.from(ci.data),
        }),
    );
    const sig = vtx.signatures[0];
    signature = sig && sig.some((b) => b !== 0) ? bs58.encode(sig) : null;
  } catch (err) {
    if (err instanceof FundsError) throw err;
    const tx = Transaction.from(raw);
    feePayer = tx.feePayer?.toBase58() ?? "";
    signers = tx.signatures.map((s) => s.publicKey.toBase58());
    ixs = tx.instructions;
    signature = tx.signature ? bs58.encode(tx.signature) : null;
  }
  if (feePayer !== p.from || signers.length !== 1 || signers[0] !== p.from) throw new FundsError("Deposit must be signed and paid by your connected wallet only");
  if (!signature) throw new FundsError("Deposit transaction is not signed");
  const transfers = ixs.filter((ix) => ix.programId.toBase58() !== COMPUTE_BUDGET);
  if (transfers.length !== 1 || !transfers[0].programId.equals(SystemProgram.programId))
    throw new FundsError("Deposit must be a single SOL transfer");
  let decoded: { fromPubkey: PublicKey; toPubkey: PublicKey; lamports: bigint | number };
  try {
    if (SystemInstruction.decodeInstructionType(transfers[0]) !== "Transfer") throw new Error("not a transfer");
    decoded = SystemInstruction.decodeTransfer(transfers[0]);
  } catch {
    throw new FundsError("Deposit must be a plain SystemProgram transfer");
  }
  const lamports = Number(decoded.lamports);
  if (decoded.fromPubkey.toBase58() !== p.from || decoded.toPubkey.toBase58() !== p.to) throw new FundsError("Deposit must go from your wallet to the agent wallet");
  if (lamports <= 0) throw new FundsError("Deposit amount must be positive");
  if (lamports > p.maxLamports) throw new FundsError(`Deposit exceeds the remaining limit of ${p.maxLamports} lamports`);
  return { lamports, raw, signature };
}

// ---------------------------------------------------------------- send + confirm

export type SendResult = { landed: true; slot: number } | { landed: false; error: string; expired: boolean };

/**
 * Broadcast already-signed bytes and confirm. Re-broadcasts the SAME bytes (same signature, so never a second
 * transaction) every 2 s until confirmed, failed on-chain, or the blockhash expired.
 */
export async function sendAndConfirm(raw: Uint8Array, signature: string, lastValidBlockHeight: number, preflight = true): Promise<SendResult> {
  const c = agentConnection();
  try {
    await c.sendRawTransaction(raw, { skipPreflight: !preflight, preflightCommitment: "processed", maxRetries: 0 });
  } catch (err) {
    // preflight rejection: nothing was broadcast
    return { landed: false, error: err instanceof Error ? err.message.slice(0, 400) : String(err), expired: false };
  }
  return confirmSignature(signature, lastValidBlockHeight, raw);
}

export async function confirmSignature(signature: string, lastValidBlockHeight: number, rebroadcast?: Uint8Array): Promise<SendResult> {
  const c = agentConnection();
  for (;;) {
    await sleep(2_000);
    const st = (await c.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (st?.err) return { landed: false, error: `failed on-chain: ${JSON.stringify(st.err)}`, expired: false };
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return { landed: true, slot: st.slot };
    const height = await c.getBlockHeight("confirmed");
    if (height > lastValidBlockHeight) {
      // one last look: it may have landed between the two calls
      const last = (await c.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (last && !last.err && last.confirmationStatus !== "processed") return { landed: true, slot: last.slot };
      return { landed: false, error: "blockhash expired before the transaction landed", expired: true };
    }
    if (rebroadcast) await c.sendRawTransaction(rebroadcast, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- fills from tx meta

export interface ChainFill {
  solDeltaLamports: number; // owner's net SOL change incl. fees and rent
  tokenDeltaRaw: bigint; // owner's net change in `mint`
  decimals: number | null;
  feeLamports: number;
}

export async function fetchFill(signature: string, owner: string, mint: string): Promise<ChainFill | null> {
  for (let i = 0; i < 5; i++) {
    const tx = await agentConnection().getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (tx) return parseFill(tx, owner, mint);
    await sleep(1_500);
  }
  return null;
}

export function parseFill(tx: Pick<VersionedTransactionResponse, "meta" | "transaction">, owner: string, mint: string): ChainFill | null {
  const meta = tx.meta;
  if (!meta) return null;
  const keys = [
    ...tx.transaction.message.staticAccountKeys.map((k) => k.toBase58()),
    ...(meta.loadedAddresses?.writable ?? []).map((k) => k.toBase58()),
    ...(meta.loadedAddresses?.readonly ?? []).map((k) => k.toBase58()),
  ];
  const idx = keys.indexOf(owner);
  if (idx < 0) return null;
  const sumTokens = (list: typeof meta.preTokenBalances) =>
    (list ?? []).filter((b) => b.mint === mint && b.owner === owner).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
  const decimals = [...(meta.postTokenBalances ?? []), ...(meta.preTokenBalances ?? [])].find((b) => b.mint === mint)?.uiTokenAmount.decimals ?? null;
  return {
    solDeltaLamports: meta.postBalances[idx] - meta.preBalances[idx],
    tokenDeltaRaw: sumTokens(meta.postTokenBalances) - sumTokens(meta.preTokenBalances),
    decimals,
    feeLamports: meta.fee,
  };
}

/** SPL Token / Token-2022 CloseAccount (instruction 9): refunds the token account's rent to `dest`. */
export function closeTokenAccountIx(account: PublicKey, dest: PublicKey, owner: PublicKey, programId: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}
