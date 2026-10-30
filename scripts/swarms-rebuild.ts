// Rebuild swarm history from all stored trades and print a summary.
// Usage: pnpm exec tsx --env-file-if-exists=.env.local scripts/swarms-rebuild.ts
import { desc, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { fmtUsd } from "@/lib/format";
import { computeMeasuredSwarmRates, swarmOutcomes } from "@/server/signals/outcomes";
import { rebuildSwarmHistory } from "@/server/signals/swarms";
import { SWARM_FULL, SWARM_LARGE, SWARM_MIN } from "@/server/signals/types";

const t0 = Date.now();
const r = await rebuildSwarmHistory();
console.log(
  `rebuilt in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${r.mints} mints with first buys → ${r.swarms} swarms ` +
    `(${r.created} new, ${r.grown} grown, ${r.removed} removed)`,
);

const db = getDb();
const [counts] = await db
  .select({
    min: sql<number>`sum(${schema.swarms.members} >= ${SWARM_MIN})`,
    full: sql<number>`sum(${schema.swarms.members} >= ${SWARM_FULL})`,
    large: sql<number>`sum(${schema.swarms.members} >= ${SWARM_LARGE})`,
  })
  .from(schema.swarms);
console.log(`swarms ≥${SWARM_MIN}: ${counts.min}  ≥${SWARM_FULL}: ${counts.full}  ≥${SWARM_LARGE}: ${counts.large}`);

const top = await db
  .select({ swarm: schema.swarms, symbol: schema.tokens.symbol })
  .from(schema.swarms)
  .leftJoin(schema.tokens, sql`${schema.tokens.mint} = ${schema.swarms.mint}`)
  .orderBy(desc(schema.swarms.members), desc(schema.swarms.startedAt))
  .limit(5);
const out = await swarmOutcomes(top.map((t) => t.swarm));
console.log("top 5 by members:");
for (const { swarm: s, symbol } of top) {
  const o = out.get(s.id)!;
  const slots = new Set((JSON.parse(s.membersJson) as { slot: number }[]).map((m) => m.slot)).size;
  console.log(
    `  #${s.id} $${symbol ?? s.mint.slice(0, 6)} ${s.members} members (${slots} distinct slots) over ${s.lastJoinAt - s.startedAt}s, ` +
      `started ${new Date(s.startedAt * 1000).toISOString()} · MC at start ${fmtUsd(o.mcAtStartUsd)} → 24h peak seen ${fmtUsd(o.peakMcUsd)}` +
      `${o.multiple != null ? ` (${o.multiple.toFixed(2)}×)` : ""}; at detection ${fmtUsd(o.mcAtPublishUsd)} → peak after ${fmtUsd(o.peakAfterPublishMcUsd)}` +
      `${o.multipleFromPublish != null ? ` (${o.multipleFromPublish.toFixed(2)}×)` : ""} · ${o.observedTrades} tracked trades${o.windowComplete ? "" : " (window open)"}`,
  );
}
console.log("measured (complete 24h windows):");
for (const m of await computeMeasuredSwarmRates()) {
  const pct = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
  console.log(
    `  ≥${m.minMembers}: ${m.swarms} swarms, ${m.reached2x} reached 2× from first entry (${pct(m.share2x)}), ` +
      `${m.reached2xFromPublish}/${m.withPublishMc} reached 2× after detection (${pct(m.share2xFromPublish)}), ` +
      `${m.reached100k}/${m.startedBelow100k} that started <$100K reached $100K (${pct(m.share100k)})`,
  );
}
