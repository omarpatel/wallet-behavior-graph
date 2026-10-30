/**
 * Read models for Brain Picks (no "server-only": used by routes, pages and the SSE stream). Visibility: viewers with
 * access to the brain (seat / claimed KOL / admin) see every pick in real time; everyone else sees picks younger than
 * PUBLIC_DELAY_SEC as hidden placeholders, and the track record only counts picks older than that.
 */
import { and, desc, eq, gte, inArray, lt, lte, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { hasBrainAccess } from "@/server/access";
import { faces, UNKNOWN_FACE } from "@/server/agents/queries";
import { deriveStrategy, untradableReason } from "@/server/agents/strategy";
import type { CandidateFeatures, ExitPlan } from "@/server/agents/types";
import { PUBLIC_DELAY_SEC } from "@/server/connectome/types";
import type { BrainProfile } from "@/server/profile/types";
import { markedOutcomePct, pickStats, type StatsRow } from "./logic";
import type { BrainPicksDTO, PickDTO, PickLeaderboardDTO, PickLeaderboardRow } from "./types";

type PickRow = typeof schema.brainPicks.$inferSelect;

const nowSec = () => Math.floor(Date.now() / 1000);
const PAGE = 50;
/** Closed picks a brain needs to be ranked on the leaderboard. */
export const PICK_RANK_MIN_CLOSED = 5;
const WINDOW_SEC = { "7d": 7 * 86_400, "30d": 30 * 86_400, all: null } as const;
const LEADERBOARD_TTL_MS = 60_000;

export function pickDTO(r: PickRow, hidden: boolean, now = nowSec()): PickDTO {
  const exitPlan = JSON.parse(r.exitPlanJson) as ExitPlan;
  const base = { id: r.id, brainId: r.brainId, createdAt: r.createdAt, revealAt: r.createdAt + PUBLIC_DELAY_SEC, suggestedFraction: r.suggestedFraction, exitPlan };
  if (hidden)
    return {
      ...base,
      hidden: true,
      token: null,
      entryMcUsd: null,
      entryPriceUsd: null,
      reason: null,
      chips: [],
      llm: null,
      features: null,
      status: "open",
      closedAt: null,
      closeReason: null,
      lastGainPct: null,
      maxGainPct: null,
      outcomePct: null,
      lastPriceAt: null,
      soldPct: 0,
    };
  const f = JSON.parse(r.featuresJson) as CandidateFeatures;
  return {
    ...base,
    hidden: false,
    token: { mint: r.mint, symbol: r.symbol ?? f.symbol, name: f.name, launchpad: f.launchpad, phase: f.phase },
    entryMcUsd: r.entryMcUsd,
    entryPriceUsd: r.entryPriceUsd,
    reason: r.reason,
    chips: JSON.parse(r.chipsJson) as string[],
    llm: r.llmModel && r.llmText ? { model: r.llmModel, text: r.llmText } : null,
    features: f,
    status: r.status,
    closedAt: r.closedAt,
    closeReason: r.closeReason,
    lastGainPct: r.lastGainPct,
    maxGainPct: r.maxGainPct,
    outcomePct: r.status === "closed" ? r.outcomePct : markedOutcomePct(r, now),
    lastPriceAt: r.lastPriceAt,
    soldPct: Math.round((1 - r.remaining) * 1000) / 10,
  };
}

/** Public viewers: a pick is hidden until PUBLIC_DELAY_SEC after it was made. */
export const pickHidden = (r: Pick<PickRow, "createdAt">, realtime: boolean, now = nowSec()) => !realtime && now - r.createdAt < PUBLIC_DELAY_SEC;

/** Brains get picks while they have an active seat or a running/paused/halted agent. */
export async function picksActive(brainId: string): Promise<boolean> {
  const db = getDb();
  const now = nowSec();
  const [seat, agent] = await Promise.all([
    db
      .select({ one: sql<number>`1` })
      .from(schema.seats)
      .where(and(eq(schema.seats.brainId, brainId), gte(schema.seats.expiresAt, now), ne(schema.seats.owner, "burned")))
      .limit(1),
    db
      .select({ one: sql<number>`1` })
      .from(schema.agents)
      .where(and(eq(schema.agents.brainId, brainId), ne(schema.agents.status, "stopped")))
      .limit(1),
  ]);
  return seat.length > 0 || agent.length > 0;
}

export async function getBrainPicks(brainId: string, viewerWallet: string | null, opts: { cursor?: string | null; limit?: number } = {}): Promise<BrainPicksDTO | null> {
  const db = getDb();
  const brain = (
    await db
      .select({ id: schema.brains.id, profileJson: schema.brains.profileJson, playbookMd: schema.brains.playbookMd, listed: schema.brains.listed })
      .from(schema.brains)
      .where(eq(schema.brains.id, brainId))
  )[0];
  if (!brain) return null;
  const now = nowSec();
  const limit = Math.min(Math.max(opts.limit ?? PAGE, 1), 100);
  const cursor = opts.cursor ? Number(opts.cursor) : null;
  const [access, active, rows, statRows] = await Promise.all([
    hasBrainAccess(viewerWallet, brainId),
    picksActive(brainId),
    db
      .select()
      .from(schema.brainPicks)
      .where(and(eq(schema.brainPicks.brainId, brainId), cursor != null && Number.isFinite(cursor) ? lt(schema.brainPicks.id, cursor) : undefined))
      .orderBy(desc(schema.brainPicks.id))
      .limit(limit + 1),
    db
      .select({ status: schema.brainPicks.status, outcomePct: schema.brainPicks.outcomePct, createdAt: schema.brainPicks.createdAt })
      .from(schema.brainPicks)
      .where(eq(schema.brainPicks.brainId, brainId)),
  ]);
  const realtime = access.ok;
  const profile = brain.profileJson ? (JSON.parse(brain.profileJson) as BrainProfile) : null;
  const d = deriveStrategy(profile, { brainId, playbook: brain.playbookMd });
  const page = rows.slice(0, limit);
  return {
    brainId,
    realtime,
    delaySec: PUBLIC_DELAY_SEC,
    generating: brain.listed && active && d.ok,
    style: d.ok
      ? {
          archetype: d.strategy.archetype,
          summary: d.strategy.summary,
          exit: d.strategy.exit,
          sizing: { baseFraction: d.strategy.sizing.baseFraction, maxFraction: d.strategy.sizing.maxFraction, style: d.strategy.sizing.style },
        }
      : null,
    untradableReason: d.ok ? null : untradableReason(profile),
    stats: pickStats(realtime ? statRows : statRows.filter((r) => now - r.createdAt >= PUBLIC_DELAY_SEC)),
    picks: page.map((r) => pickDTO(r, pickHidden(r, realtime, now), now)),
    nextCursor: rows.length > limit ? String(page.at(-1)!.id) : null,
  };
}

const boardCache = new Map<PickLeaderboardDTO["window"], { at: number; dto: PickLeaderboardDTO }>();

/** Brains ranked by the paper outcomes of their public picks (older than PUBLIC_DELAY_SEC) in the window. */
export async function getPickLeaderboard(window: PickLeaderboardDTO["window"]): Promise<PickLeaderboardDTO> {
  const hit = boardCache.get(window);
  if (hit && Date.now() - hit.at < LEADERBOARD_TTL_MS) return hit.dto;
  const db = getDb();
  const now = nowSec();
  const span = WINDOW_SEC[window];
  const rows = await db
    .select({ brainId: schema.brainPicks.brainId, status: schema.brainPicks.status, outcomePct: schema.brainPicks.outcomePct, createdAt: schema.brainPicks.createdAt })
    .from(schema.brainPicks)
    .where(and(lte(schema.brainPicks.createdAt, now - PUBLIC_DELAY_SEC), span != null ? gte(schema.brainPicks.createdAt, now - span) : undefined));
  const byBrain = new Map<string, StatsRow[]>();
  for (const r of rows) {
    const list = byBrain.get(r.brainId);
    if (list) list.push(r);
    else byBrain.set(r.brainId, [r]);
  }
  const ids = [...byBrain.keys()];
  const [faceMap, archetypes] = await Promise.all([
    faces(ids),
    ids.length
      ? db
          .select({ id: schema.brains.id, archetype: sql<string | null>`json_extract(${schema.brains.profileJson}, '$.archetype.label')` })
          .from(schema.brains)
          .where(and(inArray(schema.brains.id, ids), eq(schema.brains.listed, true)))
      : Promise.resolve([]),
  ]);
  const listed = new Map(archetypes.map((a) => [a.id, a.archetype]));
  const all: PickLeaderboardRow[] = ids
    .filter((id) => listed.has(id))
    .map((id) => ({ rank: null, brain: faceMap.get(id) ?? UNKNOWN_FACE(id), archetype: listed.get(id) ?? null, stats: pickStats(byBrain.get(id)!) }));
  const ranked = all
    .filter((r) => r.stats.closed >= PICK_RANK_MIN_CLOSED)
    .sort((a, b) => b.stats.avgOutcomePct! - a.stats.avgOutcomePct! || (b.stats.winRate ?? 0) - (a.stats.winRate ?? 0) || b.stats.closed - a.stats.closed)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  const warming = all.filter((r) => r.stats.closed < PICK_RANK_MIN_CLOSED).sort((a, b) => b.stats.closed - a.stats.closed || b.stats.picks - a.stats.picks);
  const dto: PickLeaderboardDTO = {
    window,
    minClosed: PICK_RANK_MIN_CLOSED,
    delaySec: PUBLIC_DELAY_SEC,
    rows: [...ranked, ...warming],
    total: pickStats(rows.filter((r) => listed.has(r.brainId))),
    computedAt: now,
  };
  boardCache.set(window, { at: Date.now(), dto });
  return dto;
}
