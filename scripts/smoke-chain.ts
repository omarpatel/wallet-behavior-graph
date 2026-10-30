// End-to-end chain smoke: drives the real builders + submitAction (two local Keypairs sign exactly as a
// wallet would) through collection → mint → claim → renew → list → buy → re-list → delist, asserting DB
// rows, ledger splits, on-chain owners/delegates and seat access. Creates a temporary brain and deletes
// its DB rows afterwards (on-chain accounts remain on the target cluster).
//
// Prerequisites: `pnpm keygen` (writes .env.local); the mint authority (MINT_AUTHORITY_PUBKEY) holds
// ≥ 0.2 SOL on the target cluster — it funds the collection and the two test keypairs.
//
// Devnet (fund the mint authority first, e.g. https://faucet.solana.com):
//   pnpm smoke:chain
//
// Local validator (no faucet limits). Windows: solana-test-validator needs symlink privileges, so run it
// in WSL; it clones the Metaplex Core program from devnet and mints 500M SOL to the mint authority:
//   wsl -d Ubuntu-24.04 -- bash -lc 'solana-test-validator --reset --quiet --ledger ~/wbg-ledger \
//     --rpc-port 8899 --url https://api.devnet.solana.com \
//     --clone-upgradeable-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d \
//     --mint <MINT_AUTHORITY_PUBKEY>'
//   SOLANA_RPC_URL=http://127.0.0.1:8899 pnpm smoke:chain
// (PowerShell: `$env:SOLANA_RPC_URL="http://127.0.0.1:8899"; pnpm smoke:chain`)
import { fetchAsset } from "@metaplex-foundation/mpl-core";
import { publicKey } from "@metaplex-foundation/umi";
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, VersionedTransaction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { pickCodename } from "@/lib/codename";
import { env, requireEnv } from "@/lib/env";
import { hasBrainAccess } from "@/server/access";
import {
  buildBuyAction,
  buildDelistAction,
  buildListAction,
  buildMintAction,
  buildRenewAction,
  expireStaleActions,
  submitAction,
} from "@/server/solana/actions";
import { claimBrain } from "@/server/solana/claim";
import { ensureCollection } from "@/server/solana/collection";
import { explorerAddress, explorerTx, getMarketDelegate, getUmi } from "@/server/solana/umi";

const rpcUrl = env().SOLANA_RPC_URL;
const db = getDb();
const conn = new Connection(rpcUrl, "confirmed");
const bank = Keypair.fromSecretKey(bs58.decode(requireEnv("MINT_AUTHORITY_SECRET").MINT_AUTHORITY_SECRET));
const seller = Keypair.generate();
const buyer = Keypair.generate();
const kol = Keypair.generate();
const brainId = `smoke-${Date.now().toString(36)}`;

// Local validators get explorer links with a custom cluster URL.
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(rpcUrl);
const localSuffix = `?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`;
const txLink = (sig: string) => (isLocal ? `https://explorer.solana.com/tx/${sig}${localSuffix}` : explorerTx(sig));
const addressLink = (a: string) => (isLocal ? `https://explorer.solana.com/address/${a}${localSuffix}` : explorerAddress(a));

const links: string[] = [];
const log = (label: string, sig: string) => {
  links.push(`${label}: ${sig} ${txLink(sig)}`);
  console.log(`✓ ${label}: ${txLink(sig)}`);
};
const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
};

/** What a wallet does: deserialize, sign, serialize. */
function walletSign(b64: string, kp: Keypair): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  tx.sign([kp]);
  return Buffer.from(tx.serialize()).toString("base64");
}

async function run(label: string, kp: Keypair, built: { actionId: string | null; transaction: string | null }) {
  assert(built.actionId && built.transaction, `${label}: expected a transaction`);
  const res = await submitAction(built.actionId, walletSign(built.transaction!, kp), kp.publicKey.toBase58());
  log(label, res.signature);
  return res;
}

const fund = async (to: Keypair, sol: number) =>
  sendAndConfirmTransaction(
    conn,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: bank.publicKey, toPubkey: to.publicKey, lamports: Math.round(sol * LAMPORTS_PER_SOL) })),
    [bank],
  );

/** Return a test wallet's leftover SOL to the bank (mainnet runs must not strand funds in throwaway keys). */
async function sweepBack(kp: Keypair): Promise<void> {
  const bal = await conn.getBalance(kp.publicKey);
  const fee = 5_000;
  if (bal <= fee) return;
  const sig = await sendAndConfirmTransaction(
    conn,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: bank.publicKey, lamports: bal - fee })),
    [kp],
  );
  console.log(`↩ swept ${(bal - fee) / LAMPORTS_PER_SOL} SOL back from ${kp.publicKey.toBase58().slice(0, 6)}… ${txLink(sig)}`);
}

const bankBalance = await conn.getBalance(bank.publicKey);
console.log(`RPC ${rpcUrl}; mint authority ${bank.publicKey.toBase58()} balance ${bankBalance / LAMPORTS_PER_SOL} SOL`);
if (bankBalance < 0.2 * LAMPORTS_PER_SOL) {
  throw new Error("Mint authority needs ≥ 0.2 SOL on this cluster (see header comment).");
}

try {
  log("fund seller", await fund(seller, 0.06));
  log("fund buyer", await fund(buyer, 0.05));

  await db.insert(schema.brains).values({
    id: brainId,
    wallet: kol.publicKey.toBase58(),
    codename: pickCodename(
      kol.publicKey.toBase58(),
      new Set((await db.select({ codename: schema.brains.codename }).from(schema.brains)).map((r) => r.codename)),
    ),
    seatSupply: 3,
    seatPriceLamports: 20_000_000,
    renewalPriceLamports: 10_000_000,
    priceOverride: true,
    royaltyBps: 500,
  });

  const collection = await ensureCollection(brainId);
  console.log(`✓ collection ${collection} ${addressLink(collection)}`);
  links.push(`collection: ${addressLink(collection)}`);

  // mint
  const mint = await run("mint", seller, await buildMintAction(seller.publicKey.toBase58(), brainId));
  const asset = mint.asset!;
  const seat = await db.query.seats.findFirst({ where: eq(schema.seats.asset, asset) });
  assert(seat?.owner === seller.publicKey.toBase58() && seat.number === 1, "seat row owner/number");
  const onChain = await fetchAsset(getUmi(), publicKey(asset));
  assert(onChain.owner === seller.publicKey.toBase58(), "on-chain owner after mint");
  console.log(`✓ seat #${seat!.number} ${addressLink(asset)} expiresAt ${seat!.expiresAt}`);
  links.push(`asset: ${addressLink(asset)}`);

  // claim (KOL wallet unfunded): accrued primary share gets queued
  const claim = await claimBrain(brainId, kol.publicKey.toBase58());
  console.log(`✓ claim: accrued ${claim.accruedLamports} lamports queued; royalties ${claim.royaltiesSignature ?? claim.royaltiesError}`);
  if (claim.royaltiesSignature) log("claim royalties update", claim.royaltiesSignature);
  assert(claim.accruedLamports === 6_000_000, "accrued KOL share = 30% of 0.02 SOL");

  // renew (KOL share now inline)
  await run("renew", seller, await buildRenewAction(seller.publicKey.toBase58(), asset));
  const renewed = await db.query.seats.findFirst({ where: eq(schema.seats.asset, asset) });
  assert(renewed!.expiresAt >= seat!.expiresAt + 30 * 86_400, "renewal extended term");
  console.log(`✓ renewed: expiresAt ${seat!.expiresAt} → ${renewed!.expiresAt}`);

  // list
  const listBuilt = await buildListAction(seller.publicKey.toBase58(), asset, 30_000_000);
  await run("list", seller, listBuilt);
  const md = getMarketDelegate().publicKey;
  const listed = await fetchAsset(getUmi(), publicKey(asset), { skipDerivePlugins: true });
  assert(listed.transferDelegate?.authority.address === md, "transfer delegate = market");
  assert(listed.freezeDelegate?.frozen && listed.freezeDelegate.authority.address === md, "frozen by market");
  const listing = await db.query.listings.findFirst({ where: eq(schema.listings.asset, asset) });
  assert(listing?.status === "active", "listing active");
  console.log(`✓ listed: delegate ${md}, frozen`);

  // buy
  await run("buy", buyer, await buildBuyAction(buyer.publicKey.toBase58(), listing!.id));
  const bought = await fetchAsset(getUmi(), publicKey(asset), { skipDerivePlugins: true });
  assert(bought.owner === buyer.publicKey.toBase58(), "on-chain owner = buyer");
  assert(bought.transferDelegate?.authority.type === "Owner", "delegate reset on transfer");
  const sold = await db.query.listings.findFirst({ where: eq(schema.listings.id, listing!.id) });
  assert(sold?.status === "sold" && sold.buyer === buyer.publicKey.toBase58(), "listing sold");
  const seatAfter = await db.query.seats.findFirst({ where: eq(schema.seats.asset, asset) });
  assert(seatAfter?.owner === buyer.publicKey.toBase58(), "seat owner updated");
  const ledgerRows = await db.select().from(schema.ledger).where(eq(schema.ledger.brainId, brainId));
  console.table(ledgerRows.map((r) => ({ kind: r.kind, amount: r.amountLamports, kol: r.kolLamports, treasury: r.treasuryLamports, inline: r.kolPaidInline })));
  assert(ledgerRows.some((r) => r.kind === "royalty") && ledgerRows.some((r) => r.kind === "market_fee"), "royalty + fee ledger rows");

  // access
  const accBuyer = await hasBrainAccess(buyer.publicKey.toBase58(), brainId);
  const accSeller = await hasBrainAccess(seller.publicKey.toBase58(), brainId);
  const accKol = await hasBrainAccess(kol.publicKey.toBase58(), brainId);
  console.log(`✓ access buyer=${accBuyer.reason} seller=${accSeller.reason} kol=${accKol.reason}`);
  assert(accBuyer.ok && accBuyer.reason === "seat" && !accSeller.ok && accKol.reason === "kol", "access results");

  // re-list by buyer (approve path) then delist (server thaws)
  await run("re-list", buyer, await buildListAction(buyer.publicKey.toBase58(), asset, 25_000_000));
  const relisting = (await db.select().from(schema.listings).where(eq(schema.listings.asset, asset))).find((l) => l.status === "active")!;
  await run("delist", buyer, await buildDelistAction(buyer.publicKey.toBase58(), relisting.id));
  const delisted = await fetchAsset(getUmi(), publicKey(asset), { skipDerivePlugins: true });
  assert(!delisted.freezeDelegate?.frozen && delisted.freezeDelegate?.authority.type === "Owner", "thawed + freeze authority back to owner");
  assert(delisted.transferDelegate?.authority.type === "Owner", "transfer delegate revoked");
  const cancelled = await db.query.listings.findFirst({ where: eq(schema.listings.id, relisting.id) });
  assert(cancelled?.status === "cancelled", "listing cancelled");
  console.log("✓ delisted: thawed, delegates revoked");

  console.log(`expireStaleActions → ${await expireStaleActions()}`);
  const actions = await db.select({ kind: schema.chainActions.kind, status: schema.chainActions.status }).from(schema.chainActions).where(eq(schema.chainActions.brainId, brainId));
  console.log(actions.map((a) => `${a.kind}:${a.status}`).join(" "));
  console.log("\nALL OK\n" + links.join("\n"));
} finally {
  for (const kp of [seller, buyer]) await sweepBack(kp).catch((e) => console.error(`sweep failed for ${kp.publicKey.toBase58()}: ${e}`));
  await db.delete(schema.listings).where(eq(schema.listings.brainId, brainId));
  await db.delete(schema.ledger).where(eq(schema.ledger.brainId, brainId));
  await db.delete(schema.kolPayouts).where(eq(schema.kolPayouts.brainId, brainId));
  await db.delete(schema.chainActions).where(eq(schema.chainActions.brainId, brainId));
  await db.delete(schema.seats).where(eq(schema.seats.brainId, brainId));
  await db.delete(schema.brains).where(eq(schema.brains.id, brainId));
}
