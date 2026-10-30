// Per-brain Metaplex Core collection.
import { createCollection, fetchCollection, ruleSet, updateCollectionPlugin } from "@metaplex-foundation/mpl-core";
import { publicKey } from "@metaplex-foundation/umi";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { env } from "@/lib/env";
import { HttpError } from "@/server/auth/http";
import { KOL_ROYALTY_PERCENT } from "./splits";
import { collectionSignerFor, getAuthorityUmi, getMintAuthority, getTreasury, signatureToString } from "./umi";

type Brain = typeof schema.brains.$inferSelect;

/** Collection account rent + plugins + fees, with margin. */
const MIN_AUTHORITY_LAMPORTS = 10_000_000n;

/** Public name for chain metadata: codename unless the KOL claimed the brain (guardrail §1). */
export function brainPublicName(b: Pick<Brain, "status" | "codename" | "displayName">): string {
  return b.status === "claimed" && b.displayName ? b.displayName : b.codename;
}

function royaltyCreators(b: Pick<Brain, "status" | "kolPayoutWallet">) {
  const treasury = getTreasury();
  if (b.status === "claimed" && b.kolPayoutWallet && b.kolPayoutWallet !== treasury) {
    return [
      { address: treasury, percentage: 100 - KOL_ROYALTY_PERCENT },
      { address: publicKey(b.kolPayoutWallet), percentage: KOL_ROYALTY_PERCENT },
    ];
  }
  return [{ address: treasury, percentage: 100 }];
}

const inflight = new Map<string, Promise<string>>();

/**
 * Returns the brain's Core collection address, creating it on first use. The collection keypair is
 * derived from (ASSET_SEED_SECRET, brainId), so concurrent or retried creation converges on one account.
 */
export function ensureCollection(brainId: string): Promise<string> {
  let p = inflight.get(brainId);
  if (!p) {
    p = createIfMissing(brainId).finally(() => inflight.delete(brainId));
    inflight.set(brainId, p);
  }
  return p;
}

async function createIfMissing(brainId: string): Promise<string> {
  const db = getDb();
  const brain = await db.query.brains.findFirst({ where: eq(schema.brains.id, brainId) });
  if (!brain) throw new Error(`Unknown brain ${brainId}`);
  if (brain.collectionAddress) return brain.collectionAddress;

  const umi = getAuthorityUmi();
  const collection = collectionSignerFor(brainId);
  if (!(await umi.rpc.accountExists(collection.publicKey, { commitment: "confirmed" }))) {
    const balance = await umi.rpc.getBalance(umi.identity.publicKey);
    if (balance.basisPoints < MIN_AUTHORITY_LAMPORTS) {
      throw new HttpError(
        503,
        `Mint authority ${umi.identity.publicKey} needs at least 0.01 SOL to create the seat collection (has ${balance.basisPoints} lamports)`,
      );
    }
    const name = `Wallet Behavior Graph: ${brainPublicName(brain)}`.slice(0, 64);
    const res = await createCollection(umi, {
      collection,
      name,
      uri: `${env().PUBLIC_URL}/api/meta/${brainId}/collection.json`,
      updateAuthority: getMintAuthority().publicKey,
      plugins: [
        {
          type: "Royalties",
          basisPoints: brain.royaltyBps,
          creators: royaltyCreators(brain),
          ruleSet: ruleSet("None"),
        },
        { type: "MasterEdition", maxSupply: brain.seatSupply, name },
        { type: "Attributes", attributeList: [{ key: "brainId", value: brainId }] },
      ],
    }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
    if (res.result.value.err) {
      throw new Error(`Collection creation failed: ${JSON.stringify(res.result.value.err)}`);
    }
  }
  await db
    .update(schema.brains)
    .set({ collectionAddress: collection.publicKey })
    .where(and(eq(schema.brains.id, brainId), isNull(schema.brains.collectionAddress)));
  return collection.publicKey;
}

/**
 * After a claim: set collection royalty creators to treasury 50 / KOL 50 (same basis points).
 * Returns the signature, or null when the brain has no collection yet (it will be created with the KOL split).
 */
export async function updateCollectionRoyaltiesForClaim(brainId: string): Promise<string | null> {
  const brain = await getDb().query.brains.findFirst({ where: eq(schema.brains.id, brainId) });
  if (!brain) throw new Error(`Unknown brain ${brainId}`);
  if (!brain.collectionAddress) return null;
  const umi = getAuthorityUmi();
  const current = await fetchCollection(umi, publicKey(brain.collectionAddress));
  const res = await updateCollectionPlugin(umi, {
    collection: current.publicKey,
    authority: getMintAuthority(),
    plugin: {
      type: "Royalties",
      basisPoints: current.royalties?.basisPoints ?? brain.royaltyBps,
      creators: royaltyCreators(brain),
      ruleSet: ruleSet("None"),
    },
  }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
  if (res.result.value.err) throw new Error(`Royalty update failed: ${JSON.stringify(res.result.value.err)}`);
  return signatureToString(res.signature);
}
