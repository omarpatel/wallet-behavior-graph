/**
 * One-time repair of shared codenames (idempotent: a no-op once every codename is unique). Runs from scripts/migrate.ts
 * BEFORE the migrations, because 0012 adds the unique index on brains.codename. Raw SQL over columns that predate it,
 * so it also works on a database that is several migrations behind.
 */
import type { Client } from "@libsql/client";
import { resolveCodenameCollisions } from "@/lib/codename";

export async function dedupeCodenames(client: Client): Promise<number> {
  const table = await client.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'brains'");
  if (!table.rows.length) return 0; // fresh database: the migrations create the table with the index
  const rows = (await client.execute("SELECT id, wallet, codename FROM brains")).rows.map((r) => ({
    id: String(r.id),
    wallet: String(r.wallet),
    codename: String(r.codename),
  }));
  const renames = resolveCodenameCollisions(rows);
  if (!renames.size) return 0;
  // Text written in the brain's voice (playbook, alert explanations, chat answers) names the unclaimed brain by its
  // codename (ai/client.ts personaFor): rewrite it so the page stays consistent. Seat metadata is rendered from the row.
  const stmts = rows.flatMap((r) => {
    const name = renames.get(r.wallet);
    if (!name) return [];
    const args = [r.codename, name, r.id];
    return [
      { sql: "UPDATE brains SET codename = ?2, playbook_md = replace(playbook_md, ?1, ?2) WHERE id = ?3", args },
      { sql: "UPDATE alerts SET explanation = replace(explanation, ?1, ?2) WHERE brain_id = ?3 AND instr(explanation, ?1) > 0", args },
      {
        sql: "UPDATE chat_messages SET content = replace(content, ?1, ?2) WHERE brain_id = ?3 AND role = 'assistant' AND instr(content, ?1) > 0",
        args,
      },
    ];
  });
  await client.batch(stmts, "write");
  return renames.size;
}
