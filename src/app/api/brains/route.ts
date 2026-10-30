import { z } from "zod";
import { MissingConfigError } from "@/lib/env";
import { requireSession } from "@/server/auth/session";
import { createBrain, isValidPubkey } from "@/server/brains";

const Body = z.object({
  wallet: z.string().trim().refine(isValidPubkey, "Not a valid Solana wallet address"),
});

/** Create (or return the existing) brain for any public wallet. Session required; backfill is queued. */
export async function POST(req: Request) {
  try {
    await requireSession();
  } catch (res) {
    if (res instanceof Response) return res;
    throw res;
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  }
  try {
    const { id, created } = await createBrain({ wallet: parsed.data.wallet, provenance: "unattributed" });
    return Response.json({ id, created }, { status: created ? 201 : 200 });
  } catch (e) {
    if (e instanceof MissingConfigError) return Response.json({ error: e.message }, { status: 503 });
    throw e;
  }
}
