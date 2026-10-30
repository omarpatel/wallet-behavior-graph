// Recompute every stored profile (run after a methodology change). Usage: pnpm profiles:recompute [brainId…]
import { inArray, isNotNull } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { recomputeProfile } from "@/server/profile";

const ids = process.argv.slice(2);
const rows = await getDb()
  .select({ id: schema.brains.id })
  .from(schema.brains)
  .where(ids.length ? inArray(schema.brains.id, ids) : isNotNull(schema.brains.profileJson));

for (const { id } of rows) {
  const p = await recomputeProfile(id);
  console.log(
    `${id.padEnd(18)} ${p.archetype.label.padEnd(30)} tier ${p.tier.padEnd(8)} trades ${String(p.sample.trades).padStart(4)}` +
      `  median buy ${p.sizing.medianBuySol?.toFixed(3) ?? "—"} SOL  median hold ${p.hold.medianHoldSec ?? "—"}s` +
      `  realized $${p.pnl.realizedUsd.toFixed(0)}`,
  );
}
