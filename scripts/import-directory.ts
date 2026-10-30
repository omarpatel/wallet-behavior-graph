/**
 * Upserts the wallet directory (data/directory/) into brains and re-chooses the live tier. Idempotent.
 *   pnpm import:directory
 */
import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { importDirectory } from "@/server/directory/import";
import { chooseLiveTier } from "@/server/directory/tracking";
import type { DirectorySource, ExternalStats } from "@/server/directory/types";

const db = getDb();
const countBrains = async () => Number((await db.select({ n: sql<number>`count(*)` }).from(schema.brains))[0].n);

const before = await countBrains();
const r = await importDirectory();
const after = await countBrains();
const tiers = await chooseLiveTier();

const rows = await db.select().from(schema.brains);
const bySource: Record<string, number> = {};
let study = 0;
for (const b of rows) {
  for (const s of JSON.parse(b.sourcesJson) as DirectorySource[]) bySource[s.source] = (bySource[s.source] ?? 0) + 1;
  if ((JSON.parse(b.externalStatsJson) as ExternalStats).study) study++;
}
console.log(`[directory] rows ${r.rows} → ${r.wallets} wallets (${r.kolWallets} brain-eligible); per-source rows ${JSON.stringify(r.perSource)}`);
console.log(`[directory] brains ${before} → ${after} (created ${r.created}, updated ${r.updated})`);
console.log(`[directory] brains per source ${JSON.stringify(bySource)}`);
console.log(
  `[directory] with pfp ${rows.filter((b) => b.publicAvatarUrl).length}, telegram ${rows.filter((b) => b.telegram).length}, ` +
    `followers ${rows.filter((b) => b.followers != null).length}, study record ${study}, ` +
    `provenance ${JSON.stringify(Object.fromEntries(["platform_attributed", "community_attributed", "self_verified", "unattributed"].map((p) => [p, rows.filter((b) => b.provenance === p).length])))}`,
);
console.log(`[directory] tiers: ${tiers.live} live, ${tiers.standard} standard (+${tiers.promoted.length} / −${tiers.demoted.length})`);
