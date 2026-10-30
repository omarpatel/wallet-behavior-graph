import { z } from "zod";
import { getSession } from "@/server/auth/session";
import { listSwarms } from "@/server/signals/queries";

const Query = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  min: z.coerce.number().int().min(3).max(1000).optional(),
  before: z.coerce.number().int().min(0).optional(),
});

/**
 * Recent + historical swarms with our measured outcome and the external reference base rates. Token identity is hidden
 * until PUBLIC_DELAY_SEC after the last member joined, unless the viewer holds an active seat on a member brain.
 */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const parsed = Query.safeParse({
    limit: sp.get("limit") || undefined,
    min: sp.get("min") || undefined,
    before: sp.get("before") || undefined,
  });
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid query" }, { status: 400 });
  const session = await getSession();
  return Response.json(
    await listSwarms({
      viewerWallet: session?.wallet ?? null,
      limit: parsed.data.limit,
      minMembers: parsed.data.min,
      before: parsed.data.before,
    }),
  );
}
