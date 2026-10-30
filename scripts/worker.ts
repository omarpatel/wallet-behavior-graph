/**
 * Worker: long-running loop of independent periodic tasks with per-task error isolation.
 *   pnpm worker
 * RPC mode (no HELIUS_API_KEY): live-polls the live tier every ~15 s. Helius without a public https PUBLIC_URL:
 * live-polls the live tier every 30 s. Helius + public PUBLIC_URL + HELIUS_WEBHOOK_AUTH: webhook does live, the worker
 * reconciles the live tier every 10 min and keeps the webhook address list in sync. Standard-tier brains are reconciled
 * every 6 h (staggered); tiers are re-chosen hourly (src/server/directory/tracking.ts).
 */
import { setTimeout as sleep } from "node:timers/promises";
import { and, eq, gt, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { getDb, getDbClient, schema } from "@/db/client";
import { env } from "@/lib/env";
import { explainPendingAlerts } from "@/server/ai/explain";
import { refreshPlaybook } from "@/server/ai/playbook";
import { runAntiScalpCheck } from "@/server/alerts";
import { prewarmAvatars } from "@/server/avatars/cache";
import { recomputeConnectome } from "@/server/connectome/compute";
import {
  chooseLiveTier,
  countStandardDone,
  liveBrainIds,
  markReconciled,
  nextPendingBackfills,
  RECONCILE_EVERY_SEC,
  standardBrainsDue,
} from "@/server/directory/tracking";
import { backfillBrain, brainsNeedingProfile, pollBrain } from "@/server/ingest/pipeline";
import { refreshCurrentSolUsd } from "@/server/ingest/solusd";
import { refreshRugChecks, refreshStaleTokens } from "@/server/ingest/tokens";
import { liveWallets, syncHeliusWebhook } from "@/server/ingest/webhooks";
import { recomputeProfile } from "@/server/profile";
import { expireStaleActions } from "@/server/solana/actions";
import { computeMeasuredSwarmRates } from "@/server/signals/outcomes";
import { rebuildSwarmHistory } from "@/server/signals/swarms";
import { computeLanding } from "@/server/snapshots/landing";
import { computeLeaderboard, type Leaderboard } from "@/server/snapshots/leaderboard";
import { computeReplays } from "@/server/snapshots/replays";
import { computeSquads, type SquadsSnapshot } from "@/server/snapshots/squads";
import { readSnapshot, SNAPSHOT_KEYS, writeSnapshot } from "@/server/snapshots/store";
import { pollClaimedTweets } from "@/server/x/poll";

const log = (task: string, msg: string) => console.log(`${new Date().toISOString()} [${task}] ${msg}`);

interface Task {
  name: string;
  everyMs: number;
  run: () => Promise<string | void>;
  /** Run once right at startup instead of waiting a full interval. */
  immediate?: boolean;
}

const e = env();
const heliusMode = Boolean(e.HELIUS_API_KEY);
/** Helius can only deliver webhooks to a publicly reachable https URL. */
const webhookMode =
  heliusMode && Boolean(e.HELIUS_WEBHOOK_AUTH) && /^https:\/\/(?!localhost|127\.)/.test(e.PUBLIC_URL);
let stopping = false;
const running = new Set<Promise<void>>();
const timers: NodeJS.Timeout[] = [];

async function pollIds(task: string, ids: string[]): Promise<string> {
  let trades = 0;
  let alerts = 0;
  let txs = 0;
  for (const id of ids) {
    if (stopping) break;
    try {
      const r = await pollBrain(id);
      await markReconciled(id);
      txs += r.txs;
      trades += r.trades.length;
      alerts += r.alerts;
      if (r.trades.length) log(task, `${id}: ${r.trades.length} new trades, ${r.alerts} alerts`);
      if (r.skipped) log(task, `${id}: skipped ${r.skipped} older txs over the per-poll budget (flooded wallet; Helius mode avoids this)`);
      if (r.incomplete) log(task, `${id}: fetch stopped early (${r.incomplete}); resuming from the saved cursor next pass`);
    } catch (err) {
      log(task, `${id} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return `polled ${ids.length} brains: ${txs} txs, ${trades} new trades, ${alerts} alerts`;
}

const pollLive = async () => pollIds("live", await liveBrainIds());

/** Standard tier: every pass takes the oldest-reconciled share so the whole tier cycles once per RECONCILE_EVERY_SEC. */
const STANDARD_PASS_MS = 5 * 60_000;
async function reconcileStandard(): Promise<string | undefined> {
  const passes = (RECONCILE_EVERY_SEC * 1000) / STANDARD_PASS_MS;
  const ids = await standardBrainsDue(Math.ceil((await countStandardDone()) / passes));
  return ids.length ? pollIds("standard", ids) : undefined;
}

const backfilling = new Set<string>();
/** Tops up to BACKFILL_CONCURRENCY parallel backfills (live tier first); each runs detached and logs its own result. */
async function startBackfills(): Promise<string | undefined> {
  const ids = await nextPendingBackfills(e.BACKFILL_CONCURRENCY - backfilling.size, [...backfilling]);
  for (const id of ids) {
    backfilling.add(id);
    log("backfill", `starting ${id} (${backfilling.size}/${e.BACKFILL_CONCURRENCY} in flight)`);
    const started = Date.now();
    const p = backfillBrain(id)
      .then((r) =>
        log(
          "backfill",
          `${id}: scanned ${r.scannedSignatures} sigs, ${r.txs} txs → ${r.trades.length} trades, ${r.transfers} transfers; profile computed (${((Date.now() - started) / 1000).toFixed(1)}s)`,
        ),
      )
      .catch((err) => log("backfill", `${id} failed: ${err instanceof Error ? err.message : err}`))
      .finally(() => {
        backfilling.delete(id);
        running.delete(p);
      });
    running.add(p);
  }
  return undefined;
}

let lastWalletSet = "";

const tasks: Task[] = [
  { name: "backfill", everyMs: 5_000, immediate: true, run: startBackfills },
  webhookMode
    ? { name: "reconcile", everyMs: 10 * 60_000, run: pollLive }
    : { name: "live", everyMs: heliusMode ? 30_000 : 15_000, immediate: true, run: pollLive },
  { name: "standard", everyMs: STANDARD_PASS_MS, run: reconcileStandard },
  {
    name: "tiers",
    everyMs: 60 * 60_000,
    run: async () => {
      const t = await chooseLiveTier();
      return t.promoted.length || t.demoted.length
        ? `${t.live} live / ${t.standard} standard; promoted [${t.promoted.join(", ")}], demoted [${t.demoted.join(", ")}]`
        : undefined;
    },
  },
  {
    name: "tokens",
    everyMs: 60_000,
    run: async () => {
      const n = await refreshStaleTokens();
      return n ? `refreshed ${n} tokens` : undefined;
    },
  },
  {
    name: "solusd",
    everyMs: 60_000,
    immediate: true,
    run: async () => {
      const px = await refreshCurrentSolUsd();
      return px != null ? `SOL/USD ${px.toFixed(2)}` : undefined;
    },
  },
  {
    name: "profile",
    everyMs: 60_000,
    run: async () => {
      const ids = await brainsNeedingProfile(300);
      for (const id of ids) {
        if (stopping) break;
        try {
          const p = await recomputeProfile(id);
          log("profile", `${id}: ${p.archetype.id}, tier ${p.tier}, ${p.sample.trades} trades`);
        } catch (err) {
          log("profile", `${id} failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    },
  },
  {
    name: "connectome",
    everyMs: 10 * 60_000,
    immediate: true,
    run: async () => {
      const r = await recomputeConnectome();
      return `${r.synapses} synapses (${r.candidates} candidate pairs, ${r.coEntries} co-entries), ${r.regions} regions over ${r.neurons} neurons`;
    },
  },
  {
    name: "playbook",
    everyMs: 60_000,
    run: async () => {
      const db = getDb();
      // A playbook is written once per brain, then refreshed at most every PLAYBOOK_REFRESH_DAYS: profiles of active
      // wallets change every few minutes, and regenerating on every version (gpt-5.5) cost ~$40–80/hour.
      const refreshBefore = Math.floor(Date.now() / 1000) - e.PLAYBOOK_REFRESH_DAYS * 86_400;
      const stale = await db
        .select({ id: schema.brains.id })
        .from(schema.brains)
        .where(
          and(
            isNotNull(schema.brains.profileJson),
            gt(schema.brains.profileVersion, 0),
            or(
              isNull(schema.brains.playbookMd),
              and(
                ne(schema.brains.playbookProfileVersion, schema.brains.profileVersion),
                or(isNull(schema.brains.playbookUpdatedAt), lt(schema.brains.playbookUpdatedAt, refreshBefore)),
                // Refresh only brains people use: real-time tier, or any seat or agent. The rest keep their playbook.
                or(
                  eq(schema.brains.tracking, "live"),
                  sql`exists (select 1 from ${schema.seats} where ${schema.seats.brainId} = ${schema.brains.id})`,
                  sql`exists (select 1 from ${schema.agents} where ${schema.agents.brainId} = ${schema.brains.id})`,
                ),
              ),
            ),
          ),
        )
        .limit(20);
      for (const { id } of stale) {
        if (stopping) break;
        try {
          await refreshPlaybook(id);
          const [row] = await db
            .select({ pb: schema.brains.playbookProfileVersion, pv: schema.brains.profileVersion })
            .from(schema.brains)
            .where(eq(schema.brains.id, id));
          if (row && row.pb === row.pv) log("playbook", `${id} refreshed (profile v${row.pv})`);
        } catch (err) {
          log("playbook", `${id} failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    },
  },
  {
    name: "explain",
    everyMs: 5_000,
    run: async () => {
      const n = await explainPendingAlerts();
      return n ? `explained ${n} alerts` : undefined;
    },
  },
  ...(e.X_BEARER_TOKEN
    ? [{ name: "tweets", everyMs: 2 * 60_000, run: async () => void (await pollClaimedTweets()) }]
    : []),
  {
    name: "actions",
    everyMs: 30_000,
    run: async () => {
      const n = await expireStaleActions();
      return n ? `expired ${n} chain actions` : undefined;
    },
  },
  {
    name: "antiscalp",
    everyMs: 5 * 60_000,
    run: async () => {
      const n = await runAntiScalpCheck();
      return n ? `held revenue for ${n} brain(s)` : undefined;
    },
  },
  {
    // live inserts update swarms immediately (createAlertsForTrades); this rebuilds history from all trades so
    // backfilled brains and standard-reconciled wallets are counted too
    name: "swarms",
    everyMs: 10 * 60_000,
    immediate: true,
    run: async () => {
      const r = await rebuildSwarmHistory();
      return `${r.swarms} swarms (${r.created} new, ${r.grown} grown, ${r.removed} removed)`;
    },
  },
  {
    // pfps cached under data/avatars (served by /api/avatar/<id>); fresh entries are skipped, downloads paced 2/s
    name: "avatars",
    everyMs: 6 * 60 * 60_000,
    immediate: true,
    run: () => prewarmAvatars({ shouldStop: () => stopping, onProgress: (m) => log("avatars", m) }),
  },
  {
    name: "rugcheck",
    everyMs: 2 * 60_000,
    run: async () => {
      const n = await refreshRugChecks();
      return n ? `RugCheck refreshed ${n} tokens` : undefined;
    },
  },
  ...(webhookMode
    ? [
        {
          name: "webhook",
          everyMs: 60_000,
          immediate: true,
          run: async () => {
            const wallets = (await liveWallets()).join(",");
            if (wallets === lastWalletSet) return;
            const r = await syncHeliusWebhook();
            lastWalletSet = wallets;
            return `${r.action} ${r.webhookID} with ${r.addresses} live addresses`;
          },
        },
      ]
    : []),
  // Request-time aggregates (src/server/snapshots): computed here from reads only, stored with one short upsert each;
  // the site only ever reads them by primary key.
  {
    name: "snap-landing",
    everyMs: 60_000,
    immediate: true,
    run: async () => {
      const v = await computeLanding();
      const bytes = await writeSnapshot(SNAPSHOT_KEYS.landing, v);
      return `${v.tradesToday} trades today, ${v.faces.length} faces (${(bytes / 1024).toFixed(0)} KiB)`;
    },
  },
  {
    name: "snap-leaderboard",
    everyMs: 3 * 60_000,
    immediate: true,
    run: async () => {
      const v = await computeLeaderboard();
      const bytes = await writeSnapshot(SNAPSHOT_KEYS.leaderboard, v, v.computedAt);
      return `${v.rows.length} rows (${(bytes / 1024).toFixed(0)} KiB)`;
    },
  },
  {
    // rebuilt whenever a newer leaderboard snapshot exists (squads share its computedAt)
    name: "snap-squads",
    everyMs: 60_000,
    immediate: true,
    run: async () => {
      const [board, prev] = await Promise.all([
        readSnapshot<Leaderboard>(SNAPSHOT_KEYS.leaderboard),
        readSnapshot<SquadsSnapshot>(SNAPSHOT_KEYS.squads),
      ]);
      if (!board || prev?.computedAt === board.computedAt) return;
      const v = await computeSquads(board.value);
      const bytes = await writeSnapshot(SNAPSHOT_KEYS.squads, v, board.computedAt);
      return `${v.squads.length} squads (${(bytes / 1024).toFixed(0)} KiB)`;
    },
  },
  {
    name: "snap-swarm-rates",
    everyMs: 10 * 60_000,
    immediate: true,
    run: async () => {
      const v = await computeMeasuredSwarmRates();
      await writeSnapshot(SNAPSHOT_KEYS.swarmRates, v);
      return v.map((r) => `≥${r.minMembers}: ${r.swarms}`).join(", ") + " swarms measured";
    },
  },
  {
    name: "snap-replays",
    everyMs: 5 * 60_000,
    immediate: true,
    run: async () => {
      const v = await computeReplays();
      await writeSnapshot(SNAPSHOT_KEYS.replays, v);
      return `${v.tokens.length} replay tokens`;
    },
  },
  {
    // long readers (backfills, snapshots) starve automatic PASSIVE checkpoints; TRUNCATE waits for them (busy
    // timeout) and resets the WAL to zero bytes
    name: "wal",
    everyMs: 5 * 60_000,
    immediate: true,
    run: async () => {
      const r = await getDbClient().execute("PRAGMA wal_checkpoint(TRUNCATE)");
      const [busy, logFrames, checkpointed] = r.rows[0] ? Object.values(r.rows[0]).map(Number) : [];
      return `checkpoint(TRUNCATE): busy=${busy}, wal frames=${logFrames}, checkpointed=${checkpointed}`;
    },
  },
];

function schedule(task: Task): void {
  let busy = false;
  const tick = () => {
    if (busy || stopping) return;
    busy = true;
    const started = Date.now();
    const p = task
      .run()
      .then((msg) => {
        if (msg) log(task.name, `${msg} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      })
      .catch((err) => log(task.name, `error: ${err instanceof Error ? err.stack ?? err.message : err}`))
      .finally(() => {
        busy = false;
        running.delete(p);
      });
    running.add(p);
  };
  timers.push(setInterval(tick, task.everyMs));
  if (task.immediate) tick();
}

async function main() {
  // a crash mid-backfill leaves "running"; requeue
  await getDb().update(schema.brains).set({ backfillStatus: "pending" }).where(eq(schema.brains.backfillStatus, "running"));
  const t = await chooseLiveTier();
  log("tiers", `${t.live} live / ${t.standard} standard (LIVE_TRACKED_MAX ${e.LIVE_TRACKED_MAX}; +${t.promoted.length} / −${t.demoted.length})`);
  log(
    "worker",
    `starting in ${heliusMode ? "helius" : "rpc"} mode, backfill concurrency ${e.BACKFILL_CONCURRENCY}, tasks: ${tasks.map((t) => `${t.name}/${t.everyMs / 1000}s`).join(", ")}`,
  );
  for (const t of tasks) schedule(t);
}

async function shutdown(signal: string) {
  if (stopping) process.exit(1);
  stopping = true;
  log("worker", `${signal}: stopping, waiting for ${running.size} running task(s)`);
  for (const t of timers) clearInterval(t);
  await Promise.race([Promise.allSettled([...running]), sleep(30_000)]);
  log("worker", "stopped");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await main();
