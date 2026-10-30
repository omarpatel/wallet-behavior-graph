/**
 * The council: what ALL tracked brains are doing on a candidate that passed a style's rules.
 * Inputs: the hub's live swarm membership, tracked-wallet buys/sells on the mint in the last 30 min (trades table), and
 * the connectome's leaders (neurons: brains others follow). It nudges sizing, can veto an entry that tracked brains are
 * leaving, and gives the LLM judge a summary of which brains are involved. Seat-gated live data → `gated` (the public
 * tape holds such rows back for PUBLIC_DELAY_SEC).
 */
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { brainTitle } from "@/lib/identity";
import type { Council } from "@/server/agents/runner";

/** Seat-gated live context (tracked-wallet buys/sells) the council reads, per candidate. */
export const COUNCIL_LOOKBACK_SEC = 30 * 60;

export interface CouncilInput {
  /** Brains in an active swarm on the mint. */
  swarm: string[];
  /** Tracked brains that bought the mint in the lookback. */
  buyers: string[];
  /** Tracked brains that only sold it in the lookback. */
  sellers: string[];
  /** Connectome leaders (by brainId). */
  leaders: Set<string>;
  /** The brain whose style is being evaluated. */
  styleBrainId: string;
  labels: Map<string, string>;
  /** Top styles by score now ("Label +3.1%"). */
  topStyles: string[];
}

const names = (ids: string[], labels: Map<string, string>) => ids.slice(0, 8).map((id) => labels.get(id) ?? id).join(", ") + (ids.length > 8 ? ` +${ids.length - 8}` : "");

export function buildCouncil(i: CouncilInput): Council {
  const leadersIn = i.buyers.filter((b) => i.leaders.has(b));
  const styleIn = i.buyers.includes(i.styleBrainId) || i.swarm.includes(i.styleBrainId);
  const chips: string[] = [];
  if (i.swarm.length) chips.push(`swarm ×${i.swarm.length}`);
  if (i.buyers.length) chips.push(`${i.buyers.length} tracked ${i.buyers.length === 1 ? "brain" : "brains"} bought (30m)`);
  if (leadersIn.length) chips.push(`${leadersIn.length} connectome ${leadersIn.length === 1 ? "leader" : "leaders"} in`);
  if (styleIn) chips.push("style brain in");
  if (i.sellers.length) chips.push(`${i.sellers.length} sold (30m)`);
  const veto =
    i.sellers.length >= 2 && i.buyers.length === 0 && i.swarm.length === 0
      ? `${i.sellers.length} tracked brains sold this token in the last 30 min and none bought (${names(i.sellers, i.labels)})`
      : null;
  const confidence = 0.05 * Math.min(i.swarm.length, 6) + 0.1 * Math.min(leadersIn.length, 2) + (styleIn ? 0.1 : 0) - 0.1 * Math.min(i.sellers.length, 3);
  const lines = [
    "Council (what every tracked brain is doing on this token right now):",
    i.swarm.length ? `- Active swarm of ${i.swarm.length} tracked brains: ${names(i.swarm, i.labels)}.` : "- No active swarm.",
    i.buyers.length ? `- Bought in the last 30 min: ${names(i.buyers, i.labels)}${leadersIn.length ? ` (connectome leaders: ${names(leadersIn, i.labels)})` : ""}.` : "- No tracked brain bought in the last 30 min.",
    i.sellers.length ? `- Only sold in the last 30 min: ${names(i.sellers, i.labels)}.` : "",
    styleIn ? "- The brain whose style you trade is in this token itself." : "",
    i.topStyles.length ? `- Styles working best now: ${i.topStyles.join("; ")}.` : "",
  ].filter(Boolean);
  return { chips, judgeNote: lines.join("\n"), confidence, veto, gated: i.swarm.length > 0 || i.buyers.length > 0 || i.sellers.length > 0 };
}

/** Tracked-brain buyers and only-sellers of `mint` since `now − COUNCIL_LOOKBACK_SEC` (trades_mint_time index). */
export async function recentFlow(mint: string, now: number): Promise<{ buyers: string[]; sellers: string[] }> {
  const rows = await getDb()
    .select({ brainId: schema.trades.brainId, side: schema.trades.side })
    .from(schema.trades)
    .where(and(eq(schema.trades.mint, mint), gte(schema.trades.blockTime, now - COUNCIL_LOOKBACK_SEC)))
    .groupBy(schema.trades.brainId, schema.trades.side);
  const buyers = [...new Set(rows.filter((r) => r.side === "buy").map((r) => r.brainId))];
  const sellers = [...new Set(rows.filter((r) => r.side === "sell" && !buyers.includes(r.brainId)).map((r) => r.brainId))];
  return { buyers, sellers };
}

/** Connectome leaders: brains that mostly lead (lead share ≥ 60%), top 50 by influence (PageRank on the reversed graph). */
export async function loadLeaders(): Promise<Set<string>> {
  const rows = await getDb()
    .select({ brainId: schema.neurons.brainId })
    .from(schema.neurons)
    .where(and(gte(schema.neurons.leadShare, 0.6), gte(schema.neurons.partners, 3)))
    .orderBy(desc(schema.neurons.pagerank))
    .limit(50);
  return new Set(rows.map((r) => r.brainId));
}

/** Public display labels (identity rules: attributed name only when allowed, else codename). */
export async function brainLabels(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await getDb()
    .select({
      id: schema.brains.id,
      displayName: schema.brains.displayName,
      codename: schema.brains.codename,
      xHandle: schema.brains.xHandle,
      status: schema.brains.status,
      provenance: schema.brains.provenance,
    })
    .from(schema.brains)
    .where(inArray(schema.brains.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, brainTitle(r)]));
}
