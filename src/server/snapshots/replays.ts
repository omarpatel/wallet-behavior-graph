/**
 * Token replay list snapshot (`replays`): recent tokens entered by ≥3 listed brains whose first tracked entry is older
 * than PUBLIC_DELAY_SEC. Groups every first buy (full trades scan): worker-only. No next/server-only imports.
 */
import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { CONNECTOME_WINDOW_DAYS } from "@/server/connectome/metrics";
import { PUBLIC_DELAY_SEC, type ReplayListDTO } from "@/server/connectome/types";

const { brains, trades, tokens } = schema;

const REPLAY_LIST_LIMIT = 30;
const REPLAY_MIN_BRAINS = 3;

export async function computeReplays(): Promise<ReplayListDTO> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await getDb().all<{ mint: string; brains: number; firstAt: number; symbol: string | null; icon: string | null }>(sql`
    with fb as (
      select t.brain_id as brain_id, t.mint as mint, min(t.block_time) as at
      from ${trades} t join ${brains} b on b.id = t.brain_id and b.listed = 1
      where t.side = 'buy'
      group by t.brain_id, t.mint
    )
    select fb.mint as mint, count(*) as brains, min(fb.at) as firstAt, k.symbol as symbol, k.icon as icon
    from fb left join ${tokens} k on k.mint = fb.mint
    where fb.at <= ${now - PUBLIC_DELAY_SEC} and fb.at >= ${now - CONNECTOME_WINDOW_DAYS * 86_400}
    group by fb.mint
    having count(*) >= ${REPLAY_MIN_BRAINS}
    order by firstAt desc
    limit ${REPLAY_LIST_LIMIT}`);
  return {
    tokens: rows.map((r) => ({ mint: r.mint, symbol: r.symbol, icon: r.icon, brains: Number(r.brains), firstAt: Number(r.firstAt) })),
  };
}
