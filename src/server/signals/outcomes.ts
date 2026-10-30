/**
 * Our own swarm outcomes, measured from tracked-wallet trades only (no external price history): the peak market cap
 * in any tracked brain's trade of the token within 24 h after the swarm started, against the market cap at its first
 * entry and at the moment it became detectable (publishAt, the SWARM_MIN-th entry). Peaks are a lower bound of the
 * true peak — we only see a price when a tracked wallet trades.
 * No next/server-only imports: used by API routes and scripts alike.
 */
import { lte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import {
  SWARM_FULL,
  SWARM_LARGE,
  SWARM_MIN,
  SWARM_OUTCOME_WINDOW_SEC,
  type SwarmMeasuredRate,
  type SwarmMemberRecord,
  type SwarmOutcomeDTO,
} from "./types";

type SwarmRow = typeof schema.swarms.$inferSelect;

const { swarms, trades } = schema;

/** "Runner" market cap for our measured rates (same definition as the reference study). */
export const RUNNER_MC_USD = 100_000;
const OPEN_OUTCOME_TTL_MS = 60_000;

export interface McPoint {
  at: number;
  mcUsd: number;
}

/** Outcome of one swarm from the market caps seen in tracked trades (any order) of its token. */
export function computeSwarmOutcome(s: SwarmRow, points: McPoint[], now: number): SwarmOutcomeDTO {
  const end = s.startedAt + SWARM_OUTCOME_WINDOW_SEC;
  const inWindow = points.filter((p) => p.at >= s.startedAt && p.at <= end && p.mcUsd > 0);
  const peak = inWindow.reduce<McPoint | null>((best, p) => (best == null || p.mcUsd > best.mcUsd ? p : best), null);
  // strictly after publishAt: what a follower alerted at detection could still have caught
  const afterPublish = inWindow.filter((p) => p.at > s.publishAt).reduce<number | null>((m, p) => (m == null || p.mcUsd > m ? p.mcUsd : m), null);
  const members = JSON.parse(s.membersJson) as SwarmMemberRecord[];
  const start = s.mcAtStartUsd != null && s.mcAtStartUsd > 0 ? s.mcAtStartUsd : null;
  const publishMc = members[SWARM_MIN - 1]?.mcUsd;
  const atPublish = publishMc != null && publishMc > 0 ? publishMc : null;
  return {
    mcAtStartUsd: start,
    peakMcUsd: peak?.mcUsd ?? null,
    peakAt: peak?.at ?? null,
    multiple: start != null && peak ? peak.mcUsd / start : null,
    mcAtPublishUsd: atPublish,
    peakAfterPublishMcUsd: afterPublish,
    multipleFromPublish: atPublish != null && afterPublish != null ? afterPublish / atPublish : null,
    windowComplete: now >= end,
    observedTrades: inWindow.length,
    basis: "tracked_trades",
  };
}

/** Market-cap points of tracked trades inside each swarm's 24 h window, keyed by swarm id. */
async function windowPoints(ids: number[]): Promise<Map<number, McPoint[]>> {
  const out = new Map<number, McPoint[]>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const rows = await getDb().all<{ id: number; at: number; mc: number }>(sql`
      select s.id as id, t.block_time as at, t.mc_usd as mc
      from ${swarms} s
      join ${trades} t on t.mint = s.mint and t.block_time >= s.started_at
        and t.block_time <= s.started_at + ${SWARM_OUTCOME_WINDOW_SEC} and t.mc_usd > 0
      where s.id in (${sql.join(chunk.map((id) => sql`${id}`), sql`, `)})`);
    for (const r of rows) {
      const id = Number(r.id);
      const list = out.get(id) ?? [];
      list.push({ at: Number(r.at), mcUsd: Number(r.mc) });
      out.set(id, list);
    }
  }
  return out;
}

const globalCache = globalThis as unknown as {
  __wbgSwarmOutcomes?: Map<number, { at: number; key: string; outcome: SwarmOutcomeDTO }>;
};
const outcomeCache = (globalCache.__wbgSwarmOutcomes ??= new Map());

/** Outcome per swarm id. Completed windows are immutable and cached for the process lifetime; open ones for 60 s. */
export async function swarmOutcomes(rows: SwarmRow[], now = Math.floor(Date.now() / 1000)): Promise<Map<number, SwarmOutcomeDTO>> {
  const nowMs = Date.now();
  const keyOf = (r: SwarmRow) => `${r.startedAt}:${r.membersJson.length}:${r.members}`;
  const need = rows.filter((r) => {
    const c = outcomeCache.get(r.id);
    return !c || c.key !== keyOf(r) || (!c.outcome.windowComplete && nowMs - c.at > OPEN_OUTCOME_TTL_MS);
  });
  const points = await windowPoints(need.map((r) => r.id));
  for (const r of need) outcomeCache.set(r.id, { at: nowMs, key: keyOf(r), outcome: computeSwarmOutcome(r, points.get(r.id) ?? [], now) });
  return new Map(rows.map((r) => [r.id, outcomeCache.get(r.id)!.outcome]));
}

/**
 * Our own rates over every stored swarm with a complete 24 h window and a known start market cap. Reads every
 * completed swarm's window: worker-only (`swarm_rates` snapshot, src/server/snapshots).
 */
export async function computeMeasuredSwarmRates(): Promise<SwarmMeasuredRate[]> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await getDb()
    .select()
    .from(swarms)
    .where(lte(swarms.startedAt, now - SWARM_OUTCOME_WINDOW_SEC));
  const byId = await swarmOutcomes(rows, now);
  const done = rows.map((r) => ({ members: r.members, o: byId.get(r.id)! })).filter((x) => x.o.mcAtStartUsd != null);
  const rates = [SWARM_MIN, SWARM_FULL, SWARM_LARGE].map((minMembers): SwarmMeasuredRate => {
    const set = done.filter((x) => x.members >= minMembers);
    const reached2x = set.filter((x) => x.o.multiple != null && x.o.multiple >= 2).length;
    const fromPublish = set.filter((x) => x.o.multipleFromPublish != null);
    const reached2xFromPublish = fromPublish.filter((x) => x.o.multipleFromPublish! >= 2).length;
    // a runner must cross $100K after the swarm: tokens already above it at the start are excluded from that rate
    const below = set.filter((x) => x.o.mcAtStartUsd! < RUNNER_MC_USD);
    const reached100k = below.filter((x) => x.o.peakMcUsd != null && x.o.peakMcUsd >= RUNNER_MC_USD).length;
    return {
      minMembers,
      swarms: set.length,
      reached2x,
      share2x: set.length ? reached2x / set.length : null,
      withPublishMc: fromPublish.length,
      reached2xFromPublish,
      share2xFromPublish: fromPublish.length ? reached2xFromPublish / fromPublish.length : null,
      startedBelow100k: below.length,
      reached100k,
      share100k: below.length ? reached100k / below.length : null,
    };
  });
  return rates;
}
