/**
 * Agent lifecycle used by the API routes and scripts: create (seat/KOL/admin access + tradable profile), bounded
 * edits, mode switches, strategy refresh and close-all requests. Execution itself lives in the runner process.
 */
import { randomBytes } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { withBusyRetry } from "@/db/retry";
import { hasBrainAccess } from "@/server/access";
import { HttpError } from "@/server/auth/http";
import { env } from "@/lib/env";
import type { BrainProfile } from "@/server/profile/types";
import { maxDepositLamports } from "./config";
import type { AgentRow } from "./execute";
import { netDepositsLamports } from "./funds";
import { agentDTO } from "./queries";
import { applyOverrides, deriveStrategy, sol, validateOverrides } from "./strategy";
import { AGENT_LIMITS, type AgentDTO, type StrategyOverrides, type StrategySpec } from "./types";
import { createAgentWallet } from "./vault";

/** User-facing agent error: routes wrapped in withApi turn it into `{ error }` with `status`. */
export class AgentError extends HttpError {
  constructor(message: string, status: number) {
    super(status, message);
    this.name = "AgentError";
  }
}

const nowSec = () => Math.floor(Date.now() / 1000);

export async function loadAgent(id: string): Promise<AgentRow | null> {
  return (await getDb().select().from(schema.agents).where(eq(schema.agents.id, id)))[0] ?? null;
}

/** Owner-scoped load: 404 for unknown ids and for other owners' agents (no existence leak). */
export async function ownedAgent(id: string, wallet: string): Promise<AgentRow> {
  const a = await loadAgent(id);
  if (!a || a.owner !== wallet) throw new AgentError("Agent not found", 404);
  return a;
}

async function brainForStrategy(brainId: string) {
  const b = (
    await getDb()
      .select({ id: schema.brains.id, profileJson: schema.brains.profileJson, profileVersion: schema.brains.profileVersion, playbookMd: schema.brains.playbookMd })
      .from(schema.brains)
      .where(eq(schema.brains.id, brainId))
  )[0];
  if (!b) throw new AgentError("Brain not found", 404);
  const profile = b.profileJson ? (JSON.parse(b.profileJson) as BrainProfile) : null;
  return { ...b, profile };
}

export interface CreateAgentOptions {
  brainId: string;
  name: string;
  owner: string;
  /** Scripts (admin tooling) may skip the access check; API routes never do. */
  skipAccessCheck?: boolean;
  paperStartLamports?: number;
  useLlm?: boolean;
}

export async function createAgent(o: CreateAgentOptions): Promise<AgentDTO> {
  const name = o.name.trim();
  if (name.length < 2 || name.length > 40) throw new AgentError("Name must be 2–40 characters", 400);
  if (!o.skipAccessCheck) {
    const access = await hasBrainAccess(o.owner, o.brainId);
    if (!access.ok) throw new AgentError("Creating an agent needs an active seat on this brain", 403);
  }
  const db = getDb();
  const [{ n }] = await db.select({ n: count() }).from(schema.agents).where(eq(schema.agents.owner, o.owner));
  if (n >= AGENT_LIMITS.maxAgentsPerOwner) throw new AgentError(`At most ${AGENT_LIMITS.maxAgentsPerOwner} agents per wallet`, 409);
  const brain = await brainForStrategy(o.brainId);
  const paperStart = o.paperStartLamports ?? 5_000_000_000;
  const derived = deriveStrategy(brain.profile, { brainId: o.brainId, playbook: brain.playbookMd, capitalLamports: paperStart });
  if (!derived.ok) throw new AgentError(derived.reason, 422);
  const id = `ag_${randomBytes(8).toString("hex")}`;
  const wallet = createAgentWallet(id);
  await withBusyRetry(
    () =>
      db.insert(schema.agents).values({
        id,
        owner: o.owner,
        brainId: o.brainId,
        name,
        walletPubkey: wallet.pubkey,
        encSecret: wallet.encSecret,
        mode: "paper",
        status: "paused",
        strategyJson: JSON.stringify(derived.strategy),
        strategyProfileVersion: brain.profileVersion,
        useLlm: o.useLlm ?? true,
        paperStartLamports: paperStart,
        paperCashLamports: paperStart,
      }),
    { label: "agent create" },
  );
  console.log(`${new Date().toISOString()} [agents] created ${id} "${name}" on ${o.brainId} for ${o.owner} (wallet ${wallet.pubkey}, paper, paused)`);
  return (await agentDTO(id))!;
}

export interface PatchAgent {
  status?: "running" | "paused";
  mode?: "paper" | "live";
  useLlm?: boolean;
  strategyOverrides?: StrategyOverrides;
  acknowledgeCustodialRisk?: boolean;
}

/** Why a halted agent may not resume yet, or null. */
async function resumeBlocker(a: AgentRow): Promise<string | null> {
  const net = await netDepositsLamports(a.id);
  if (net > maxDepositLamports()) return `Net deposits ${sol(net)} exceed the ${sol(maxDepositLamports())} limit; withdraw the excess first`;
  const access = await hasBrainAccess(a.owner, a.brainId);
  if (!access.ok) return "Your seat on this brain is no longer active";
  return null;
}

export async function patchAgent(id: string, wallet: string, p: PatchAgent): Promise<AgentDTO> {
  const a = await ownedAgent(id, wallet);
  const db = getDb();
  const set: Partial<typeof schema.agents.$inferInsert> = { updatedAt: nowSec() };
  const e = env();

  if (p.strategyOverrides !== undefined) {
    let overrides: StrategyOverrides;
    try {
      overrides = validateOverrides(p.strategyOverrides);
    } catch (err) {
      throw new AgentError(err instanceof Error ? err.message : "Invalid overrides", 400);
    }
    const prior = a.overridesJson ? (JSON.parse(a.overridesJson) as StrategyOverrides) : {};
    const merged: StrategyOverrides = {
      sizing: { ...prior.sizing, ...overrides.sizing },
      exit: { ...prior.exit, ...overrides.exit },
      risk: { ...prior.risk, ...overrides.risk },
    };
    const brain = await brainForStrategy(a.brainId);
    const derived = deriveStrategy(brain.profile, { brainId: a.brainId, playbook: brain.playbookMd, capitalLamports: a.paperStartLamports });
    const base = derived.ok ? derived.strategy : (JSON.parse(a.strategyJson) as StrategySpec);
    set.overridesJson = JSON.stringify(merged);
    set.strategyJson = JSON.stringify(applyOverrides(base, validateOverrides(merged)));
  }
  if (p.useLlm !== undefined) set.useLlm = p.useLlm;

  if (p.mode !== undefined && p.mode !== a.mode) {
    if (p.mode === "live") {
      if (!e.AGENTS_LIVE_ENABLED) throw new AgentError("Live trading is switched off on this platform (AGENTS_LIVE_ENABLED)", 403);
      if (p.acknowledgeCustodialRisk !== true)
        throw new AgentError("Switching to live requires acknowledgeCustodialRisk: true (the server holds this agent's key and trades real funds)", 400);
    } else {
      const [{ n }] = await db
        .select({ n: count() })
        .from(schema.agentPositions)
        .where(and(eq(schema.agentPositions.agentId, a.id), eq(schema.agentPositions.status, "open")));
      if (n > 0) throw new AgentError("Close the agent's live positions before switching back to paper", 409);
    }
    // a mode switch starts a fresh book: paper positions are simulated and simply closed, cash resets
    await withBusyRetry(
      () =>
        db.transaction(async (tx) => {
          if (a.mode === "paper") {
            await tx
              .update(schema.agentPositions)
              .set({ status: "closed", closedAt: nowSec(), qtyRaw: "0", costLamports: 0 })
              .where(and(eq(schema.agentPositions.agentId, a.id), eq(schema.agentPositions.status, "open")));
          }
          await tx.insert(schema.agentLedger).values({ agentId: a.id, kind: "paper_reset", amountLamports: a.paperStartLamports });
        }),
      { label: "agent mode switch" },
    );
    Object.assign(set, {
      mode: p.mode,
      paperCashLamports: a.paperStartLamports,
      equityLamports: null,
      markedAt: null,
      dayKey: null,
      dayStartEquityLamports: null,
      status: "paused",
      haltedReason: null,
    } satisfies Partial<typeof schema.agents.$inferInsert>);
    console.log(`${new Date().toISOString()} [agents] ${a.id} mode ${a.mode} → ${p.mode} by owner (paused; fresh book)`);
  }

  if (p.status !== undefined) {
    if (p.status === "running" && a.status === "halted") {
      const blocker = await resumeBlocker(a);
      if (blocker) throw new AgentError(blocker, 409);
    }
    set.status = p.status;
    if (p.status === "running") {
      set.haltedReason = null;
      set.dayKey = null; // guardian re-baselines at the next mark
    }
  }

  await withBusyRetry(() => db.update(schema.agents).set(set).where(eq(schema.agents.id, a.id)), { label: "agent patch" });
  return (await agentDTO(a.id))!;
}

/** Re-derive from the brain's latest profile, keeping the owner's overrides. */
export async function refreshStrategy(id: string, wallet: string | null): Promise<AgentDTO> {
  const a = wallet ? await ownedAgent(id, wallet) : await loadAgent(id);
  if (!a) throw new AgentError("Agent not found", 404);
  const brain = await brainForStrategy(a.brainId);
  const derived = deriveStrategy(brain.profile, { brainId: a.brainId, playbook: brain.playbookMd, capitalLamports: a.paperStartLamports });
  if (!derived.ok) throw new AgentError(derived.reason, 422);
  const overrides = a.overridesJson ? validateOverrides(JSON.parse(a.overridesJson) as StrategyOverrides) : null;
  const strategy = applyOverrides(derived.strategy, overrides);
  await withBusyRetry(
    () =>
      getDb()
        .update(schema.agents)
        .set({ strategyJson: JSON.stringify(strategy), strategyProfileVersion: brain.profileVersion, updatedAt: nowSec() })
        .where(eq(schema.agents.id, a.id)),
    { label: "agent refresh strategy" },
  );
  return (await agentDTO(a.id))!;
}

/** Flag the agent for close-all; the runner sells every open position on its next tick. */
export async function requestCloseAll(id: string, wallet: string): Promise<number> {
  const a = await ownedAgent(id, wallet);
  const at = nowSec();
  await withBusyRetry(() => getDb().update(schema.agents).set({ closeAllRequestedAt: at, updatedAt: at }).where(eq(schema.agents.id, a.id)), {
    label: "agent close-all",
  });
  return at;
}
