/** Brain creation (one per wallet). Backfill is picked up by the worker (backfillStatus "pending"). */
import bs58 from "bs58";
import { eq, like } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { Provenance } from "@/db/schema";
import { brainSlug, pickCodename } from "@/lib/codename";

export class InvalidWalletError extends Error {
  constructor(wallet: string) {
    super(`Not a valid Solana address: ${wallet}`);
    this.name = "InvalidWalletError";
  }
}

/** base58 that decodes to exactly 32 bytes */
export function isValidPubkey(wallet: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return false;
  try {
    return bs58.decode(wallet).length === 32;
  } catch {
    return false;
  }
}

export async function createBrain(input: {
  wallet: string;
  name?: string;
  xHandle?: string;
  provenance?: Provenance;
  source?: string;
}): Promise<{ id: string; created: boolean }> {
  const wallet = input.wallet.trim();
  if (!isValidPubkey(wallet)) throw new InvalidWalletError(wallet);
  const db = getDb();
  const [existing] = await db.select({ id: schema.brains.id }).from(schema.brains).where(eq(schema.brains.wallet, wallet));
  if (existing) return { id: existing.id, created: false };

  const handle = input.xHandle?.trim().replace(/^@/, "") || null;
  // A concurrent insert can take the codename or slug between the reads and the insert (both unique): re-read and retry.
  for (let attempt = 0; attempt < 3; attempt++) {
    const codename = pickCodename(
      wallet,
      new Set((await db.select({ codename: schema.brains.codename }).from(schema.brains)).map((r) => r.codename)),
    );
    let base = brainSlug(codename, wallet, handle);
    if (!base) base = brainSlug(codename, wallet);
    const taken = new Set(
      (await db.select({ id: schema.brains.id }).from(schema.brains).where(like(schema.brains.id, `${base}%`))).map((r) => r.id),
    );
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;

    const inserted = await db
      .insert(schema.brains)
      .values({
        id,
        wallet,
        codename,
        displayName: input.name?.trim() || null,
        xHandle: handle,
        provenance: input.provenance ?? "unattributed",
        provenanceSource: input.source ?? null,
        backfillStatus: "pending",
      })
      .onConflictDoNothing()
      .returning({ id: schema.brains.id });
    if (inserted.length) return { id: inserted[0].id, created: true };
    // lost a race on wallet: return whoever won for this wallet
    const [winner] = await db.select({ id: schema.brains.id }).from(schema.brains).where(eq(schema.brains.wallet, wallet));
    if (winner) return { id: winner.id, created: false };
  }
  throw new Error(`Could not allocate a slug/codename for ${wallet}`);
}
