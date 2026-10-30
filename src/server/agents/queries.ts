/**
 * Read models for brain agents (no "server-only": used by routes, pages and the runner's SSE). Plain indexed DB reads.
 * Public viewers see an agent's tape with one exception: decisions/orders informed by a Wallet Behavior Graph swarm are held back
 * for PUBLIC_DELAY_SEC, the same rule as the public swarm feed (a swarm's token is seat-gated while it is fresh).
 */
import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { env } from "@/lib/env";
import { PUBLIC_DELAY_SEC } from "@/server/connectome/types";
import type {
  AgentBrainFace,
  AgentDecisionDTO,
  AgentDetailDTO,
  AgentDTO,
  AgentLeaderboardDTO,
  AgentLeaderboardRow,
  AgentLedgerDTO,
  AgentOrderDTO,
  AgentPositionDTO,
  CandidateFeatures,
  ExitPlan,
  StrategySpec,
} from "./types";

type AgentRow = typeof schema.agents.$inferSelect;
type PositionRow = typeof schema.agentPositions.$inferSelect;
type OrderRow = typeof schema.agentOrders.$inferSelect;
type DecisionRow = typeof schema.agentDecisions.$inferSelect;

const nowSec = () => Math.floor(Date.now() / 1000);

const faceColumns = {
  brainId: schema.brains.id,
  codename: schema.brains.codename,
  displayName: schema.brains.displayName,
  xHandle: schema.brains.xHandle,
  provenance: schema.brains.provenance,
  status: schema.brains.status,
  avatarUrl: schema.brains.avatarUrl,
  publicAvatarUrl: schema.brains.publicAvatarUrl,
};

export async function faces(brainIds: string[]): Promise<Map<string, AgentBrainFace>> {
  if (!brainIds.length) return new Map();
  const rows = await getDb().select(faceColumns).from(schema.brains).where(inArray(schema.brains.id, [...new Set(brainIds)]));
  return new Map(rows.map((r) => [r.brainId, r]));
}

/** Latest cached SOL/USD minute close (worker keeps it fresh). */
export async function latestSolUsd(): Promise<number | null> {
  const r = await getDb().select({ close: schema.solUsd1m.close }).from(schema.solUsd1m).orderBy(desc(schema.solUsd1m.minuteTs)).limit(1);
  return r[0]?.close ?? null;
}

interface AgentStats {
  openPositions: number;
  openCost: number;
  trades: number;
  netDeposits: number;
  closed: number;
  wins: number;
}

async function statsFor(ids: string[]): Promise<Map<string, AgentStats>> {
  const out = new Map<string, AgentStats>(ids.map((id) => [id, { openPositions: 0, openCost: 0, trades: 0, netDeposits: 0, closed: 0, wins: 0 }]));
  if (!ids.length) return out;
  const db = getDb();
  const [pos, ord, led] = await Promise.all([
    db
      .select({
        agentId: schema.agentPositions.agentId,
        open: sql<number>`sum(case when ${schema.agentPositions.status} = 'open' then 1 else 0 end)`,
        openCost: sql<number>`sum(case when ${schema.agentPositions.status} = 'open' then ${schema.agentPositions.costLamports} else 0 end)`,
        closed: sql<number>`sum(case when ${schema.agentPositions.status} = 'closed' then 1 else 0 end)`,
        wins: sql<number>`sum(case when ${schema.agentPositions.status} = 'closed' and ${schema.agentPositions.realizedLamports} > 0 then 1 else 0 end)`,
      })
      .from(schema.agentPositions)
      .where(inArray(schema.agentPositions.agentId, ids))
      .groupBy(schema.agentPositions.agentId),
    db
      .select({ agentId: schema.agentOrders.agentId, n: sql<number>`count(*)` })
      .from(schema.agentOrders)
      .where(and(inArray(schema.agentOrders.agentId, ids), eq(schema.agentOrders.status, "filled")))
      .groupBy(schema.agentOrders.agentId),
    db
      .select({
        agentId: schema.agentLedger.agentId,
        net: sql<number>`sum(case when ${schema.agentLedger.kind} in ('deposit', 'fee_claim') then ${schema.agentLedger.amountLamports} when ${schema.agentLedger.kind} = 'withdraw' then -${schema.agentLedger.amountLamports} else 0 end)`,
      })
      .from(schema.agentLedger)
      .where(inArray(schema.agentLedger.agentId, ids))
      .groupBy(schema.agentLedger.agentId),
  ]);
  for (const p of pos) Object.assign(out.get(p.agentId)!, { openPositions: Number(p.open), openCost: Number(p.openCost), closed: Number(p.closed), wins: Number(p.wins) });
  for (const o of ord) out.get(o.agentId)!.trades = Number(o.n);
  for (const l of led) out.get(l.agentId)!.netDeposits = Number(l.net);
  return out;
}

function toDTO(a: AgentRow, face: AgentBrainFace, s: AgentStats): AgentDTO {
  const paper = a.mode === "paper";
  const balance = paper ? a.paperCashLamports : (a.chainLamports ?? 0);
  const equity = a.markedAt != null && a.equityLamports != null ? a.equityLamports : balance + s.openCost;
  const capital = paper ? a.paperStartLamports : s.netDeposits;
  const pnl = equity - capital;
  return {
    id: a.id,
    owner: a.owner,
    brainId: a.brainId,
    name: a.name,
    walletPubkey: a.walletPubkey,
    mode: a.mode,
    status: a.status,
    haltedReason: a.haltedReason,
    strategy: JSON.parse(a.strategyJson) as StrategySpec,
    useLlm: a.useLlm,
    balanceLamports: balance,
    equityLamports: equity,
    pnlLamports: pnl,
    pnlPct: capital > 0 ? (pnl / capital) * 100 : null,
    capitalLamports: capital,
    walletLamports: a.chainLamports,
    openPositions: s.openPositions,
    trades: s.trades,
    markedAt: a.markedAt,
    createdAt: a.createdAt,
    brain: face,
  };
}

export const UNKNOWN_FACE = (brainId: string): AgentBrainFace => ({
  brainId,
  codename: brainId,
  displayName: null,
  xHandle: null,
  provenance: "unattributed",
  status: "unclaimed",
  avatarUrl: null,
  publicAvatarUrl: null,
});

export async function agentDTOs(rows: AgentRow[]): Promise<AgentDTO[]> {
  const [f, s] = await Promise.all([faces(rows.map((r) => r.brainId)), statsFor(rows.map((r) => r.id))]);
  return rows.map((r) => toDTO(r, f.get(r.brainId) ?? UNKNOWN_FACE(r.brainId), s.get(r.id)!));
}

/** A seat holder's agent (legacy platform-agent rows are never served). */
export async function agentDTO(id: string): Promise<AgentDTO | null> {
  const row = (await getDb().select().from(schema.agents).where(eq(schema.agents.id, id)))[0];
  return row && row.kind === "user" ? (await agentDTOs([row]))[0] : null;
}

export async function listAgentsForOwner(wallet: string): Promise<AgentDTO[]> {
  const rows = await getDb().select().from(schema.agents).where(eq(schema.agents.owner, wallet)).orderBy(desc(schema.agents.createdAt));
  return agentDTOs(rows);
}

// ---------------------------------------------------------------- detail

export function positionDTO(p: PositionRow, solUsd: number | null): AgentPositionDTO {
  const plan = JSON.parse(p.exitPlanJson) as ExitPlan;
  const qty = Number(p.qtyRaw) / 10 ** p.decimals;
  const value = p.status === "open" && p.lastPriceUsd != null && solUsd ? Math.round(((qty * p.lastPriceUsd) / solUsd) * 1e9) : null;
  return {
    mint: p.mint,
    symbol: p.symbol,
    status: p.status,
    qtyRaw: p.qtyRaw,
    decimals: p.decimals,
    costLamports: p.costLamports,
    realizedLamports: p.realizedLamports,
    entryPriceUsd: p.entryPriceUsd,
    entryMcUsd: p.entryMcUsd,
    lastPriceUsd: p.lastPriceUsd,
    lastPriceAt: p.lastPriceAt,
    peakPriceUsd: p.peakPriceUsd,
    valueLamports: value,
    unrealizedLamports: value != null ? value - p.costLamports : null,
    pnlPct: p.entryPriceUsd && p.lastPriceUsd != null ? (p.lastPriceUsd / p.entryPriceUsd - 1) * 100 : null,
    tpStepsHit: p.tpStepsHit,
    initialsOutDone: p.initialsOutDone,
    openedAt: p.openedAt,
    timeStopAt: p.openedAt + plan.timeStopSec,
    closedAt: p.closedAt,
    exitPlan: plan,
  };
}

export function orderDTO(o: OrderRow): AgentOrderDTO {
  return {
    id: o.id,
    side: o.side,
    mint: o.mint,
    symbol: o.symbol,
    status: o.status,
    paper: o.paper,
    signature: o.signature,
    lamports: o.lamports,
    tokenRaw: o.side === "buy" ? o.outAmount : o.inAmount,
    feeLamports: o.feeLamports,
    priceUsd: o.priceUsd,
    mcUsd: o.mcUsd,
    reason: o.reason,
    error: o.error,
    createdAt: o.createdAt,
    filledAt: o.filledAt,
  };
}

export function decisionDTO(d: DecisionRow): AgentDecisionDTO {
  const features = JSON.parse(d.featuresJson) as CandidateFeatures;
  return {
    id: d.id,
    mint: d.mint,
    symbol: features.symbol,
    action: d.action,
    reason: d.reason,
    features,
    llmModel: d.llmModel,
    llmText: d.llmText,
    createdAt: d.createdAt,
  };
}

/** Swarm-informed decisions stay owner-only for PUBLIC_DELAY_SEC. */
export function hiddenFromPublic(d: DecisionRow, now: number): boolean {
  return now - d.createdAt < PUBLIC_DELAY_SEC && (JSON.parse(d.featuresJson) as CandidateFeatures).swarmMembers > 0;
}

export async function getAgentDetail(id: string, viewerWallet: string | null): Promise<AgentDetailDTO | null> {
  const db = getDb();
  const row = (await db.select().from(schema.agents).where(eq(schema.agents.id, id)))[0];
  if (!row || row.kind !== "user") return null; // legacy platform-agent rows are not public
  const isOwner = viewerWallet != null && viewerWallet === row.owner;
  const now = nowSec();
  const [[dto], open, closed, orders, decisions, equity, ledger, solUsd] = await Promise.all([
    agentDTOs([row]),
    db.select().from(schema.agentPositions).where(and(eq(schema.agentPositions.agentId, id), eq(schema.agentPositions.status, "open"))).orderBy(desc(schema.agentPositions.openedAt)),
    db
      .select()
      .from(schema.agentPositions)
      .where(and(eq(schema.agentPositions.agentId, id), eq(schema.agentPositions.status, "closed")))
      .orderBy(desc(schema.agentPositions.closedAt))
      .limit(20),
    db.select().from(schema.agentOrders).where(eq(schema.agentOrders.agentId, id)).orderBy(desc(schema.agentOrders.id)).limit(50),
    db.select().from(schema.agentDecisions).where(eq(schema.agentDecisions.agentId, id)).orderBy(desc(schema.agentDecisions.id)).limit(isOwner ? 50 : 80),
    db
      .select({ t: schema.agentEquity.t, equityLamports: schema.agentEquity.equityLamports })
      .from(schema.agentEquity)
      .where(and(eq(schema.agentEquity.agentId, id), gte(schema.agentEquity.t, now - 7 * 86_400)))
      .orderBy(schema.agentEquity.t),
    isOwner ? db.select().from(schema.agentLedger).where(eq(schema.agentLedger.agentId, id)).orderBy(desc(schema.agentLedger.id)).limit(100) : Promise.resolve([]),
    latestSolUsd(),
  ]);
  const hidden = isOwner ? [] : decisions.filter((d) => hiddenFromPublic(d, now));
  const hiddenIds = new Set(hidden.map((d) => d.id));
  const hiddenMints = new Set(hidden.map((d) => d.mint));
  const visibleOrders = orders.filter((o) => !(o.decisionId != null && hiddenIds.has(o.decisionId)) && !(hiddenMints.has(o.mint) && now - o.createdAt < PUBLIC_DELAY_SEC));
  const visiblePositions = [...open, ...closed].filter((p) => !(hiddenMints.has(p.mint) && now - p.openedAt < PUBLIC_DELAY_SEC));
  const e = env();
  return {
    ...dto,
    isOwner,
    positions: visiblePositions.map((p) => positionDTO(p, solUsd)),
    orders: visibleOrders.map(orderDTO),
    decisions: decisions
      .filter((d) => !hiddenIds.has(d.id))
      .slice(0, 50)
      .map(decisionDTO),
    equityHistory: equity,
    ledger: isOwner
      ? ledger.map(
          (l): AgentLedgerDTO => ({ id: l.id, kind: l.kind, amountLamports: l.amountLamports, signature: l.signature, flagged: l.flagged, createdAt: l.createdAt }),
        )
      : null,
    liveEnabled: e.AGENTS_LIVE_ENABLED,
    agentsEnabled: e.AGENTS_ENABLED,
  };
}

// ---------------------------------------------------------------- leaderboard

export async function getAgentLeaderboard(opts: { brainId?: string | null } = {}): Promise<AgentLeaderboardDTO> {
  const db = getDb();
  // seat holders' agents only (legacy platform-agent rows are excluded)
  const live = and(ne(schema.agents.status, "stopped"), eq(schema.agents.kind, "user"));
  const rows = await db
    .select()
    .from(schema.agents)
    .where(opts.brainId ? and(eq(schema.agents.brainId, opts.brainId), live) : live);
  const [f, s] = await Promise.all([faces(rows.map((r) => r.brainId)), statsFor(rows.map((r) => r.id))]);
  const now = nowSec();
  const out: AgentLeaderboardDTO = { paper: [], live: [] };
  for (const r of rows) {
    const st = s.get(r.id)!;
    const dto = toDTO(r, f.get(r.brainId) ?? UNKNOWN_FACE(r.brainId), st);
    const row: AgentLeaderboardRow = {
      id: r.id,
      name: r.name,
      brainId: r.brainId,
      brain: dto.brain,
      archetype: dto.strategy.archetype,
      mode: r.mode,
      status: r.status,
      pnlLamports: dto.pnlLamports,
      pnlPct: dto.pnlPct,
      trades: st.trades,
      winRate: st.closed ? st.wins / st.closed : null,
      openPositions: st.openPositions,
      createdAt: r.createdAt,
      ageSec: now - r.createdAt,
    };
    out[r.mode].push(row);
  }
  const byPnl = (a: AgentLeaderboardRow, b: AgentLeaderboardRow) => (b.pnlPct ?? -Infinity) - (a.pnlPct ?? -Infinity) || b.trades - a.trades;
  out.paper.sort(byPnl);
  out.live.sort(byPnl);
  return out;
}
