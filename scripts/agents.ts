/**
 * Brain agents runner: one long-running process trading every agent (paper by default; live needs
 * AGENTS_LIVE_ENABLED=true and the owner's explicit opt-in):
 *   pnpm agents                 run until SIGINT/SIGTERM
 *   pnpm agents -- --for 600    run 600 s, print feed stats + the agents' books, exit (acceptance runs)
 *   pnpm agents -- --picks-only feeds + Brain Picks only: no agent is loaded, no order of any kind can be placed
 *                               (testing picks against a database copy)
 * Logs go to stdout as `<iso> [agents] …`; Brain Picks (src/server/picks), which run inside this process on the same
 * market hub, log as `[picks]`.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { env } from "@/lib/env";
import { agentRpcUrl } from "@/server/agents/config";
import { MarketHub } from "@/server/agents/feeds/hub";
import { agentDTOs } from "@/server/agents/queries";
import { AgentRunner } from "@/server/agents/runner";
import { sol } from "@/server/agents/strategy";
import { PickEngine } from "@/server/picks/engine";

const stamp = (tag: string) => (msg: string) => console.log(`${new Date().toISOString()} [${tag}] ${msg}`);
const log = stamp("agents");
const argFor = process.argv.indexOf("--for");
const forSec = argFor > 0 ? Number(process.argv[argFor + 1]) : 0;
const picksOnly = process.argv.includes("--picks-only");

const e = env();
let runner: AgentRunner | null = null;
let hub: MarketHub;
if (picksOnly) {
  log("starting in --picks-only mode: feeds + Brain Picks, no agents, no orders");
  hub = new MarketHub(agentRpcUrl(), e.PUMPPORTAL_WS_URL, log);
  hub.start();
} else {
  log(`starting: AGENTS_ENABLED=${e.AGENTS_ENABLED} AGENTS_LIVE_ENABLED=${e.AGENTS_LIVE_ENABLED} max deposit ${e.AGENT_MAX_DEPOSIT_SOL} SOL, LLM ${e.AGENT_LLM_CALLS_PER_HOUR}/h per agent`);
  runner = new AgentRunner(log);
  await runner.start();
  hub = runner.hub;
}
const picks = new PickEngine(hub, stamp("picks"));
await picks.start();
setInterval(() => picks.logStats(), 5 * 60_000).unref();
if (picksOnly) setInterval(() => logFeeds(hub), 60_000).unref();

let stopping = false;
async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  log(runner ? "stopping: waiting for in-flight orders" : "stopping");
  await picks.stop();
  if (runner) await runner.stop();
  else hub.stop();
  if (runner) runner.logStats();
  else logFeeds(hub);
  picks.logStats();
  if (runner) await printBooks();
  await printPicks();
  log("stopped");
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
process.on("unhandledRejection", (err) => log(`unhandled rejection: ${err instanceof Error ? err.stack : String(err)}`));
if (forSec > 0) setTimeout(() => void shutdown(0), forSec * 1000);

function logFeeds(h: MarketHub) {
  const s = h.stats();
  log(
    `feeds: pumpportal ${s.pumpportal.connected ? "up" : "DOWN"} (${s.pumpportal.messages} msgs, ${s.pumpportal.creates} new tokens); tokens ${s.tokens} (${s.curves} curves, ${s.pools} pools, ${s.freshPrices} fresh prices); ` +
      `curve sweeps ${s.curveSweeps}, dex sweeps ${s.dexSweeps}, jupiter lists ${s.listPolls}, swarm polls ${s.swarmPolls}; SOL $${s.solUsd?.toFixed(2) ?? "?"}`,
  );
}

async function printBooks() {
  const db = getDb();
  const agents = await db.select().from(schema.agents);
  if (!agents.length) return;
  for (const a of await agentDTOs(agents)) {
    log(
      `book ${a.id} "${a.name}" (${a.brainId}, ${a.strategy.archetype}, ${a.mode}, ${a.status}${a.haltedReason ? `: ${a.haltedReason}` : ""}): ` +
        `cash ${sol(a.balanceLamports)}, equity ${sol(a.equityLamports)}, PnL ${sol(a.pnlLamports)} (${a.pnlPct?.toFixed(2) ?? "?"}%), ${a.openPositions} open, ${a.trades} fills`,
    );
  }
  const ids = agents.map((a) => a.id);
  const orders = await db.select().from(schema.agentOrders).where(inArray(schema.agentOrders.agentId, ids)).orderBy(desc(schema.agentOrders.id)).limit(20);
  for (const o of orders.reverse())
    log(`  order ${o.id} ${o.agentId} ${o.side} ${o.symbol ?? o.mint.slice(0, 6)} ${o.status} ${o.lamports != null ? sol(o.lamports) : ""} ${o.reason}${o.error ? ` (${o.error.slice(0, 120)})` : ""}`);
  const positions = await db.select().from(schema.agentPositions).where(and(inArray(schema.agentPositions.agentId, ids), eq(schema.agentPositions.status, "open")));
  for (const p of positions)
    log(`  open ${p.agentId} ${p.symbol ?? p.mint.slice(0, 6)} cost ${sol(p.costLamports)} entry $${p.entryPriceUsd?.toPrecision(4)} last $${p.lastPriceUsd?.toPrecision(4)} tp ${p.tpStepsHit}`);
}

async function printPicks() {
  const rows = await getDb().select().from(schema.brainPicks).orderBy(desc(schema.brainPicks.id)).limit(20);
  for (const p of rows.reverse())
    log(
      `  pick ${p.id} ${p.brainId} ${p.symbol ?? p.mint.slice(0, 6)} ${p.status}${p.closeReason ? ` (${p.closeReason})` : ""} entry MC ${p.entryMcUsd != null ? `$${Math.round(p.entryMcUsd)}` : "?"} ` +
        `size ${(p.suggestedFraction * 100).toFixed(1)}% last ${p.lastGainPct ?? "?"}% max ${p.maxGainPct ?? "?"}%${p.outcomePct != null ? ` outcome ${p.outcomePct}%` : ""}`,
    );
}
