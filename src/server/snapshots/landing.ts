/** Landing hero snapshot (`landing`): trades indexed today and the face marquee. No next/server-only imports. */
import { and, desc, eq, isNotNull, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { BrainFace } from "@/server/queries/shared";

const { brains, trades } = schema;

export interface Face extends BrainFace {
  id: string;
  tier: (typeof brains.$inferSelect)["tier"];
}

export interface LandingSnapshot {
  /** UTC midnight the count starts at (a snapshot from yesterday is stale). */
  midnight: number;
  tradesToday: number;
  faces: Face[];
}

export const HERO_FACES = 48;

export async function computeLanding(): Promise<LandingSnapshot> {
  const db = getDb();
  const midnight = Math.floor(Date.now() / 1000 / 86_400) * 86_400;
  // brain_id IN (…) turns the count into one trades_brain_time range seek per brain instead of a full index scan
  const [[t], faces] = await Promise.all([
    db.all<{ n: number }>(
      sql`select count(*) as n from ${trades} where ${trades.brainId} in (select ${brains.id} from ${brains}) and ${trades.blockTime} >= ${midnight}`,
    ),
    db
      .select({
        id: brains.id,
        brainId: brains.id,
        codename: brains.codename,
        displayName: brains.displayName,
        xHandle: brains.xHandle,
        provenance: brains.provenance,
        status: brains.status,
        avatarUrl: brains.avatarUrl,
        publicAvatarUrl: brains.publicAvatarUrl,
        tier: brains.tier,
      })
      .from(brains)
      .where(
        and(
          eq(brains.listed, true),
          or(
            and(eq(brains.status, "claimed"), or(isNotNull(brains.avatarUrl), isNotNull(brains.publicAvatarUrl))),
            and(eq(brains.provenance, "platform_attributed"), isNotNull(brains.publicAvatarUrl)),
          ),
        ),
      )
      .orderBy(sql`${brains.trackScore} is null`, desc(brains.trackScore), desc(brains.followers))
      .limit(HERO_FACES),
  ]);
  return {
    midnight,
    tradesToday: Number(t?.n ?? 0),
    faces: faces.map((r) => ({ ...r, avatarUrl: r.status === "claimed" ? r.avatarUrl : null })),
  };
}
