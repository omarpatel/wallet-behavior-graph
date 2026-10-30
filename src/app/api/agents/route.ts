import { connection } from "next/server";
import { listAgentsForOwner } from "@/server/agents/queries";
import { createAgent } from "@/server/agents/service";
import { readJson, withApi } from "@/server/auth/http";
import { requireSession } from "@/server/auth/session";

/** The signed-in wallet's agents → AgentDTO[]. */
export const GET = withApi(async () => {
  await connection();
  const { wallet } = await requireSession();
  return Response.json(await listAgentsForOwner(wallet));
});

/** `{ brainId, name }` → AgentDTO (paper, paused, strategy derived). Needs an active seat on the brain (or KOL/admin). */
export const POST = withApi(async (req: Request) => {
  const { wallet } = await requireSession();
  const body = await readJson(req);
  return Response.json(await createAgent({ brainId: String(body.brainId ?? ""), name: String(body.name ?? ""), owner: wallet }), { status: 201 });
});
