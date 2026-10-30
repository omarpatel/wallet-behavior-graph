import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db/client";

const Body = z.object({
  brainId: z
    .string()
    .trim()
    .max(80)
    .optional()
    .transform((v) => v || undefined),
  contact: z.string().trim().min(3, "Add an email, X handle or other way to reach you").max(200),
  kind: z.enum(["correction", "opt_out", "other"]),
  message: z.string().trim().min(10, "Describe the request in at least 10 characters").max(4000),
});

/** Public disputes / corrections / opt-out intake (GDPR Art. 21, right of reply). */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  }
  const { brainId, contact, kind, message } = parsed.data;
  const db = getDb();
  if (brainId) {
    const [b] = await db.select({ id: schema.brains.id }).from(schema.brains).where(eq(schema.brains.id, brainId)).limit(1);
    if (!b) return Response.json({ error: `Unknown brain "${brainId}"` }, { status: 400 });
  }
  const [row] = await db
    .insert(schema.disputes)
    .values({ brainId: brainId ?? null, contact, kind, message })
    .returning({ id: schema.disputes.id });
  return Response.json({ id: row.id }, { status: 201 });
}
