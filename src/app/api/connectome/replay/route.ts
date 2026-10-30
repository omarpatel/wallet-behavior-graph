import { z } from "zod";
import { getReplay } from "@/server/connectome/queries";

const Query = z.object({ mint: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "mint must be a base58 token address") });

/** One token's entries/exits across tracked brains (public: events older than PUBLIC_DELAY_SEC). */
export async function GET(req: Request) {
  const parsed = Query.safeParse({ mint: new URL(req.url).searchParams.get("mint") ?? "" });
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid query" }, { status: 400 });
  const dto = await getReplay(parsed.data.mint);
  if (!dto) return Response.json({ error: "No public entries for this token yet" }, { status: 404 });
  return Response.json(dto);
}
