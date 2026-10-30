/**
 * Admin tooling for brain agents (service functions, no HTTP):
 *   pnpm agents:admin derive <brainId…>                      print the derived strategy (summary + provenance)
 *   pnpm agents:admin derive-sample                          one tradable brain per archetype
 *   pnpm agents:admin create <brainId> "<name>" [--owner W] [--no-llm] [--start]
 *                                                             paper agent; owner defaults to the first ADMIN_WALLETS entry
 *   pnpm agents:admin status <agentId> running|paused
 *   pnpm agents:admin refresh <agentId…>                     re-derive strategies from the latest profiles
 *   pnpm agents:admin simulate-live <agentId> <mint> [lamports]   build + sign + simulateTransaction a real Jupiter swap
 *                                                             for the agent wallet (sends nothing)
 */
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { env } from "@/lib/env";
import { simulateLiveSwap } from "@/server/agents/execute";
import { listAgentsForOwner } from "@/server/agents/queries";
import { createAgent, loadAgent, refreshStrategy } from "@/server/agents/service";
import { deriveStrategy } from "@/server/agents/strategy";
import type { BrainProfile } from "@/server/profile/types";

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const db = getDb();

async function derive(brainId: string) {
  const b = (await db.select().from(schema.brains).where(eq(schema.brains.id, brainId)))[0];
  if (!b) return console.log(`${brainId}: not found`);
  const profile = b.profileJson ? (JSON.parse(b.profileJson) as BrainProfile) : null;
  const r = deriveStrategy(profile, { brainId, playbook: b.playbookMd });
  console.log(`\n=== ${brainId} (${b.displayName ?? b.codename}) — ${profile?.archetype.id ?? "no profile"}, tier ${b.tier}`);
  if (!r.ok) return console.log(`  no agent: ${r.reason}`);
  console.log(`  ${r.strategy.summary}`);
  for (const [k, v] of Object.entries(r.strategy.provenance)) console.log(`  · ${k}: ${v}`);
}

switch (cmd) {
  case "derive":
    for (const id of args) await derive(id);
    break;
  case "derive-sample": {
    const rows = await db
      .select({ id: schema.brains.id, a: sql<string>`json_extract(${schema.brains.profileJson}, '$.archetype.id')` })
      .from(schema.brains)
      .where(sql`${schema.brains.profileJson} is not null and ${schema.brains.playbookMd} is not null`)
      .orderBy(sql`${schema.brains.trackScore} desc`);
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.a)) continue;
      seen.add(r.a);
      await derive(r.id);
    }
    break;
  }
  case "create": {
    const [brainId, name] = args;
    const owner = opt("--owner") ?? env().ADMIN_WALLETS[0];
    if (!brainId || !name || !owner) throw new Error('usage: create <brainId> "<name>" [--owner W] (or set ADMIN_WALLETS)');
    const a = await createAgent({ brainId, name, owner, skipAccessCheck: !env().ADMIN_WALLETS.includes(owner), useLlm: !flag("--no-llm") });
    if (flag("--start")) await db.update(schema.agents).set({ status: "running" }).where(eq(schema.agents.id, a.id));
    console.log(`created ${a.id} "${a.name}" owner ${a.owner} wallet ${a.walletPubkey} (${a.mode}, ${flag("--start") ? "running" : a.status})`);
    console.log(`  ${a.strategy.summary}`);
    break;
  }
  case "status": {
    const [id, status] = args;
    if (status !== "running" && status !== "paused") throw new Error("status must be running|paused");
    await db.update(schema.agents).set({ status, haltedReason: null, dayKey: null }).where(eq(schema.agents.id, id));
    console.log(`${id} → ${status}`);
    break;
  }
  case "list": {
    for (const w of env().ADMIN_WALLETS)
      for (const a of await listAgentsForOwner(w)) console.log(`${a.id} "${a.name}" ${a.brainId} ${a.mode}/${a.status} equity ${a.equityLamports} pnl ${a.pnlLamports}`);
    break;
  }
  case "refresh":
    for (const id of args) console.log(`${id}: ${(await refreshStrategy(id, null)).strategy.summary}`);
    break;
  case "simulate-live": {
    const [id, mint, lamports] = args;
    const agent = await loadAgent(id);
    if (!agent || !mint) throw new Error("usage: simulate-live <agentId> <mint> [lamports]");
    const r = await simulateLiveSwap(agent, mint, Number(lamports ?? 10_000_000), 500);
    console.log(JSON.stringify(r, null, 2));
    break;
  }
  default:
    console.log("commands: derive, derive-sample, create, status, refresh, list, simulate-live");
}
process.exit(0);
