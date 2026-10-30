import "server-only";
import { eq, gte, sql } from "drizzle-orm";
import { connection } from "next/server";
import { getDb, schema } from "@/db/client";
import { SWARM_ACTIVE_SEC } from "@/server/signals/types";
import type { Face, LandingSnapshot } from "@/server/snapshots/landing";
import { readSnapshot, SNAPSHOT_KEYS } from "@/server/snapshots/store";
import { nowSec } from "./shared";

const { brains, swarms } = schema;

export interface LandingCounts {
  brains: number;
  liveTracked: number;
  /** Null while today's count is still being computed by the worker. */
  tradesToday: number | null;
  activeSwarms: number;
  now: number;
}

/** Hero counters: listed brains, trades indexed since 00:00 UTC (snapshot), swarms whose last member joined < 30 min ago. */
export async function getLandingCounts(): Promise<LandingCounts> {
  await connection();
  const db = getDb();
  const now = nowSec();
  const midnight = Math.floor(now / 86_400) * 86_400;
  const [[b], [s], snap] = await Promise.all([
    db
      .select({
        n: sql<number>`count(*)`.mapWith(Number),
        live: sql<number>`sum(case when ${brains.tracking} = 'live' then 1 else 0 end)`.mapWith(Number),
      })
      .from(brains)
      .where(eq(brains.listed, true)),
    db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(swarms).where(gte(swarms.lastJoinAt, now - SWARM_ACTIVE_SEC)),
    readSnapshot<LandingSnapshot>(SNAPSHOT_KEYS.landing),
  ]);
  return {
    brains: b?.n ?? 0,
    liveTracked: b?.live ?? 0,
    tradesToday: snap && snap.value.midnight === midnight ? snap.value.tradesToday : null,
    activeSwarms: s?.n ?? 0,
    now,
  };
}

/** Brains that show a real face (claimed avatar or a platform-attributed directory pfp), strongest first (snapshot). */
export async function getHeroFaces(): Promise<Face[]> {
  await connection();
  return (await readSnapshot<LandingSnapshot>(SNAPSHOT_KEYS.landing))?.value.faces ?? [];
}
