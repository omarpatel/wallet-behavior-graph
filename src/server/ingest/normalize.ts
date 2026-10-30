/**
 * Balance-delta normalizer.
 *
 * Pure: getTransaction-shaped tx (jsonParsed or json encoding, legacy/v0/v1, Helius raw webhook items)
 * + tracked wallet → trades and non-swap transfers.
 *
 * SOL accounting: the wallet's effective SOL delta is its own lamport delta plus the lamport deltas of every
 * token account it owns in this tx. That single rule
 *  - folds WSOL into SOL (wrapped SOL lives in the token account's lamports),
 *  - adds back rent for an ATA created on a buy (lamports moved wallet → ATA net to zero),
 *  - subtracts rent refunded when a sell closes the ATA (ATA → wallet nets to zero).
 * The network fee (base + priority) and Jito tips paid by the wallet are excluded from the quote amount and
 * reported as feesSol.
 */
import bs58 from "bs58";
import {
  JITO_TIP_ACCOUNTS,
  QUOTE_MINTS,
  USDC_MINT,
  USDT_MINT,
  VENUE_PRIORITY,
  VENUE_PROGRAMS,
  WSOL_MINT,
  type Venue,
} from "./constants";

// ---------------------------------------------------------------- raw shapes

export type RawAccountKey = string | { pubkey: string; signer?: boolean; writable?: boolean; source?: string };

export interface RawInstruction {
  programId?: string;
  programIdIndex?: number;
  accounts?: (string | number)[];
  data?: string;
  parsed?: unknown;
  program?: string;
  stackHeight?: number | null;
}

export interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmount?: number | null; uiAmountString?: string };
}

export interface RawMeta {
  err: unknown;
  fee: number;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances?: RawTokenBalance[] | null;
  postTokenBalances?: RawTokenBalance[] | null;
  innerInstructions?: { index: number; instructions: RawInstruction[] }[] | null;
  loadedAddresses?: { writable: string[]; readonly: string[] } | null;
  logMessages?: string[] | null;
}

export interface RawTx {
  slot: number;
  blockTime?: number | null;
  /** getTransaction (2026) and Helius gTFA. */
  transactionIndex?: number;
  /** Helius raw webhook payloads. */
  indexWithinBlock?: number;
  version?: number | "legacy";
  meta: RawMeta | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: RawAccountKey[]; instructions: RawInstruction[] };
  };
}

// ---------------------------------------------------------------- output shapes

export type QuoteMint = "SOL" | "USDC" | "USDT" | (string & {});

export interface NormalizedTrade {
  signature: string;
  slot: number;
  txIndex: number;
  blockTime: number;
  side: "buy" | "sell";
  mint: string;
  decimals: number;
  tokenAmount: number; // UI units
  /** "SOL" | "USDC" | "USDT", or the counter-token mint for token→token swaps. */
  quoteMint: QuoteMint;
  quoteAmount: number; // UI units, ex network fee / tips
  feesSol: number;
  venue: Venue;
}

export interface NormalizedTransfer {
  signature: string;
  slot: number;
  blockTime: number;
  mint: string;
  decimals: number;
  amount: number; // UI units, positive
  direction: "in" | "out";
}

export interface NormalizedTx {
  signature: string;
  trades: NormalizedTrade[];
  transfers: NormalizedTransfer[];
}

// ---------------------------------------------------------------- helpers

/** Minimum quote movement that counts as a trade leg (below: dust / rent noise). */
const MIN_SOL_LEG = 0.0005;
const MIN_STABLE_LEG = 0.05;

/** Full account key list: static keys + v0/v1 lookup-table addresses (jsonParsed already inlines them). */
export function accountKeysOf(tx: RawTx): string[] {
  const raw = tx.transaction.message.accountKeys;
  const keys = raw.map((k) => (typeof k === "string" ? k : k.pubkey));
  const inlined = raw.some((k) => typeof k !== "string" && k.source === "lookupTable");
  const loaded = tx.meta?.loadedAddresses;
  if (!inlined && loaded && keys.length < tx.meta!.preBalances.length) {
    keys.push(...loaded.writable, ...loaded.readonly);
  }
  return keys;
}

function programIdOf(ix: RawInstruction, keys: string[]): string | undefined {
  return ix.programId ?? (ix.programIdIndex != null ? keys[ix.programIdIndex] : undefined);
}

function allInstructions(tx: RawTx): RawInstruction[] {
  const inner = tx.meta?.innerInstructions ?? [];
  return [...tx.transaction.message.instructions, ...inner.flatMap((g) => g.instructions)];
}

/** Every program invoked (outer + CPI). */
export function programIdsOf(tx: RawTx): string[] {
  const keys = accountKeysOf(tx);
  const ids = new Set<string>();
  for (const ix of allInstructions(tx)) {
    const id = programIdOf(ix, keys);
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * Venue: a single DEX program → that venue; an aggregator route (Jupiter + several AMMs) → jupiter;
 * several AMMs without Jupiter (terminal routers) → most specific by VENUE_PRIORITY.
 */
export function detectVenue(programIds: string[]): Venue {
  const venues = new Set<Venue>();
  for (const id of programIds) {
    const v = VENUE_PROGRAMS[id];
    if (v) venues.add(v);
  }
  const amms = [...venues].filter((v) => v !== "jupiter");
  if (amms.length === 1) return amms[0];
  if (venues.has("jupiter")) return "jupiter";
  return VENUE_PRIORITY.find((v) => venues.has(v)) ?? "unknown";
}

/** jsonParsed system `transfer` instruction info, or null. */
function parsedSystemTransfer(parsed: unknown): { source: string; destination: string; lamports: number } | null {
  if (!parsed || typeof parsed !== "object" || !("type" in parsed) || parsed.type !== "transfer" || !("info" in parsed)) return null;
  const info = parsed.info;
  if (!info || typeof info !== "object" || !("source" in info) || !("destination" in info) || !("lamports" in info)) return null;
  const { source, destination, lamports } = info;
  return typeof source === "string" && typeof destination === "string" && typeof lamports === "number"
    ? { source, destination, lamports }
    : null;
}

/** Lamports the wallet sent to Jito tip accounts (system transfers, parsed or raw). */
function jitoTipLamports(tx: RawTx, wallet: string, keys: string[]): number {
  let tips = 0;
  for (const ix of allInstructions(tx)) {
    if (programIdOf(ix, keys) !== "11111111111111111111111111111111") continue;
    const transfer = parsedSystemTransfer(ix.parsed);
    if (transfer) {
      if (transfer.source === wallet && JITO_TIP_ACCOUNTS[transfer.destination]) tips += transfer.lamports;
      continue;
    }
    if (ix.data && ix.accounts && ix.accounts.length >= 2) {
      const from = typeof ix.accounts[0] === "number" ? keys[ix.accounts[0]] : ix.accounts[0];
      const to = typeof ix.accounts[1] === "number" ? keys[ix.accounts[1]] : ix.accounts[1];
      if (from !== wallet || !JITO_TIP_ACCOUNTS[to]) continue;
      const data = bs58.decode(ix.data);
      // SystemInstruction::Transfer = u32 LE 2, then u64 LE lamports
      if (data.length === 12 && data[0] === 2 && data[1] === 0 && data[2] === 0 && data[3] === 0) {
        tips += Number(Buffer.from(data).readBigUInt64LE(4));
      }
    }
  }
  return tips;
}

interface MintDelta {
  raw: bigint;
  decimals: number;
}

const toUi = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;

// ---------------------------------------------------------------- main

export function normalizeTransaction(tx: RawTx, wallet: string): NormalizedTx {
  const signature = tx.transaction.signatures[0];
  const empty: NormalizedTx = { signature, trades: [], transfers: [] };
  const meta = tx.meta;
  if (!meta || meta.err != null || tx.blockTime == null) return empty;

  const keys = accountKeysOf(tx);
  const walletIdx = keys.indexOf(wallet);
  const pre = (meta.preTokenBalances ?? []).filter((b) => b.owner === wallet);
  const post = (meta.postTokenBalances ?? []).filter((b) => b.owner === wallet);
  if (walletIdx < 0 && !pre.length && !post.length) return empty;

  // --- effective SOL delta (lamports)
  let lamports = walletIdx >= 0 ? meta.postBalances[walletIdx] - meta.preBalances[walletIdx] : 0;
  const ownedAccounts = new Set<number>([...pre, ...post].map((b) => b.accountIndex));
  for (const idx of ownedAccounts) {
    if (idx === walletIdx) continue;
    lamports += (meta.postBalances[idx] ?? 0) - (meta.preBalances[idx] ?? 0);
  }
  let feeLamports = 0;
  if (keys[0] === wallet) feeLamports += meta.fee;
  feeLamports += jitoTipLamports(tx, wallet, keys);
  lamports += feeLamports;
  const feesSol = feeLamports / 1e9;
  const solDelta = lamports / 1e9;

  // --- token deltas per mint (owner == wallet); WSOL already counted through lamports
  const deltas = new Map<string, MintDelta>();
  for (const [list, sign] of [
    [post, BigInt(1)],
    [pre, BigInt(-1)],
  ] as const) {
    for (const b of list) {
      if (b.mint === WSOL_MINT) continue;
      const d = deltas.get(b.mint) ?? { raw: BigInt(0), decimals: b.uiTokenAmount.decimals };
      d.raw += sign * BigInt(b.uiTokenAmount.amount);
      deltas.set(b.mint, d);
    }
  }
  const stable = (mint: string) => {
    const d = deltas.get(mint);
    return d ? toUi(d.raw, d.decimals) : 0;
  };
  const usdcDelta = stable(USDC_MINT);
  const usdtDelta = stable(USDT_MINT);

  const moved = [...deltas.entries()].filter(([mint, d]) => !QUOTE_MINTS[mint] && d.raw !== BigInt(0));
  if (!moved.length) return empty; // SOL/stable-only movement (transfers, quote conversions)
  // 0-decimal mints are NFTs / semi-fungibles: never profiled as trades, kept as transfers
  const tokens = moved.filter(([, d]) => d.decimals > 0);
  const nfts = moved.filter(([, d]) => d.decimals === 0);

  const base = { signature, slot: tx.slot, blockTime: tx.blockTime };
  const txIndex = tx.transactionIndex ?? tx.indexWithinBlock ?? 0;
  const venue = detectVenue(programIdsOf(tx));
  const ins = tokens.filter(([, d]) => d.raw > BigInt(0));
  const outs = tokens.filter(([, d]) => d.raw < BigInt(0));

  const transfersOf = (list: [string, MintDelta][]): NormalizedTransfer[] =>
    list.map(([mint, d]) => ({
      ...base,
      mint,
      decimals: d.decimals,
      amount: Math.abs(toUi(d.raw, d.decimals)),
      direction: d.raw > BigInt(0) ? "in" : "out",
    }));

  /** Quote leg in the given direction (−1 spent, +1 received): stables first, then SOL. */
  const quoteLeg = (dir: -1 | 1): { mint: QuoteMint; amount: number } | null => {
    const usdc = usdcDelta * dir;
    const usdt = usdtDelta * dir;
    if (usdc >= MIN_STABLE_LEG || usdt >= MIN_STABLE_LEG) {
      return usdc >= usdt ? { mint: "USDC", amount: usdc } : { mint: "USDT", amount: usdt };
    }
    const sol = solDelta * dir;
    return sol >= MIN_SOL_LEG ? { mint: "SOL", amount: sol } : null;
  };

  const trade = (side: "buy" | "sell", mint: string, d: MintDelta, quote: { mint: QuoteMint; amount: number }, fees: number): NormalizedTrade => ({
    ...base,
    txIndex,
    side,
    mint,
    decimals: d.decimals,
    tokenAmount: Math.abs(toUi(d.raw, d.decimals)),
    quoteMint: quote.mint,
    quoteAmount: quote.amount,
    feesSol: fees,
    venue,
  });

  // single token bought with quote
  if (ins.length === 1 && !outs.length) {
    const q = quoteLeg(-1);
    if (q) return { signature, trades: [trade("buy", ins[0][0], ins[0][1], q, feesSol)], transfers: transfersOf(nfts) };
    return { signature, trades: [], transfers: transfersOf(moved) };
  }
  // single token sold for quote
  if (outs.length === 1 && !ins.length) {
    const q = quoteLeg(1);
    if (q) return { signature, trades: [trade("sell", outs[0][0], outs[0][1], q, feesSol)], transfers: transfersOf(nfts) };
    return { signature, trades: [], transfers: transfersOf(moved) };
  }
  // token → token (e.g. pump multi_hop_swap): SELL A quoted in B + BUY B quoted in A
  if (ins.length === 1 && outs.length === 1) {
    const [aMint, a] = outs[0];
    const [bMint, b] = ins[0];
    return {
      signature,
      trades: [
        trade("sell", aMint, a, { mint: bMint, amount: toUi(b.raw, b.decimals) }, feesSol),
        trade("buy", bMint, b, { mint: aMint, amount: Math.abs(toUi(a.raw, a.decimals)) }, 0),
      ],
      transfers: transfersOf(nfts),
    };
  }
  // several tokens moved in one tx without a single attributable price: record as transfers (no PnL basis)
  return { signature, trades: [], transfers: transfersOf(moved) };
}
