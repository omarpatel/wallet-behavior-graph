// Intent guard for wallet-first, server-co-signs transactions.
// Pure functions over Umi transactions: no keys, no RPC.
import type { PublicKey, Transaction } from "@metaplex-foundation/umi";

export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

type Ix = { program: string; keys: string; data: string };

function instructions(t: Transaction): Ix[] {
  if (t.message.addressLookupTables.length) throw new Error("Address lookup tables are not allowed");
  const a = t.message.accounts;
  return t.message.instructions.map((i) => ({
    program: a[i.programIndex],
    keys: i.accountIndexes.map((k) => a[k]).join(","),
    data: Buffer.from(i.data).toString("base64"),
  }));
}

const signerSet = (t: Transaction) =>
  t.message.accounts.slice(0, t.message.header.numRequiredSignatures).join(",");

/**
 * Throws unless `signed` carries the same intent as `built`: same blockhash, same signer set
 * (fee payer first), every built instruction present in order and unchanged, and the only extras
 * coming from ComputeBudget or Lighthouse (which wallets such as Phantom inject).
 */
export function assertSameIntent(built: Transaction, signed: Transaction): void {
  if (Buffer.from(built.serializedMessage).equals(Buffer.from(signed.serializedMessage))) return;
  if (signed.message.version !== built.message.version) throw new Error("Transaction version changed");
  if (signed.message.blockhash !== built.message.blockhash) throw new Error("Blockhash changed");
  if (signerSet(signed) !== signerSet(built)) throw new Error("Signer set changed");
  const want = instructions(built).filter((i) => i.program !== COMPUTE_BUDGET_PROGRAM);
  let w = 0;
  for (const ix of instructions(signed)) {
    const exp = want[w];
    if (exp && ix.program === exp.program && ix.keys === exp.keys && ix.data === exp.data) {
      w++;
      continue;
    }
    if (ix.program === COMPUTE_BUDGET_PROGRAM || ix.program === LIGHTHOUSE_PROGRAM) continue;
    throw new Error(`Unexpected instruction from program ${ix.program}`);
  }
  if (w !== want.length) throw new Error("Transaction is missing an expected instruction");
}

/** Throws unless `signer` is a required signer of `t` and its signature verifies. */
export function assertSignedBy(
  t: Transaction,
  signer: PublicKey,
  verify: (message: Uint8Array, signature: Uint8Array, publicKey: PublicKey) => boolean,
): void {
  const idx = t.message.accounts.indexOf(signer);
  if (idx < 0 || idx >= t.message.header.numRequiredSignatures) {
    throw new Error("Wallet is not a signer of this transaction");
  }
  const sig = t.signatures[idx];
  if (!sig || sig.every((b) => b === 0) || !verify(t.serializedMessage, sig, signer)) {
    throw new Error("Missing or invalid wallet signature");
  }
}
