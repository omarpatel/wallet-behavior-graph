/**
 * Directory → brains upsert (idempotent). Every wallet the directory marks as brain-eligible (`kol: true`) becomes a
 * brain; every other row only enriches a brain that already exists. Existing brains keep their ids; claimed brains
 * keep the identity their owner set.
 */
import { getDb, schema } from "@/db/client";
import { createBrain } from "@/server/brains";
import { eq } from "drizzle-orm";
import { mergeDirectory, type MergedWallet, type SourceRow } from "./merge";
import { loadDirectoryRows } from "./snapshot";

export interface ImportResult {
  rows: number;
  wallets: number;
  kolWallets: number;
  created: number;
  updated: number;
  perSource: Record<string, number>;
}

export async function importDirectory(rows: SourceRow[] = loadDirectoryRows(), now = Math.floor(Date.now() / 1000)): Promise<ImportResult> {
  const db = getDb();
  const merged = mergeDirectory(rows, now);
  const existing = new Map(
    (
      await db
        .select({ id: schema.brains.id, wallet: schema.brains.wallet, status: schema.brains.status, provenance: schema.brains.provenance })
        .from(schema.brains)
    ).map((b) => [b.wallet, b]),
  );
  const perSource: Record<string, number> = {};
  for (const r of rows) perSource[r.source] = (perSource[r.source] ?? 0) + 1;

  let created = 0;
  let updated = 0;
  for (const w of merged) {
    let brain = existing.get(w.address);
    if (!brain && !w.kol) continue;
    if (!brain) {
      const res = await createBrain({
        wallet: w.address,
        name: w.name ?? undefined,
        xHandle: w.handle ?? undefined,
        provenance: w.studyOnly ? "community_attributed" : "platform_attributed",
        source: provenanceSource(w) ?? undefined,
      });
      if (res.created) created++;
      brain = { id: res.id, wallet: w.address, status: "unclaimed", provenance: w.studyOnly ? "community_attributed" : "platform_attributed" };
    }
    const claimed = brain.status === "claimed" || brain.provenance === "self_verified";
    await db
      .update(schema.brains)
      .set({
        publicAvatarUrl: w.avatarUrl,
        telegram: w.telegram,
        followers: w.followers,
        sourcesJson: JSON.stringify(w.sources),
        externalStatsJson: JSON.stringify(w.externalStats),
        ...(claimed || !w.kol
          ? {}
          : {
              displayName: w.name,
              xHandle: w.handle,
              provenance: w.studyOnly ? "community_attributed" : "platform_attributed",
              provenanceSource: provenanceSource(w),
            }),
      })
      .where(eq(schema.brains.id, brain.id));
    updated++;
  }
  return { rows: rows.length, wallets: merged.length, kolWallets: merged.filter((w) => w.kol).length, created, updated, perSource };
}

/** Evidence link: the directory's profile page, else the X profile it lists. */
function provenanceSource(w: MergedWallet): string | null {
  if (w.provenanceUrl) return w.provenanceUrl;
  return w.handle ? `https://x.com/${w.handle}` : null;
}
