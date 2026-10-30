// Chain actions: server builds an unsigned tx (fee payer = user wallet) → wallet signs first →
// submitAction validates intent, co-signs with server keys, sends, confirms and applies DB effects.
// Imported by the worker (plain tsx): no "server-only", no next/* imports.
import { randomUUID } from "node:crypto";
import {
  addPlugin,
  approvePluginAuthority,
  collectionAddress,
  create,
  fetchAsset,
  fetchCollection,
  removePlugin,
  revokePluginAuthority,
  transfer,
  updatePlugin,
  type AssetV1,
  type PluginAuthority,
} from "@metaplex-foundation/mpl-core";
import { setComputeUnitLimit, setComputeUnitPrice, transferSol } from "@metaplex-foundation/mpl-toolbox";
import {
  createNoopSigner,
  lamports,
  publicKey,
  signTransaction,
  transactionBuilder,
  type BlockhashWithExpiryBlockHeight,
  type KeypairSigner,
  type Transaction,
  type TransactionBuilder,
} from "@metaplex-foundation/umi";
import { z } from "zod";
import { base58 } from "@metaplex-foundation/umi/serializers";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { ChainActionKind } from "@/db/schema";
import { env } from "@/lib/env";
import { HttpError } from "@/server/auth/http";
import { brainPublicName, ensureCollection } from "./collection";
import { revenueSplit, routePayments, saleSplit, type Payment } from "./splits";
import { assertSameIntent, assertSignedBy } from "./txguard";
import {
  assetSignerFor,
  getBlockHeight,
  getMarketDelegate,
  getMintAuthority,
  getTreasury,
  getUmi,
  isValidAddress,
  rentExemptMinimum,
} from "./umi";

const { chainActions, listings, seats, brains, ledger } = schema;

/** Priority fee (micro-lamports per CU). Wallets may override ComputeBudget; the guard allows it. */
const PRIORITY_MICROLAMPORTS = 20_000;
// Measured on Core (localnet clone of devnet program): mint 26k, renew 0.6k, list 29k (re-list with
// plugin replacement 50k), buy 26k, delist 49k. Limits keep ~2× headroom.
const CU_LIMIT: Record<"mint" | "renew" | "list" | "delist" | "buy", number> = {
  mint: 60_000,
  renew: 5_000,
  list: 100_000,
  delist: 100_000,
  buy: 60_000,
};
/** Keeps seller proceeds above the rent-exempt minimum and fees meaningful. */
export const MIN_LIST_LAMPORTS = 10_000_000;
const DAY = 86_400;

export interface BuiltAction {
  /** null when the request resolved without a transaction (e.g. delisting an already-stale listing). */
  actionId: string | null;
  transaction: string | null;
  kind: ChainActionKind;
  asset?: string;
}

export interface SubmitResult {
  signature: string;
  kind: ChainActionKind;
  asset?: string;
}

type Action = typeof chainActions.$inferSelect;
type Brain = typeof brains.$inferSelect;

// Payloads are written by the builders and re-validated when applied.
const revenuePayloadSchema = z.object({
  priceLamports: z.string(),
  kolLamports: z.string(),
  treasuryLamports: z.string(),
  kolPaidInline: z.boolean(),
  termDays: z.number().int().positive(),
});
const mintPayloadSchema = revenuePayloadSchema.extend({ asset: z.string() });
const buyPayloadSchema = z.object({
  listingId: z.string(),
  seller: z.string(),
  priceLamports: z.string(),
  feeLamports: z.string(),
  royaltyLamports: z.string(),
  kolRoyaltyLamports: z.string(),
  kolPaidInline: z.boolean(),
});
type RevenuePayload = z.infer<typeof revenuePayloadSchema>;
type BuyPayload = z.infer<typeof buyPayloadSchema>;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

const nowSec = () => Math.floor(Date.now() / 1000);

async function loadBrain(brainId: string): Promise<Brain> {
  const brain = await getDb().query.brains.findFirst({ where: eq(brains.id, brainId) });
  if (!brain) throw new HttpError(404, "Brain not found");
  return brain;
}

async function loadSeat(asset: unknown) {
  if (!isValidAddress(asset)) throw new HttpError(400, "Invalid asset address");
  const seat = await getDb().query.seats.findFirst({ where: eq(seats.asset, asset) });
  if (!seat) throw new HttpError(404, "Seat not found");
  return seat;
}

/** Addresses holding any lamports (existing accounts accept transfers of any size). */
async function fundedAccounts(addresses: string[]): Promise<Set<string>> {
  const unique = [...new Set(addresses)];
  const out = new Set<string>();
  for (let i = 0; i < unique.length; i += 100) {
    const accts = await getUmi().rpc.getAccounts(unique.slice(i, i + 100).map((a) => publicKey(a)));
    for (const a of accts) if (a.exists && a.lamports.basisPoints > 0n) out.add(a.publicKey);
  }
  return out;
}

/** Applies the rent-exempt routing and returns transfer instructions + whether the KOL got paid inline. */
async function planTransfers(payments: Payment[], buyer: string) {
  const treasury = getTreasury();
  const [funded, rentMin] = await Promise.all([fundedAccounts(payments.map((p) => p.to)), rentExemptMinimum()]);
  const routed = routePayments(payments, treasury, funded, rentMin);
  const payer = createNoopSigner(publicKey(buyer));
  let b = transactionBuilder();
  for (const t of routed.transfers) {
    b = b.add(transferSol(getUmi(), { source: payer, destination: publicKey(t.to), amount: lamports(t.lamports) }));
  }
  return { builder: b, kolRerouted: routed.rerouted.some((p) => p.role === "kol") };
}

/** Primary / renewal revenue split; KOL share inline only when claimed and not held. */
async function revenueTransfers(brain: Brain, price: bigint, buyer: string) {
  const split = revenueSplit(price, brain.kolShareBps);
  const kolEligible = brain.status === "claimed" && !!brain.kolPayoutWallet && !brain.revenueHeld && split.kol > 0n;
  const treasury = getTreasury();
  const payments: Payment[] = kolEligible
    ? [
        { to: treasury, lamports: split.treasury, role: "treasury" },
        { to: brain.kolPayoutWallet!, lamports: split.kol, role: "kol" },
      ]
    : [{ to: treasury, lamports: price, role: "treasury" }];
  const { builder, kolRerouted } = await planTransfers(payments, buyer);
  const kolPaidInline = kolEligible && !kolRerouted;
  return {
    builder,
    payload: {
      priceLamports: price.toString(),
      kolLamports: split.kol.toString(),
      treasuryLamports: split.treasury.toString(),
      kolPaidInline,
      termDays: brain.termDays,
    } satisfies RevenuePayload,
  };
}

function finalize(body: TransactionBuilder, payer: string, kind: keyof typeof CU_LIMIT, latest: BlockhashWithExpiryBlockHeight) {
  const umi = getUmi();
  const tx = transactionBuilder()
    .add(setComputeUnitLimit(umi, { units: CU_LIMIT[kind] }))
    .add(setComputeUnitPrice(umi, { microLamports: PRIORITY_MICROLAMPORTS }))
    .add(body)
    .setFeePayer(createNoopSigner(publicKey(payer)))
    .setBlockhash(latest)
    .setVersion(0)
    .build(umi);
  return Buffer.from(umi.transactions.serialize(tx)).toString("base64");
}

const latestBlockhash = () => getUmi().rpc.getLatestBlockhash({ commitment: "confirmed" });

async function insertAction(a: {
  id: string;
  kind: ChainActionKind;
  wallet: string;
  brainId: string;
  asset?: string;
  listingId?: string;
  payload: object;
  txBase64: string;
  lastValidBlockHeight: number;
}) {
  await getDb()
    .insert(chainActions)
    .values({
      id: a.id,
      kind: a.kind,
      wallet: a.wallet,
      brainId: a.brainId,
      asset: a.asset,
      listingId: a.listingId,
      payloadJson: JSON.stringify(a.payload),
      txBase64: a.txBase64,
      lastValidBlockHeight: a.lastValidBlockHeight,
    });
}

const isMarketDelegate = (auth: PluginAuthority | undefined, delegate: string) =>
  auth?.type === "Address" && auth.address === delegate;

// ---------------------------------------------------------------- mint

/** Reserves the next seat number and returns an unsigned mint tx (buyer pays price + rent + Core fee). */
export async function buildMintAction(wallet: string, brainId: string): Promise<BuiltAction> {
  const brain = await loadBrain(brainId);
  if (!brain.listed) throw new HttpError(403, "Seats for this brain are not on sale");
  const collectionAddr = await ensureCollection(brainId);
  const umi = getUmi();
  const [collection, latest, height] = await Promise.all([
    fetchCollection(umi, publicKey(collectionAddr)),
    latestBlockhash(),
    getBlockHeight(),
  ]);
  if (collection.numMinted >= brain.seatSupply) throw new HttpError(409, "Sold out");

  const { builder: payments, payload } = await revenueTransfers(brain, BigInt(brain.seatPriceLamports), wallet);
  const mintAuthority = getMintAuthority();
  const buyer = createNoopSigner(publicKey(wallet));
  const name = brainPublicName(brain);
  const db = getDb();
  const live = sql`(last_valid_block_height >= ${height} OR signature IS NOT NULL)`;

  // Optimistic reservation: pick the lowest free number, then insert only if supply and number are
  // still free in one atomic INSERT … SELECT … WHERE. Retry on contention.
  for (let attempt = 0; attempt < 5; attempt++) {
    const taken = await db.all<{ n: number }>(sql`
      SELECT number AS n FROM seats WHERE brain_id = ${brainId}
      UNION SELECT seat_number AS n FROM chain_actions
      WHERE brain_id = ${brainId} AND kind = 'mint' AND status = 'pending' AND ${live}`);
    const used = new Set(taken.map((r) => r.n));
    if (used.size >= brain.seatSupply) throw new HttpError(409, "Sold out");
    let number = 1;
    while (used.has(number)) number++;

    const actionId = randomUUID();
    const asset = assetSignerFor(actionId);
    const body = payments.add(
      create(umi, {
        asset,
        collection,
        authority: mintAuthority,
        payer: buyer,
        owner: buyer.publicKey,
        name: `${name} Seat #${number}`.slice(0, 64),
        uri: `${env().PUBLIC_URL}/api/meta/${brainId}/${number}.json`,
        plugins: [
          { type: "Edition", number },
          {
            type: "Attributes",
            attributeList: [
              { key: "brainId", value: brainId },
              { key: "seat", value: String(number) },
            ],
          },
        ],
      }),
    );
    const txBase64 = finalize(body, wallet, "mint", latest);
    const payloadJson = JSON.stringify({ ...payload, asset: asset.publicKey });
    const res = await db.run(sql`
      INSERT INTO chain_actions (id, kind, wallet, brain_id, asset, seat_number, payload_json, tx_base64, last_valid_block_height, status)
      SELECT ${actionId}, 'mint', ${wallet}, ${brainId}, ${asset.publicKey}, ${number}, ${payloadJson}, ${txBase64}, ${latest.lastValidBlockHeight}, 'pending'
      WHERE (SELECT count(*) FROM seats WHERE brain_id = ${brainId})
          + (SELECT count(*) FROM chain_actions WHERE brain_id = ${brainId} AND kind = 'mint' AND status = 'pending' AND ${live}) < ${brain.seatSupply}
        AND NOT EXISTS (SELECT 1 FROM seats WHERE brain_id = ${brainId} AND number = ${number})
        AND NOT EXISTS (SELECT 1 FROM chain_actions WHERE brain_id = ${brainId} AND kind = 'mint'
                        AND status = 'pending' AND seat_number = ${number} AND ${live})`);
    if (res.rowsAffected === 1) return { actionId, transaction: txBase64, kind: "mint", asset: asset.publicKey };
  }
  throw new HttpError(409, "Seat reservation contention; try again");
}

// ---------------------------------------------------------------- renew

/** SOL transfers only: the wallet signs, the server verifies intent and sends. */
export async function buildRenewAction(wallet: string, assetAddr: unknown): Promise<BuiltAction> {
  const seat = await loadSeat(assetAddr);
  const brain = await loadBrain(seat.brainId);
  const onChain = await fetchAsset(getUmi(), publicKey(seat.asset));
  if (onChain.owner !== wallet) throw new HttpError(403, "Only the current seat owner can renew it");
  const [{ builder, payload }, latest] = await Promise.all([
    revenueTransfers(brain, BigInt(brain.renewalPriceLamports), wallet),
    latestBlockhash(),
  ]);
  const id = randomUUID();
  const txBase64 = finalize(builder, wallet, "renew", latest);
  await insertAction({
    id,
    kind: "renew",
    wallet,
    brainId: brain.id,
    asset: seat.asset,
    payload,
    txBase64,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });
  return { actionId: id, transaction: txBase64, kind: "renew", asset: seat.asset };
}

// ---------------------------------------------------------------- list

/** Escrowless listing: TransferDelegate + frozen FreezeDelegate → market delegate (seat stays in wallet). */
export async function buildListAction(wallet: string, assetAddr: unknown, priceLamports: unknown): Promise<BuiltAction> {
  const seat = await loadSeat(assetAddr);
  if (typeof priceLamports !== "number" && typeof priceLamports !== "string") {
    throw new HttpError(400, "priceLamports required");
  }
  const price = Number(priceLamports);
  if (!Number.isSafeInteger(price) || price < MIN_LIST_LAMPORTS) {
    throw new HttpError(400, `priceLamports must be an integer ≥ ${MIN_LIST_LAMPORTS}`);
  }
  const db = getDb();
  const height = await getBlockHeight();
  const open = await db
    .select({ id: listings.id, status: listings.status, lvbh: chainActions.lastValidBlockHeight, sig: chainActions.signature })
    .from(listings)
    .leftJoin(chainActions, and(eq(chainActions.listingId, listings.id), eq(chainActions.kind, "list")))
    .where(and(eq(listings.asset, seat.asset), inArray(listings.status, ["pending", "active"])));
  if (open.some((l) => l.status === "active" || (l.lvbh ?? 0) >= height || l.sig)) {
    throw new HttpError(409, "Seat already listed");
  }

  const umi = getUmi();
  const asset = await fetchAsset(umi, publicKey(seat.asset));
  if (asset.owner !== wallet) throw new HttpError(403, "You do not own this seat");
  if (asset.freezeDelegate?.frozen) throw new HttpError(409, "Seat is frozen (already listed elsewhere?)");
  const collection = collectionAddress(asset);
  const owner = createNoopSigner(publicKey(wallet));
  const delegate: PluginAuthority = { type: "Address", address: getMarketDelegate().publicKey };
  const base = { asset: asset.publicKey, collection, authority: owner, payer: owner };

  let b = transactionBuilder();
  b = asset.transferDelegate
    ? b.add(approvePluginAuthority(umi, { ...base, plugin: { type: "TransferDelegate" }, newAuthority: delegate }))
    : b.add(addPlugin(umi, { ...base, plugin: { type: "TransferDelegate", authority: delegate } }));
  // After a transfer the FreezeDelegate plugin stays (authority Owner); replace it to re-delegate.
  if (asset.freezeDelegate) b = b.add(removePlugin(umi, { ...base, plugin: { type: "FreezeDelegate" } }));
  b = b.add(addPlugin(umi, { ...base, plugin: { type: "FreezeDelegate", frozen: true, authority: delegate } }));

  const latest = await latestBlockhash();
  const txBase64 = finalize(b, wallet, "list", latest);
  const id = randomUUID();
  const listingId = randomUUID();
  await db.insert(listings).values({ id: listingId, asset: seat.asset, brainId: seat.brainId, seller: wallet, priceLamports: price });
  await db.update(seats).set({ owner: wallet, ownerCheckedAt: nowSec() }).where(eq(seats.asset, seat.asset));
  await insertAction({
    id,
    kind: "list",
    wallet,
    brainId: seat.brainId,
    asset: seat.asset,
    listingId,
    payload: { listingId, priceLamports: String(price) },
    txBase64,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });
  return { actionId: id, transaction: txBase64, kind: "list", asset: seat.asset };
}

// ---------------------------------------------------------------- delist

async function cancelListing(listingId: string) {
  await getDb()
    .update(listings)
    .set({ status: "cancelled", updatedAt: nowSec() })
    .where(and(eq(listings.id, listingId), inArray(listings.status, ["pending", "active"])));
}

/** Seller revokes TransferDelegate; the server (freeze authority) thaws and revokes FreezeDelegate. */
export async function buildDelistAction(wallet: string, listingId: unknown): Promise<BuiltAction> {
  if (typeof listingId !== "string") throw new HttpError(400, "listingId required");
  const listing = await getDb().query.listings.findFirst({ where: eq(listings.id, listingId) });
  if (!listing) throw new HttpError(404, "Listing not found");
  if (listing.seller !== wallet) throw new HttpError(403, "Not your listing");
  if (listing.status !== "active") throw new HttpError(409, `Listing is ${listing.status}`);

  const umi = getUmi();
  const asset = await fetchAsset(umi, publicKey(listing.asset));
  if (asset.owner !== wallet) {
    // Seat moved off-market: the delegates were reset by Core; nothing to undo on-chain.
    await cancelListing(listing.id);
    return { actionId: null, transaction: null, kind: "delist", asset: listing.asset };
  }
  const md = getMarketDelegate();
  const seller = createNoopSigner(publicKey(wallet));
  const collection = collectionAddress(asset);
  let b = transactionBuilder();
  if (asset.freezeDelegate && isMarketDelegate(asset.freezeDelegate.authority, md.publicKey)) {
    const fbase = { asset: asset.publicKey, collection, authority: md, payer: seller };
    if (asset.freezeDelegate.frozen) {
      b = b.add(updatePlugin(umi, { ...fbase, plugin: { type: "FreezeDelegate", frozen: false } }));
    }
    b = b.add(revokePluginAuthority(umi, { ...fbase, plugin: { type: "FreezeDelegate" } }));
  }
  if (asset.transferDelegate && isMarketDelegate(asset.transferDelegate.authority, md.publicKey)) {
    b = b.add(
      revokePluginAuthority(umi, {
        asset: asset.publicKey,
        collection,
        authority: seller,
        payer: seller,
        plugin: { type: "TransferDelegate" },
      }),
    );
  }
  if (b.items.length === 0) {
    await cancelListing(listing.id);
    return { actionId: null, transaction: null, kind: "delist", asset: listing.asset };
  }
  const latest = await latestBlockhash();
  const txBase64 = finalize(b, wallet, "delist", latest);
  const id = randomUUID();
  await insertAction({
    id,
    kind: "delist",
    wallet,
    brainId: listing.brainId,
    asset: listing.asset,
    listingId: listing.id,
    payload: { listingId: listing.id },
    txBase64,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });
  return { actionId: id, transaction: txBase64, kind: "delist", asset: listing.asset };
}

// ---------------------------------------------------------------- buy

/** Atomic buy: buyer pays seller + royalties + market fee; the server thaws and transfers as delegate. */
export async function buildBuyAction(wallet: string, listingId: unknown): Promise<BuiltAction> {
  if (typeof listingId !== "string") throw new HttpError(400, "listingId required");
  const db = getDb();
  const listing = await db.query.listings.findFirst({ where: eq(listings.id, listingId) });
  if (!listing) throw new HttpError(404, "Listing not found");
  if (listing.status !== "active") throw new HttpError(409, `Listing is ${listing.status}`);
  if (listing.seller === wallet) throw new HttpError(400, "You cannot buy your own listing");
  const brain = await loadBrain(listing.brainId);

  const umi = getUmi();
  const md = getMarketDelegate();
  const asset: AssetV1 = await fetchAsset(umi, publicKey(listing.asset));
  if (asset.owner !== listing.seller || !isMarketDelegate(asset.transferDelegate?.authority, md.publicKey)) {
    await cancelListing(listing.id);
    throw new HttpError(409, "Listing is no longer valid (seat moved or delegate revoked)");
  }
  const collection = await fetchCollection(umi, collectionAddress(asset)!);
  const roy = asset.royalties ?? collection.royalties;
  const claimed = brain.status === "claimed" && !!brain.kolPayoutWallet;
  const treasury = getTreasury();
  const split = saleSplit({
    price: BigInt(listing.priceLamports),
    feeBps: env().MARKET_FEE_BPS,
    royaltyBps: roy?.basisPoints ?? 0,
    creators: (roy?.creators ?? []).map((c) => ({ address: c.address, percentage: c.percentage })),
    seller: listing.seller,
    treasury,
    kolWallet: claimed ? brain.kolPayoutWallet : null,
    kolInline: claimed && !brain.revenueHeld,
  });
  const { builder, kolRerouted } = await planTransfers(split.payments, wallet);
  const buyer = createNoopSigner(publicKey(wallet));
  let b = builder;
  if (asset.freezeDelegate?.frozen) {
    b = b.add(
      updatePlugin(umi, {
        asset: asset.publicKey,
        collection: collection.publicKey,
        plugin: { type: "FreezeDelegate", frozen: false },
        authority: md,
        payer: buyer,
      }),
    );
  }
  b = b.add(transfer(umi, { asset, collection, newOwner: buyer.publicKey, authority: md, payer: buyer }));

  const latest = await latestBlockhash();
  const txBase64 = finalize(b, wallet, "buy", latest);
  const id = randomUUID();
  const payload: BuyPayload = {
    listingId: listing.id,
    seller: listing.seller,
    priceLamports: String(listing.priceLamports),
    feeLamports: split.fee.toString(),
    royaltyLamports: split.royaltyTotal.toString(),
    kolRoyaltyLamports: split.kolRoyalty.toString(),
    kolPaidInline: split.kolRoyaltyInline && !kolRerouted,
  };
  await insertAction({
    id,
    kind: "buy",
    wallet,
    brainId: listing.brainId,
    asset: listing.asset,
    listingId: listing.id,
    payload,
    txBase64,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });
  return { actionId: id, transaction: txBase64, kind: "buy", asset: listing.asset };
}

// ---------------------------------------------------------------- submit

/** Server keys allowed to co-sign each kind of action. */
function serverSigners(action: Action): KeypairSigner[] {
  switch (action.kind) {
    case "mint":
      return [assetSignerFor(action.id), getMintAuthority()];
    case "delist":
    case "buy":
      return [getMarketDelegate()];
    default:
      return [];
  }
}

const decodeTx = (b64: string): Transaction => getUmi().transactions.deserialize(Buffer.from(b64, "base64"));

/**
 * Validates the wallet-signed transaction against the stored build, co-signs, sends, confirms and
 * applies DB effects. Idempotent for an already-confirmed action.
 */
export async function submitAction(actionId: unknown, signedTxB64: unknown, wallet: string): Promise<SubmitResult> {
  if (typeof actionId !== "string" || typeof signedTxB64 !== "string") {
    throw new HttpError(400, "actionId and signedTransaction required");
  }
  const db = getDb();
  const action = await db.query.chainActions.findFirst({ where: eq(chainActions.id, actionId) });
  if (!action) throw new HttpError(404, "Action not found");
  if (action.wallet !== wallet) throw new HttpError(403, "Action belongs to another wallet");
  const result: SubmitResult = { signature: action.signature ?? "", kind: action.kind, asset: action.asset ?? undefined };
  if (action.status === "confirmed") return result;
  if (action.status !== "pending") throw new HttpError(409, `Action is ${action.status}; rebuild it`);

  const umi = getUmi();
  const built = decodeTx(action.txBase64);
  let signed: Transaction;
  try {
    signed = decodeTx(signedTxB64);
  } catch {
    throw new HttpError(400, "signedTransaction is not a valid transaction");
  }
  try {
    assertSameIntent(built, signed);
    assertSignedBy(signed, publicKey(wallet), (m, s, p) => umi.eddsa.verify(m, s, p));
  } catch (e) {
    throw new HttpError(400, `Rejected transaction: ${errorMessage(e)}`);
  }
  if ((await getBlockHeight()) > action.lastValidBlockHeight) {
    await markEnded(action, "expired", "Blockhash expired before submission");
    throw new HttpError(410, "Transaction expired; please try again");
  }

  const required = signed.message.accounts.slice(0, signed.message.header.numRequiredSignatures);
  const candidates = serverSigners(action);
  const coSigners: KeypairSigner[] = [];
  for (const pk of required) {
    if (pk === wallet) continue;
    const s = candidates.find((c) => c.publicKey === pk);
    if (!s) throw new HttpError(400, `Unexpected required signer ${pk}`);
    coSigners.push(s);
  }
  const full = coSigners.length ? await signTransaction(signed, coSigners) : signed;
  const sigBytes = full.signatures[0];
  const signature = base58.deserialize(sigBytes)[0];
  // Record before sending: makes the reservation "live" past its blockheight and lets reconciliation find it.
  await db.update(chainActions).set({ signature }).where(and(eq(chainActions.id, action.id), eq(chainActions.status, "pending")));

  try {
    await umi.rpc.sendTransaction(full, { skipPreflight: false, preflightCommitment: "confirmed" });
  } catch (e) {
    const [status] = await umi.rpc.getSignatureStatuses([sigBytes], { searchTransactionHistory: true });
    if (!status) {
      const msg = errorMessage(e);
      await markEnded(action, "failed", msg);
      throw new HttpError(400, `Transaction failed simulation: ${msg}`);
    }
  }

  let err: unknown = null;
  try {
    const res = await umi.rpc.confirmTransaction(sigBytes, {
      commitment: "confirmed",
      strategy: { type: "blockhash", blockhash: built.message.blockhash, lastValidBlockHeight: action.lastValidBlockHeight },
    });
    err = res.value.err;
  } catch (e) {
    const [status] = await umi.rpc.getSignatureStatuses([sigBytes], { searchTransactionHistory: true });
    if (status?.error) err = status.error;
    else if (!status || status.commitment === "processed") {
      if (e instanceof Error && e.name === "TransactionExpiredBlockheightExceededError") {
        await markEnded(action, "expired", "Blockhash expired before confirmation");
        throw new HttpError(410, "Transaction expired before confirmation; please try again");
      }
      throw new HttpError(502, `Sent ${signature} but confirmation is pending; it will be applied once confirmed`);
    }
  }
  if (err) {
    await markEnded(action, "failed", JSON.stringify(err));
    throw new HttpError(400, `Transaction failed on-chain: ${JSON.stringify(err)}`);
  }
  await applyConfirmed(action, signature);
  return { ...result, signature };
}

async function markEnded(action: Action, status: "expired" | "failed", error: string) {
  const db = getDb();
  const done = await db
    .update(chainActions)
    .set({ status, error })
    .where(and(eq(chainActions.id, action.id), eq(chainActions.status, "pending")))
    .returning({ id: chainActions.id });
  if (done.length && action.kind === "list" && action.listingId) {
    await db
      .update(listings)
      .set({ status: "cancelled", updatedAt: nowSec() })
      .where(and(eq(listings.id, action.listingId), eq(listings.status, "pending")));
  }
}

/** Applies DB effects exactly once (status transition guards against concurrent submit/reconcile). */
async function applyConfirmed(action: Action, signature: string): Promise<void> {
  const payload: unknown = JSON.parse(action.payloadJson);
  // Listing activation needs an on-chain check, done outside the DB transaction.
  let listingOk = true;
  if (action.kind === "list") {
    const md = getMarketDelegate().publicKey;
    const a = await fetchAsset(getUmi(), publicKey(action.asset!), { skipDerivePlugins: true });
    listingOk =
      a.owner === action.wallet &&
      isMarketDelegate(a.transferDelegate?.authority, md) &&
      !!a.freezeDelegate?.frozen &&
      isMarketDelegate(a.freezeDelegate.authority, md);
  }

  const db = getDb();
  const now = nowSec();
  await db.transaction(async (tx) => {
    const claimed = await tx
      .update(chainActions)
      .set({ status: "confirmed", signature, error: null })
      .where(and(eq(chainActions.id, action.id), inArray(chainActions.status, ["pending", "expired"])))
      .returning({ id: chainActions.id });
    if (!claimed.length) return;

    switch (action.kind) {
      case "mint": {
        const p = mintPayloadSchema.parse(payload);
        await tx
          .insert(seats)
          .values({
            asset: p.asset,
            brainId: action.brainId!,
            number: action.seatNumber!,
            owner: action.wallet,
            ownerCheckedAt: now,
            expiresAt: now + p.termDays * DAY,
            mintSignature: signature,
            mintedAt: now,
          })
          .onConflictDoNothing();
        await tx.insert(ledger).values(revenueLedger(action, "primary", p, signature));
        break;
      }
      case "renew": {
        const p = revenuePayloadSchema.parse(payload);
        await tx
          .update(seats)
          .set({ expiresAt: sql`max(${now}, ${seats.expiresAt}) + ${p.termDays * DAY}` })
          .where(eq(seats.asset, action.asset!));
        await tx.insert(ledger).values(revenueLedger(action, "renewal", p, signature));
        break;
      }
      case "list":
        await tx
          .update(listings)
          .set(listingOk ? { status: "active", listSignature: signature, updatedAt: now } : { status: "cancelled", updatedAt: now })
          .where(eq(listings.id, action.listingId!));
        if (!listingOk) {
          await tx.update(chainActions).set({ error: "Delegates not set as expected after confirmation" }).where(eq(chainActions.id, action.id));
        }
        break;
      case "delist":
        await tx.update(listings).set({ status: "cancelled", updatedAt: now }).where(eq(listings.id, action.listingId!));
        break;
      case "buy": {
        const p = buyPayloadSchema.parse(payload);
        await tx.update(seats).set({ owner: action.wallet, ownerCheckedAt: now }).where(eq(seats.asset, action.asset!));
        await tx
          .update(listings)
          .set({ status: "sold", buyer: action.wallet, saleSignature: signature, updatedAt: now })
          .where(eq(listings.id, p.listingId));
        await tx
          .update(listings)
          .set({ status: "cancelled", updatedAt: now })
          .where(and(eq(listings.asset, action.asset!), ne(listings.id, p.listingId), inArray(listings.status, ["pending", "active"])));
        const royalty = Number(p.royaltyLamports);
        const kol = Number(p.kolRoyaltyLamports);
        if (royalty > 0) {
          await tx.insert(ledger).values({
            brainId: action.brainId!,
            kind: "royalty",
            asset: action.asset,
            payer: action.wallet,
            amountLamports: royalty,
            kolLamports: kol,
            treasuryLamports: royalty - kol,
            kolPaidInline: p.kolPaidInline,
            signature,
          });
        }
        const fee = Number(p.feeLamports);
        if (fee > 0) {
          await tx.insert(ledger).values({
            brainId: action.brainId!,
            kind: "market_fee",
            asset: action.asset,
            payer: action.wallet,
            amountLamports: fee,
            treasuryLamports: fee,
            signature,
          });
        }
        break;
      }
      case "collection":
        break;
    }
  });
}

function revenueLedger(action: Action, kind: "primary" | "renewal", p: RevenuePayload, signature: string) {
  return {
    brainId: action.brainId!,
    kind,
    asset: action.asset,
    payer: action.wallet,
    amountLamports: Number(p.priceLamports),
    kolLamports: Number(p.kolLamports),
    treasuryLamports: Number(p.treasuryLamports),
    kolPaidInline: p.kolPaidInline,
    signature,
  };
}

// ---------------------------------------------------------------- cleanup / reconcile

/**
 * Pending actions whose blockhash expired: apply them if their signature actually landed, mark failed
 * if it landed with an error, otherwise mark expired (releasing mint reservations and pending listings).
 * Returns the number of actions expired.
 */
export async function expireStaleActions(): Promise<number> {
  const db = getDb();
  const pending = await db.select().from(chainActions).where(eq(chainActions.status, "pending"));
  if (!pending.length) return 0;
  const height = await getBlockHeight();
  const umi = getUmi();
  let expired = 0;
  for (const a of pending) {
    if (a.lastValidBlockHeight >= height) continue;
    if (a.signature) {
      const [st] = await umi.rpc.getSignatureStatuses([base58.serialize(a.signature)], { searchTransactionHistory: true });
      if (st?.error) {
        await markEnded(a, "failed", JSON.stringify(st.error));
        continue;
      }
      if (st && (st.commitment === "confirmed" || st.commitment === "finalized")) {
        await applyConfirmed(a, a.signature);
        continue;
      }
      if (st) continue; // processed but not yet confirmed: check again next round
    }
    await markEnded(a, "expired", "Blockhash expired without a confirmed transaction");
    expired++;
  }
  return expired;
}
