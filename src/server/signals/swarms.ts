/**
 * Swarm detection (wallet clusters after mint): SWARM_MIN+ distinct
 * listed brains whose FIRST buy of a mint lands within SWARM_WINDOW_SEC of the swarm's first member.
 *
 * Detection is one pure function (detectSwarms) over a mint's first buys, used by both the live path (right after
 * trades are inserted, via createAlertsForTrades) and the history rebuild (worker "swarms" task), so a swarm looks
 * the same whether it was seen live or reconstructed from backfilled trades. Same-slot entries are kept as members
 * and marked `bundled` in the DTO (independentMembers counts distinct slots).
 * No next/server-only imports: used by the worker.
 */
import { inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { SWARM_MIN, SWARM_WINDOW_SEC, swarmStage, type SwarmMemberRecord, type SwarmStage } from "./types";

export interface FirstBuy {
  brainId: string;
  mint: string;
  at: number;
  slot: number;
  signature: string;
  solValue: number | null;
  mcUsd: number | null;
}

export interface DetectedSwarm {
  mint: string;
  startedAt: number;
  lastJoinAt: number;
  publishAt: number;
  mcAtStartUsd: number | null;
  members: SwarmMemberRecord[];
}

const byEntry = (a: FirstBuy, b: FirstBuy) => a.at - b.at || a.slot - b.slot || (a.brainId < b.brainId ? -1 : a.brainId > b.brainId ? 1 : 0);

/**
 * Swarms in one mint's first buys (one per brain). Greedy from the earliest entry: the first entry whose
 * [at, at + window] holds ≥ SWARM_MIN first buys starts a swarm containing all of them; scanning resumes after the
 * window, so a later, separate wave on the same token can form its own swarm. Live growth reproduces the same
 * result: an entry only ever joins the window that its swarm's first member opened.
 */
export function detectSwarms(firstBuys: FirstBuy[], windowSec = SWARM_WINDOW_SEC, minMembers = SWARM_MIN): DetectedSwarm[] {
  const seen = new Set<string>();
  const buys = [...firstBuys]
    .sort((a, b) => a.at - b.at || a.slot - b.slot || (a.brainId < b.brainId ? -1 : a.brainId > b.brainId ? 1 : 0))
    .filter((b) => (seen.has(b.brainId) ? false : (seen.add(b.brainId), true)));
  const out: DetectedSwarm[] = [];
  let i = 0;
  while (i < buys.length) {
    let j = i;
    while (j + 1 < buys.length && buys[j + 1].at <= buys[i].at + windowSec) j++;
    if (j - i + 1 < minMembers) {
      i++;
      continue;
    }
    const group = buys.slice(i, j + 1);
    out.push({
      mint: group[0].mint,
      startedAt: group[0].at,
      lastJoinAt: group[group.length - 1].at,
      publishAt: group[minMembers - 1].at,
      mcAtStartUsd: group.find((m) => m.mcUsd != null && m.mcUsd > 0)?.mcUsd ?? null,
      members: group.map((m) => ({
        brainId: m.brainId,
        at: m.at,
        slot: m.slot,
        signature: m.signature,
        solValue: m.solValue,
        mcUsd: m.mcUsd,
      })),
    });
    i = j + 1;
  }
  return out;
}

interface FirstBuyRow {
  brain_id: string;
  mint: string;
  at: number;
  slot: number;
  signature: string;
  sol_value: number | null;
  mc_usd: number | null;
}

/**
 * Each listed brain's earliest buy per mint. `mints` narrows to those tokens (live path); the brain-id IN list lets
 * SQLite use the (brain_id, mint) index instead of scanning all trades.
 */
async function loadFirstBuys(mints?: string[]): Promise<FirstBuy[]> {
  const db = getDb();
  const { trades, brains } = schema;
  const mintFilter = mints ? sql`and t.mint in (${sql.join(mints.map((m) => sql`${m}`), sql`, `)})` : sql``;
  const brainFilter = mints ? sql`and t.brain_id in (select id from ${brains} where listed = 1)` : sql``;
  const rows = await db.all<FirstBuyRow>(sql`
    select brain_id, mint, at, slot, signature, sol_value, mc_usd from (
      select t.brain_id as brain_id, t.mint as mint, t.block_time as at, t.slot as slot, t.signature as signature,
             t.sol_value as sol_value, t.mc_usd as mc_usd,
             row_number() over (partition by t.brain_id, t.mint order by t.block_time, t.slot, t.tx_index, t.id) as rn
      from ${trades} t
      where t.side = 'buy' ${brainFilter} ${mintFilter}
    ) fb
    join ${brains} b on b.id = fb.brain_id and b.listed = 1
    where rn = 1`);
  return rows.map((r) => ({
    brainId: r.brain_id,
    mint: r.mint,
    at: Number(r.at),
    slot: Number(r.slot),
    signature: r.signature,
    solValue: r.sol_value == null ? null : Number(r.sol_value),
    mcUsd: r.mc_usd == null ? null : Number(r.mc_usd),
  }));
}

type SwarmRow = typeof schema.swarms.$inferSelect;

export interface SwarmChange {
  id: number;
  mint: string;
  startedAt: number;
  members: number;
  stage: SwarmStage;
  /** Brain ids in entry order (rank = index + 1). */
  brainIds: string[];
  created: boolean;
  grown: boolean;
}

/**
 * Write the detected swarms for the given mints and drop stored swarms of those mints that no longer exist (e.g. an
 * earlier first buy from a newly backfilled brain moved the start). Returns every current swarm with change flags.
 */
async function writeSwarms(mints: string[], detected: DetectedSwarm[]): Promise<SwarmChange[]> {
  const db = getDb();
  const existing = new Map<string, SwarmRow>();
  for (let i = 0; i < mints.length; i += 500) {
    const rows = await db.select().from(schema.swarms).where(inArray(schema.swarms.mint, mints.slice(i, i + 500)));
    for (const r of rows) existing.set(`${r.mint}:${r.startedAt}`, r);
  }
  const changes: SwarmChange[] = [];
  const keep = new Set<string>();
  for (const d of detected) {
    const key = `${d.mint}:${d.startedAt}`;
    keep.add(key);
    const prev = existing.get(key);
    const membersJson = JSON.stringify(d.members);
    let id = prev?.id;
    if (!prev) {
      const [row] = await db
        .insert(schema.swarms)
        .values({
          mint: d.mint,
          startedAt: d.startedAt,
          lastJoinAt: d.lastJoinAt,
          members: d.members.length,
          membersJson,
          mcAtStartUsd: d.mcAtStartUsd,
          publishAt: d.publishAt,
        })
        .onConflictDoUpdate({
          target: [schema.swarms.mint, schema.swarms.startedAt],
          set: { lastJoinAt: d.lastJoinAt, members: d.members.length, membersJson, mcAtStartUsd: d.mcAtStartUsd, publishAt: d.publishAt },
        })
        .returning({ id: schema.swarms.id });
      id = row.id;
    } else if (prev.membersJson !== membersJson || prev.mcAtStartUsd !== d.mcAtStartUsd || prev.publishAt !== d.publishAt) {
      await db
        .update(schema.swarms)
        .set({ lastJoinAt: d.lastJoinAt, members: d.members.length, membersJson, mcAtStartUsd: d.mcAtStartUsd, publishAt: d.publishAt })
        .where(sql`${schema.swarms.id} = ${prev.id}`);
    }
    changes.push({
      id: id!,
      mint: d.mint,
      startedAt: d.startedAt,
      members: d.members.length,
      stage: swarmStage(d.members.length),
      brainIds: d.members.map((m) => m.brainId),
      created: !prev,
      grown: prev != null && d.members.length > prev.members,
    });
  }
  const stale = [...existing.entries()].filter(([k]) => !keep.has(k)).map(([, r]) => r.id);
  for (let i = 0; i < stale.length; i += 500) {
    await db.delete(schema.swarms).where(inArray(schema.swarms.id, stale.slice(i, i + 500)));
  }
  return changes;
}

const groupByMint = (buys: FirstBuy[]) => {
  const m = new Map<string, FirstBuy[]>();
  for (const b of buys) {
    const list = m.get(b.mint);
    if (list) list.push(b);
    else m.set(b.mint, [b]);
  }
  return m;
};

/** Live path: re-detect swarms for the mints of freshly inserted buy trades. */
export async function syncSwarmsForMints(mints: string[]): Promise<SwarmChange[]> {
  const unique = [...new Set(mints)];
  if (!unique.length) return [];
  const changes: SwarmChange[] = [];
  for (let i = 0; i < unique.length; i += 200) {
    const chunk = unique.slice(i, i + 200);
    const buys = await loadFirstBuys(chunk);
    const detected = [...groupByMint(buys).values()].flatMap((list) => detectSwarms(list));
    changes.push(...(await writeSwarms(chunk, detected)));
  }
  return changes;
}

export interface SwarmRebuildResult {
  mints: number;
  swarms: number;
  created: number;
  grown: number;
  removed: number;
}

/**
 * History rebuild over every listed brain's first buys (worker task + backfill of history). Idempotent: unchanged
 * swarms keep their id; swarms that no longer qualify (brain unlisted, start moved) are removed.
 */
export async function rebuildSwarmHistory(): Promise<SwarmRebuildResult> {
  const db = getDb();
  const buys = await loadFirstBuys();
  const byMint = groupByMint(buys);
  const detected = [...byMint.values()].filter((list) => list.length >= SWARM_MIN).flatMap((list) => detectSwarms(list));
  // stored mints too, so swarms that no longer qualify at all are removed
  const stored = await db.selectDistinct({ mint: schema.swarms.mint }).from(schema.swarms);
  const mints = [...new Set([...detected.map((d) => d.mint), ...stored.map((r) => r.mint)])];
  const count = async () => Number((await db.select({ n: sql<number>`count(*)` }).from(schema.swarms))[0].n);
  const before = await count();
  const changes = await writeSwarms(mints, detected);
  const after = await count();
  const created = changes.filter((c) => c.created).length;
  return {
    mints: byMint.size,
    swarms: after,
    created,
    grown: changes.filter((c) => c.grown).length,
    removed: before + created - after,
  };
}
