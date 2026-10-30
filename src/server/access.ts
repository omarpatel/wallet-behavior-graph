// Seat gating. No "server-only"/next imports: used by routes, pages and the worker alike.
import { safeFetchAllAssetV1 } from "@metaplex-foundation/mpl-core";
import { publicKey } from "@metaplex-foundation/umi";
import { and, eq, lt, isNull, or } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { isAdminWallet } from "@/server/auth/jwt";
import { getUmi } from "@/server/solana/umi";

const OWNER_TTL_SEC = 60;
/** Stored as seats.owner when the asset account no longer exists. */
const BURNED = "burned";

export interface BrainAccess {
  ok: boolean;
  reason: "seat" | "kol" | "admin" | "no_seat" | "expired" | "signed_out";
  seat?: { asset: string; expiresAt: number };
}

type SeatRow = typeof schema.seats.$inferSelect;

/** Re-reads on-chain owners of the given seats and writes them back. Returns the fresh owner per asset. */
async function refreshOwners(rows: SeatRow[]): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  if (!rows.length) return owners;
  const umi = getUmi();
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const assets = await safeFetchAllAssetV1(umi, chunk.map((r) => publicKey(r.asset)), { commitment: "confirmed" });
    for (const a of assets) owners.set(a.publicKey, a.owner);
    for (const r of chunk) {
      const owner = owners.get(r.asset) ?? BURNED;
      owners.set(r.asset, owner);
      await db.update(schema.seats).set({ owner, ownerCheckedAt: now }).where(eq(schema.seats.asset, r.asset));
    }
  }
  return owners;
}

/**
 * Access to a brain's alerts/chat: the claimed KOL and admins always; otherwise an unexpired seat owned
 * by `wallet`. Seat owners are re-checked on-chain when older than 60s (seats trade off-platform too).
 */
export async function hasBrainAccess(wallet: string | null, brainId: string): Promise<BrainAccess> {
  if (!wallet) return { ok: false, reason: "signed_out" };
  const db = getDb();
  const brain = await db.query.brains.findFirst({
    where: eq(schema.brains.id, brainId),
    columns: { status: true, wallet: true },
  });
  if (brain?.status === "claimed" && brain.wallet === wallet) return { ok: true, reason: "kol" };
  if (isAdminWallet(wallet)) return { ok: true, reason: "admin" };
  if (!brain) return { ok: false, reason: "no_seat" };

  const now = Math.floor(Date.now() / 1000);
  const stale = or(isNull(schema.seats.ownerCheckedAt), lt(schema.seats.ownerCheckedAt, now - OWNER_TTL_SEC));
  let mine = await db
    .select()
    .from(schema.seats)
    .where(and(eq(schema.seats.brainId, brainId), eq(schema.seats.owner, wallet)));

  try {
    // Refresh this wallet's stale rows; if nothing valid remains, also refresh the brain's other stale
    // rows to pick up seats bought off-platform (e.g. on Tensor).
    const owners = await refreshOwners(mine.filter((s) => !s.ownerCheckedAt || s.ownerCheckedAt < now - OWNER_TTL_SEC));
    mine = mine.filter((s) => (owners.get(s.asset) ?? s.owner) === wallet);
    if (!mine.some((s) => s.expiresAt > now)) {
      const others = await db
        .select()
        .from(schema.seats)
        .where(and(eq(schema.seats.brainId, brainId), stale));
      const fresh = await refreshOwners(others.filter((s) => s.owner !== wallet));
      mine.push(...others.filter((s) => fresh.get(s.asset) === wallet));
    }
  } catch (e) {
    // RPC trouble: fall back to the last known owners.
    console.error(`seat owner refresh failed for ${brainId}:`, e);
  }

  if (!mine.length) return { ok: false, reason: "no_seat" };
  const best = mine.reduce((a, b) => (b.expiresAt > a.expiresAt ? b : a));
  const seat = { asset: best.asset, expiresAt: best.expiresAt };
  return best.expiresAt > now ? { ok: true, reason: "seat", seat } : { ok: false, reason: "expired", seat };
}
