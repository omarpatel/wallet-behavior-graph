import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { accountKeysOf, detectVenue, normalizeTransaction, type RawInstruction, type RawTx } from "./normalize";

/** Real mainnet transactions (getTransaction, jsonParsed, maxSupportedTransactionVersion 1). */
function fixture(name: string): { wallet: string; tx: RawTx } {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${name}.json`, import.meta.url), "utf8"));
}

/** Re-encode a jsonParsed tx the way Helius raw webhooks / `encoding: "json"` deliver it. */
function toJsonEncoding(tx: RawTx): RawTx {
  const keys = accountKeysOf(tx);
  const objs = tx.transaction.message.accountKeys.filter((k) => typeof k !== "string");
  const staticKeys = objs.filter((k) => k.source !== "lookupTable").map((k) => k.pubkey);
  const loaded = objs.filter((k) => k.source === "lookupTable");
  const writable = loaded.filter((k) => k.writable).map((k) => k.pubkey);
  const readonly = loaded.filter((k) => !k.writable).map((k) => k.pubkey);
  const ordered = [...staticKeys, ...writable, ...readonly];
  // balances must follow the re-ordered key list
  const order = ordered.map((k) => keys.indexOf(k));
  const remap = (ix: RawInstruction): RawInstruction => {
    const programIdIndex = ordered.indexOf(ix.programId!);
    const p = ix.parsed;
    // parsed system transfer → raw SystemInstruction::Transfer bytes (u32 LE 2, u64 LE lamports)
    if (p && typeof p === "object" && "type" in p && p.type === "transfer" && "info" in p && ix.program === "system") {
      const info: { source: string; destination: string; lamports: number } = Object(p.info);
      const data = Buffer.alloc(12);
      data.writeUInt32LE(2, 0);
      data.writeBigUInt64LE(BigInt(info.lamports), 4);
      return { programIdIndex, accounts: [ordered.indexOf(info.source), ordered.indexOf(info.destination)], data: bs58.encode(data) };
    }
    return {
      programIdIndex,
      accounts: (ix.accounts ?? []).map((a) => (typeof a === "string" ? ordered.indexOf(a) : a)),
      data: ix.data ?? "",
    };
  };
  const meta = tx.meta!;
  const reindex = (list: typeof meta.preTokenBalances) =>
    (list ?? []).map((b) => ({ ...b, accountIndex: order.indexOf(b.accountIndex) }));
  return {
    ...tx,
    transaction: {
      ...tx.transaction,
      message: { accountKeys: staticKeys, instructions: tx.transaction.message.instructions.map(remap) },
    },
    meta: {
      ...meta,
      preBalances: order.map((i) => meta.preBalances[i]),
      postBalances: order.map((i) => meta.postBalances[i]),
      preTokenBalances: reindex(meta.preTokenBalances),
      postTokenBalances: reindex(meta.postTokenBalances),
      innerInstructions: (meta.innerInstructions ?? []).map((g) => ({ ...g, instructions: g.instructions.map(remap) })),
      loadedAddresses: { writable, readonly },
    },
  };
}

describe("normalizeTransaction (real mainnet fixtures)", () => {
  it("pump.fun curve buy: SOL spent ex fee, ATA rent added back, venue pump_curve", () => {
    const { wallet, tx } = fixture("pump-curve-buy");
    const { trades, transfers } = normalizeTransaction(tx, wallet);
    expect(transfers).toEqual([]);
    expect(trades).toHaveLength(1);
    const [t] = trades;
    expect(t).toMatchObject({
      side: "buy",
      mint: "99qSF9R2VEh6nv2qUU6WzZtuPb278TtiP1CwrB7VprQy",
      quoteMint: "SOL",
      venue: "pump_curve",
      decimals: 6,
      txIndex: 456,
    });
    expect(t.tokenAmount).toBeCloseTo(7_904_400.18846, 5);
    expect(t.quoteAmount).toBeCloseTo(1.000298849, 9);
    expect(t.feesSol).toBeCloseTo(0.000006851, 9);
  });

  it("Jupiter-routed buy creating the ATA: quote is the 3 SOL swapped, rent excluded", () => {
    const { wallet, tx } = fixture("jupiter-buy");
    const [t] = normalizeTransaction(tx, wallet).trades;
    expect(t).toMatchObject({ side: "buy", mint: "59XcJahU2Gzj6Vc3PcZdDTiv9yENiZVzhyrrQv8aH6XA", quoteMint: "SOL", venue: "jupiter" });
    expect(t.quoteAmount).toBeCloseTo(3, 6);
    expect(t.tokenAmount).toBeCloseTo(21_102_236.776359, 5);
  });

  it("sell that closes the token account: refunded rent is not counted as proceeds", () => {
    const { wallet, tx } = fixture("sell-close-ata");
    const { trades } = normalizeTransaction(tx, wallet);
    const sell = trades.find((t) => t.side === "sell")!;
    expect(sell).toBeDefined();
    const closedAccounts = (tx.meta!.preTokenBalances ?? []).filter(
      (b) => b.owner === wallet && b.mint === sell.mint && !(tx.meta!.postTokenBalances ?? []).some((p) => p.accountIndex === b.accountIndex),
    );
    expect(closedAccounts.length).toBeGreaterThan(0);
    // wallet's raw lamport gain includes the rent refund; the trade's quote must not
    const keys = accountKeysOf(tx);
    const w = keys.indexOf(wallet);
    const rawGain = (tx.meta!.postBalances[w] - tx.meta!.preBalances[w] + (keys[0] === wallet ? tx.meta!.fee : 0)) / 1e9;
    const refunded = closedAccounts.reduce((s, b) => s + tx.meta!.preBalances[b.accountIndex], 0) / 1e9;
    expect(refunded).toBeGreaterThan(0.001);
    expect(sell.quoteMint).toBe("SOL");
    expect(sell.quoteAmount).toBeLessThan(rawGain + 1e-9);
    expect(sell.quoteAmount).toBeCloseTo(rawGain + sell.feesSol - (tx.meta!.fee / 1e9) * (keys[0] === wallet ? 1 : 0) - refunded, 6);
  });

  it("airdropped token with no quote movement is a transfer, not a buy", () => {
    const { wallet, tx } = fixture("airdrop-transfer-in");
    const { trades, transfers } = normalizeTransaction(tx, wallet);
    expect(trades).toEqual([]);
    expect(transfers).toEqual([
      expect.objectContaining({ mint: "HDZVwCM5AyWRTfp231TXzjfNKsJpDHezLBD1McB3Nada", amount: 1, direction: "in" }),
    ]);
  });

  it("copy-bot tx that merely references the wallet yields nothing", () => {
    const { wallet, tx } = fixture("noise-copybot");
    expect(normalizeTransaction(tx, wallet)).toMatchObject({ trades: [], transfers: [] });
  });

  it("USDC → SOL conversion (quote ↔ quote) is not a token trade", () => {
    const { wallet, tx } = fixture("usdc-sell-dflow");
    expect(normalizeTransaction(tx, wallet)).toMatchObject({ trades: [], transfers: [] });
  });

  it("failed transactions are skipped", () => {
    const { wallet, tx } = fixture("pump-curve-buy");
    const failed = { ...tx, meta: { ...tx.meta!, err: { InstructionError: [1, { Custom: 6003 }] } } };
    expect(normalizeTransaction(failed, wallet).trades).toEqual([]);
  });

  it("json encoding with v0 loadedAddresses (Helius raw webhook shape) normalizes identically", () => {
    for (const name of ["pump-curve-buy", "jupiter-buy", "sell-close-ata"]) {
      const { wallet, tx } = fixture(name);
      const parsed = normalizeTransaction(tx, wallet);
      const raw = normalizeTransaction(toJsonEncoding(tx), wallet);
      expect(raw.trades.map((t) => ({ ...t, feesSol: +t.feesSol.toFixed(9) }))).toEqual(
        parsed.trades.map((t) => ({ ...t, feesSol: +t.feesSol.toFixed(9) })),
      );
    }
  });
});

describe("detectVenue", () => {
  it("single AMM wins, Jupiter for multi-AMM routes, priority otherwise", () => {
    expect(detectVenue(["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"])).toBe("pumpswap");
    expect(
      detectVenue([
        "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
        "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
      ]),
    ).toBe("jupiter");
    expect(detectVenue(["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"])).toBe("pump_curve");
    expect(detectVenue(["11111111111111111111111111111111"])).toBe("unknown");
  });
});
