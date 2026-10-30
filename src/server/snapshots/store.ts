/**
 * Materialized request-time aggregates. The worker computes each snapshot in memory (reads only, no write lock) and
 * stores it with one short upsert; the site reads it with a primary-key lookup and never runs the heavy query itself.
 * No next/server-only imports: shared by the site and the worker.
 */
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { withBusyRetry } from "@/db/retry";

const { snapshots } = schema;

export const SNAPSHOT_KEYS = {
  leaderboard: "leaderboard",
  landing: "landing",
  squads: "squads",
  swarmRates: "swarm_rates",
  replays: "replays",
} as const;
export type SnapshotKey = (typeof SNAPSHOT_KEYS)[keyof typeof SNAPSHOT_KEYS];

export interface Snapshot<T> {
  value: T;
  computedAt: number;
}

/** Parsed values per key, reused until the row's computed_at changes (one tiny pk lookup per read). */
const globalCache = globalThis as unknown as { __wbgSnapshots?: Map<string, Snapshot<unknown>> };
const parsed = (globalCache.__wbgSnapshots ??= new Map());

/** The latest snapshot, or null while the worker has not computed it yet. */
export async function readSnapshot<T>(key: SnapshotKey): Promise<Snapshot<T> | null> {
  const db = getDb();
  const [head] = await db.select({ computedAt: snapshots.computedAt }).from(snapshots).where(eq(snapshots.key, key));
  if (!head) return null;
  const cached = parsed.get(key) as Snapshot<T> | undefined;
  if (cached && cached.computedAt === head.computedAt) return cached;
  const [row] = await db.select().from(snapshots).where(eq(snapshots.key, key));
  if (!row) return null;
  const snap: Snapshot<T> = { value: JSON.parse(row.json) as T, computedAt: row.computedAt };
  parsed.set(key, snap);
  return snap;
}

/** One autocommit upsert (safe to retry on SQLITE_BUSY). */
export async function writeSnapshot(key: SnapshotKey, value: unknown, computedAt = Math.floor(Date.now() / 1000)): Promise<number> {
  const json = JSON.stringify(value);
  await withBusyRetry(
    () =>
      getDb()
        .insert(snapshots)
        .values({ key, json, computedAt })
        .onConflictDoUpdate({ target: snapshots.key, set: { json: sql`excluded.json`, computedAt: sql`excluded.computed_at` } }),
    { label: `snapshot ${key}` },
  );
  return json.length;
}
