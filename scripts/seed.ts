/**
 * Seed brains from the wallet directory (data/directory/, a synthetic sample by default; see src/server/directory).
 *   pnpm seed                         import the directory + choose the live tier (backfill left to the worker)
 *   pnpm seed -- --backfill           also backfill + profile the selected brains, sequentially
 *   pnpm seed -- --only <name|handle|wallet|id> [--only …]   restrict --backfill to matching brains
 */
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { fmtDuration, fmtPct, fmtUsd } from "@/lib/format";
import { importDirectory } from "@/server/directory/import";
import { chooseLiveTier } from "@/server/directory/tracking";
import { backfillBrain } from "@/server/ingest/pipeline";
import type { BrainProfile } from "@/server/profile/types";

const args = process.argv.slice(2).filter((a) => a !== "--");
const backfill = args.includes("--backfill");
const only: string[] = [];
args.forEach((a, i) => {
  if (a === "--only" && args[i + 1]) only.push(args[i + 1].toLowerCase());
});

async function main() {
  const db = getDb();
  const r = await importDirectory();
  const tiers = await chooseLiveTier();
  const brains = await db
    .select({ id: schema.brains.id, wallet: schema.brains.wallet, name: schema.brains.displayName, x: schema.brains.xHandle })
    .from(schema.brains);
  const ids = brains
    .filter((b) => !only.length || only.some((o) => [b.id, b.wallet.toLowerCase(), b.name?.toLowerCase(), b.x?.toLowerCase()].includes(o)))
    .map((b) => b.id);
  console.log(
    `[seed] directory ${r.wallets} wallets (${r.kolWallets} brain-eligible): created ${r.created}, updated ${r.updated}; ` +
      `${tiers.live} live / ${tiers.standard} standard; selected ${only.length ? ids.length : 0}`,
  );
  if (only.length && !ids.length) {
    console.error(`[seed] --only ${only.join(", ")} matched nothing`);
    process.exitCode = 1;
  }
  if (!backfill) return;
  if (!only.length) console.log(`[seed] --backfill without --only: backfilling all ${ids.length} brains`);

  for (const id of ids) {
    const started = Date.now();
    console.log(`[seed] backfilling ${id} …`);
    try {
      const r = await backfillBrain(id);
      const [brain] = await db.select().from(schema.brains).where(eq(schema.brains.id, id));
      const p = brain.profileJson ? (JSON.parse(brain.profileJson) as BrainProfile) : null;
      const valued = r.trades.filter((t) => t.usdValue != null).length;
      const withMc = r.trades.filter((t) => t.mcUsd != null).length;
      const withDelay = r.trades.filter((t) => t.entryDelaySec != null).length;
      console.log(
        `[seed] ${id}: scanned ${r.scannedSignatures} sigs, fetched ${r.txs} txs → ${r.trades.length} new trades ` +
          `(${valued} USD-valued, ${withMc} with MC, ${withDelay} with entry delay), ${r.transfers} transfers in ${fmtDuration((Date.now() - started) / 1000)}`,
      );
      if (p) {
        console.log(
          `[seed] ${id} profile v${brain.profileVersion}: trades ${p.sample.trades}, tokens ${p.sample.tokens}, ` +
            `archetype ${p.archetype.label} (${p.archetype.reason}), medianHold ${fmtDuration(p.hold.medianHoldSec)}, ` +
            `medianEntryMc ${fmtUsd(p.entryMc.medianUsd)}, medianEntryDelay ${fmtDuration(p.timing.medianEntryDelaySec)}, ` +
            `realized ${fmtUsd(p.pnl.realizedUsd)} (${p.pnl.realizedSol.toFixed(2)} SOL), winRate ${fmtPct(p.pnl.winRate)}, ` +
            `tier ${p.tier}${p.trackScore != null ? ` (${p.trackScore})` : ""}, flags [${p.flags.map((f) => f.id).join(", ")}]`,
        );
      }
    } catch (err) {
      console.error(`[seed] ${id} failed:`, err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  }
}

await main();
