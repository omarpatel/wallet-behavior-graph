import { setComputeUnitLimit, setComputeUnitPrice, transferSol } from "@metaplex-foundation/mpl-toolbox";
import {
  createNoopSigner,
  createSignerFromKeypair,
  generateSigner,
  lamports,
  publicKey,
  signTransaction,
  transactionBuilder,
  type Signer,
  type TransactionBuilder,
} from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { describe, expect, it } from "vitest";
import { assertSameIntent, assertSignedBy, LIGHTHOUSE_PROGRAM } from "./txguard";

// No RPC calls are made: transactions are built offline with a fixed blockhash.
const umi = createUmi("http://127.0.0.1:8899");
const blockhash = { blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", lastValidBlockHeight: 100 };
const wallet = generateSigner(umi);
const payer = createNoopSigner(wallet.publicKey);
const dest = generateSigner(umi).publicKey;

const lighthouseIx = transactionBuilder().add({
  instruction: { programId: publicKey(LIGHTHOUSE_PROGRAM), keys: [], data: new Uint8Array([7, 1, 2, 3]) },
  signers: [],
  bytesCreatedOnChain: 0,
});

function build(body: (b: TransactionBuilder) => TransactionBuilder, cu = 20_000, feePayer: Signer = payer) {
  return body(
    transactionBuilder()
      .add(setComputeUnitLimit(umi, { units: cu }))
      .add(setComputeUnitPrice(umi, { microLamports: 10_000 })),
  )
    .setFeePayer(feePayer)
    .setBlockhash(blockhash)
    .setVersion(0)
    .build(umi);
}

const pay = (amount: number, source: Signer = payer) => (b: TransactionBuilder) =>
  b.add(transferSol(umi, { source, destination: dest, amount: lamports(amount) }));

describe("assertSameIntent", () => {
  const built = build(pay(1_000_000));

  it("accepts an identical transaction", () => {
    expect(() => assertSameIntent(built, build(pay(1_000_000)))).not.toThrow();
  });

  it("allows changed ComputeBudget and appended Lighthouse instructions", () => {
    const signed = build((b) => pay(1_000_000)(b).add(lighthouseIx), 400_000);
    expect(() => assertSameIntent(built, signed)).not.toThrow();
  });

  it("rejects an extra non-allowed instruction", () => {
    const signed = build((b) => pay(1_000_000)(b).add(transferSol(umi, { source: payer, destination: dest, amount: lamports(1) })));
    expect(() => assertSameIntent(built, signed)).toThrow(/Unexpected instruction/);
  });

  it("rejects a changed amount", () => {
    expect(() => assertSameIntent(built, build(pay(999_999)))).toThrow(/Unexpected instruction/);
  });

  it("rejects a changed signer set", () => {
    const other = createNoopSigner(generateSigner(umi).publicKey);
    const signed = build((b) => pay(1_000_000)(b).add(transferSol(umi, { source: other, destination: dest, amount: lamports(0) })));
    expect(() => assertSameIntent(built, signed)).toThrow(/Signer set changed/);
  });

  it("rejects a changed fee payer", () => {
    const otherPayer = createNoopSigner(generateSigner(umi).publicKey);
    const twoSigners = build((b) => pay(1_000_000)(b));
    const swapped = build((b) => pay(1_000_000)(b), 20_000, otherPayer);
    expect(() => assertSameIntent(twoSigners, swapped)).toThrow(/Signer set changed/);
  });

  it("rejects a dropped instruction", () => {
    const signed = build((b) => b);
    expect(() => assertSameIntent(built, signed)).toThrow(/missing/);
  });

  it("rejects address lookup tables", () => {
    const signed = pay(1_000_000)(transactionBuilder())
      .setFeePayer(payer)
      .setBlockhash(blockhash)
      .setAddressLookupTables([{ publicKey: generateSigner(umi).publicKey, addresses: [dest] }])
      .build(umi);
    expect(() => assertSameIntent(built, signed)).toThrow(/lookup tables/);
  });

  it("rejects a changed blockhash", () => {
    const signed = pay(1_000_000)(transactionBuilder())
      .setFeePayer(payer)
      .setBlockhash({ blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", lastValidBlockHeight: 100 })
      .setVersion(0)
      .build(umi);
    expect(() => assertSameIntent(built, signed)).toThrow(/Blockhash/);
  });
});

describe("assertSignedBy", () => {
  const verify = umi.eddsa.verify.bind(umi.eddsa);

  it("accepts a valid wallet signature and rejects missing/forged ones", async () => {
    const tx = build(pay(5_000));
    expect(() => assertSignedBy(tx, wallet.publicKey, verify)).toThrow(/Missing or invalid/);
    const walletSigner = createSignerFromKeypair(umi, wallet);
    const signed = await signTransaction(tx, [walletSigner]);
    expect(() => assertSignedBy(signed, wallet.publicKey, verify)).not.toThrow();
    const forged = { ...signed, signatures: [new Uint8Array(64).fill(1)] };
    expect(() => assertSignedBy(forged, wallet.publicKey, verify)).toThrow(/Missing or invalid/);
    expect(() => assertSignedBy(signed, dest, verify)).toThrow(/not a signer/);
  });
});
