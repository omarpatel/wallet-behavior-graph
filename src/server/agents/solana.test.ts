import { ComputeBudgetProgram, Keypair, SystemInstruction, SystemProgram, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { BASE_FEE_LAMPORTS, SYSTEM_RENT_EXEMPT_LAMPORTS } from "./config";
import { buildWithdrawTransaction, FundsError, verifyDepositTransaction } from "./solana";

const agent = Keypair.generate();
const owner = Keypair.generate();
const blockhash = Keypair.generate().publicKey.toBase58();

describe("buildWithdrawTransaction", () => {
  it("'all' sweeps balance minus the fee, to the owner, signed by the agent", () => {
    const { lamports, tx } = buildWithdrawTransaction({ from: agent.publicKey.toBase58(), to: owner.publicKey.toBase58(), balance: 1_000_000_000, request: "all", blockhash });
    expect(lamports).toBe(1_000_000_000 - BASE_FEE_LAMPORTS);
    expect(tx.instructions).toHaveLength(1);
    const t = SystemInstruction.decodeTransfer(tx.instructions[0]);
    expect(t.fromPubkey.equals(agent.publicKey)).toBe(true);
    expect(t.toPubkey.equals(owner.publicKey)).toBe(true);
    expect(Number(t.lamports)).toBe(lamports);
    tx.sign(agent);
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.feePayer?.equals(agent.publicKey)).toBe(true);
  });

  it("partial withdrawals must leave the account rent-exempt", () => {
    const base = { from: agent.publicKey.toBase58(), to: owner.publicKey.toBase58(), balance: 100_000_000, blockhash };
    expect(buildWithdrawTransaction({ ...base, request: 50_000_000 }).lamports).toBe(50_000_000);
    const leavesDust = 100_000_000 - BASE_FEE_LAMPORTS - (SYSTEM_RENT_EXEMPT_LAMPORTS - 1);
    expect(() => buildWithdrawTransaction({ ...base, request: leavesDust })).toThrow(FundsError);
    expect(() => buildWithdrawTransaction({ ...base, request: 200_000_000 })).toThrow(FundsError);
    expect(() => buildWithdrawTransaction({ ...base, request: 1.5 })).toThrow(FundsError);
    expect(() => buildWithdrawTransaction({ ...base, balance: 4_000, request: "all" })).toThrow(FundsError);
  });
});

describe("verifyDepositTransaction", () => {
  const signed = (build: (tx: Transaction) => void, signers: Keypair[] = [owner]) => {
    const tx = new Transaction({ feePayer: signers[0].publicKey, recentBlockhash: blockhash });
    build(tx);
    tx.sign(...signers);
    return tx.serialize({ requireAllSignatures: true }).toString("base64");
  };
  const p = { from: owner.publicKey.toBase58(), to: agent.publicKey.toBase58(), maxLamports: 2_000_000_000 };

  it("accepts a single transfer owner → agent (compute budget allowed)", () => {
    const b64 = signed((tx) =>
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: agent.publicKey, lamports: 1_000_000_000 })),
    );
    const v = verifyDepositTransaction(b64, p);
    expect(v.lamports).toBe(1_000_000_000);
    expect(v.signature.length).toBeGreaterThan(80);
  });

  it("rejects over-limit, wrong destination, extra instructions and foreign payers", () => {
    const over = signed((tx) => tx.add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: agent.publicKey, lamports: 3_000_000_000 })));
    expect(() => verifyDepositTransaction(over, p)).toThrow(/limit/);
    const elsewhere = signed((tx) => tx.add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })));
    expect(() => verifyDepositTransaction(elsewhere, p)).toThrow(FundsError);
    const two = signed((tx) =>
      tx.add(
        SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: agent.publicKey, lamports: 1 }),
        SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: agent.publicKey, lamports: 1 }),
      ),
    );
    expect(() => verifyDepositTransaction(two, p)).toThrow(/single/);
    const other = Keypair.generate();
    const foreign = signed((tx) => tx.add(SystemProgram.transfer({ fromPubkey: other.publicKey, toPubkey: agent.publicKey, lamports: 1 })), [other]);
    expect(() => verifyDepositTransaction(foreign, p)).toThrow(/your connected wallet/);
  });
});
