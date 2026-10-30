import "server-only";
import { and, desc, eq, gt, gte, inArray, lt } from "drizzle-orm";
import { connection } from "next/server";
import { getDb, schema } from "@/db/client";
import { isAdminWallet } from "@/server/auth/jwt";
import { PUBLIC_DELAY_SEC } from "@/server/connectome/types";
import { nowSec, parseJson } from "@/server/queries/shared";
import { readSnapshot, SNAPSHOT_KEYS } from "@/server/snapshots/store";
import { swarmOutcomes } from "./outcomes";
import {
  SWARM_ACTIVE_SEC,
  SWARM_MIN,
  SWARM_STUDY_RATES,
  SWARM_WINDOW_SEC,
  swarmStage,
  type SwarmDTO,
  type SwarmListDTO,
  type SwarmMeasuredRate,
  type SwarmMemberRecord,
} from "./types";

export type SwarmRow = typeof schema.swarms.$inferSelect;

const { swarms, brains, tokens, seats } = schema;

/** Brains whose swarms this viewer sees in real time: unexpired seats (last known owner), own claimed brain, admin. */
export interface SwarmViewer {
  all: boolean;
  brainIds: Set<string>;
}

export async function swarmViewer(wallet: string | null): Promise<SwarmViewer> {
  if (!wallet) return { all: false, brainIds: new Set() };
  if (isAdminWallet(wallet)) return { all: true, brainIds: new Set() };
  const db = getDb();
  const now = nowSec();
  const [own, held] = await Promise.all([
    db.select({ id: brains.id }).from(brains).where(and(eq(brains.wallet, wallet), eq(brains.status, "claimed"))),
    db.selectDistinct({ id: seats.brainId }).from(seats).where(and(eq(seats.owner, wallet), gt(seats.expiresAt, now))),
  ]);
  return { all: false, brainIds: new Set([...own, ...held].map((r) => r.id)) };
}

/** Rows → DTOs with the visibility rule: token, market caps and outcome hidden until lastJoinAt + PUBLIC_DELAY_SEC. */
export async function swarmDTOs(rows: SwarmRow[], viewer: SwarmViewer): Promise<SwarmDTO[]> {
  if (!rows.length) return [];
  const db = getDb();
  const now = nowSec();
  const members = new Map(rows.map((r) => [r.id, parseJson<SwarmMemberRecord[]>(r.membersJson, [])]));
  const brainIds = [...new Set([...members.values()].flat().map((m) => m.brainId))];
  const visible = (r: SwarmRow) =>
    viewer.all || now >= r.lastJoinAt + PUBLIC_DELAY_SEC || members.get(r.id)!.some((m) => viewer.brainIds.has(m.brainId));
  const shown = rows.filter(visible);
  const mints = [...new Set(shown.map((r) => r.mint))];
  const [brainRows, tokenRows, outcomeById] = await Promise.all([
    db
      .select({
        id: brains.id,
        codename: brains.codename,
        displayName: brains.displayName,
        xHandle: brains.xHandle,
        avatarUrl: brains.avatarUrl,
        publicAvatarUrl: brains.publicAvatarUrl,
        provenance: brains.provenance,
        tier: brains.tier,
      })
      .from(brains)
      .where(inArray(brains.id, brainIds)),
    mints.length ? db.select().from(tokens).where(inArray(tokens.mint, mints)) : Promise.resolve([]),
    swarmOutcomes(shown, now),
  ]);
  const brainById = new Map(brainRows.map((b) => [b.id, b]));
  const tokenByMint = new Map(tokenRows.map((t) => [t.mint, t]));

  return rows.map((r): SwarmDTO => {
    const list = members.get(r.id)!;
    const slotCount = new Map<number, number>();
    for (const m of list) slotCount.set(m.slot, (slotCount.get(m.slot) ?? 0) + 1);
    const hidden = !visible(r);
    const t = hidden ? undefined : tokenByMint.get(r.mint);
    return {
      id: r.id,
      stage: swarmStage(r.members),
      members: r.members,
      independentMembers: slotCount.size,
      startedAt: r.startedAt,
      lastJoinAt: r.lastJoinAt,
      publishAt: r.publishAt,
      active: now - r.lastJoinAt < SWARM_ACTIVE_SEC,
      hidden,
      revealAt: r.lastJoinAt + PUBLIC_DELAY_SEC,
      token: hidden
        ? null
        : {
            mint: r.mint,
            symbol: t?.symbol ?? null,
            name: t?.name ?? null,
            icon: t?.icon ?? null,
            launchpad: t?.launchpad ?? null,
            mcapUsd: t?.mcapUsd ?? null,
            rugScore: t?.rugScore ?? null,
            lpLockedPct: t?.lpLockedPct ?? null,
          },
      memberList: list.map((m) => {
        const b = brainById.get(m.brainId);
        return {
          brainId: m.brainId,
          codename: b?.codename ?? m.brainId,
          displayName: b?.displayName ?? null,
          xHandle: b?.xHandle ?? null,
          avatarUrl: b?.avatarUrl ?? b?.publicAvatarUrl ?? null,
          provenance: b?.provenance ?? "unattributed",
          tier: b?.tier ?? "unrated",
          at: m.at,
          lagSec: m.at - r.startedAt,
          slot: m.slot,
          bundled: (slotCount.get(m.slot) ?? 0) > 1,
          solValue: m.solValue,
          mcUsd: hidden ? null : m.mcUsd,
        };
      }),
      outcome: hidden ? null : (outcomeById.get(r.id) ?? null),
    };
  });
}

export interface ListSwarmsOptions {
  viewerWallet: string | null;
  limit?: number;
  minMembers?: number;
  /** Paging: only swarms that started before this unix time. */
  before?: number;
}

/** Recent + historical swarms (startedAt desc) with study base rates and our own measured outcome rates. */
export async function listSwarms(opts: ListSwarmsOptions): Promise<SwarmListDTO> {
  await connection();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await getDb()
    .select()
    .from(swarms)
    .where(and(gte(swarms.members, Math.max(opts.minMembers ?? SWARM_MIN, SWARM_MIN)), opts.before != null ? lt(swarms.startedAt, opts.before) : undefined))
    .orderBy(desc(swarms.startedAt), desc(swarms.id))
    .limit(limit);
  const [viewer, measured] = await Promise.all([
    swarmViewer(opts.viewerWallet),
    readSnapshot<SwarmMeasuredRate[]>(SNAPSHOT_KEYS.swarmRates).then((s) => s?.value ?? []),
  ]);
  return {
    generatedAt: nowSec(),
    windowSec: SWARM_WINDOW_SEC,
    study: SWARM_STUDY_RATES,
    measured,
    swarms: await swarmDTOs(rows, viewer),
  };
}

/** Active swarms (last member joined within SWARM_ACTIVE_SEC) keyed by member brain; the largest wins per brain. */
export async function activeSwarmsByBrain(viewerWallet: string | null): Promise<Map<string, SwarmDTO>> {
  await connection();
  const rows = await getDb()
    .select()
    .from(swarms)
    .where(gte(swarms.lastJoinAt, nowSec() - SWARM_ACTIVE_SEC))
    .orderBy(desc(swarms.members));
  const dtos = await swarmDTOs(rows, await swarmViewer(viewerWallet));
  const out = new Map<string, SwarmDTO>();
  for (const s of dtos) for (const m of s.memberList) if (!out.has(m.brainId)) out.set(m.brainId, s);
  return out;
}

/** SSE helpers: newest swarms (backlog) and swarms that are new (id > cursor) or still active. */
export async function newestSwarmRows(limit: number): Promise<SwarmRow[]> {
  return getDb().select().from(swarms).orderBy(desc(swarms.startedAt), desc(swarms.id)).limit(limit);
}

/** New (id > cursor) or still-active swarms; two indexed lookups (an OR across rowid and last_join_at scans the table). */
export async function changedSwarmRows(afterId: number, activeSince: number): Promise<SwarmRow[]> {
  const db = getDb();
  const [fresh, active] = await Promise.all([
    db.select().from(swarms).where(gt(swarms.id, afterId)).orderBy(swarms.id).limit(500),
    db.select().from(swarms).where(gte(swarms.lastJoinAt, activeSince)).limit(500),
  ]);
  const byId = new Map([...fresh, ...active].map((r) => [r.id, r]));
  return [...byId.values()].sort((a, b) => a.id - b.id).slice(0, 500);
}
