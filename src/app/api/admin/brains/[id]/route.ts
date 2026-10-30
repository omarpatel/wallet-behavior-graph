import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db/client";
import { getSession } from "@/server/auth/session";
import { applyTierPricing } from "@/server/profile";

const lamports = z.number().int().min(0).max(1_000_000 * 1_000_000_000);

const Body = z
  .object({
    listed: z.boolean().optional(),
    /** true + any of supply/price/renewal → fixed pricing; false → back to tier pricing. */
    priceOverride: z.boolean().optional(),
    seatSupply: z.number().int().min(1).max(100_000).optional(),
    seatPriceLamports: lamports.optional(),
    renewalPriceLamports: lamports.optional(),
    alertDelaySec: z.number().int().min(0).max(86_400).optional(),
    /** Clears an anti-scalp revenue hold after review. */
    clearRevenueHold: z.literal(true).optional(),
  })
  .strict();

/** Admin-only brain settings: listing, pricing override, alert delay, revenue hold. */
export async function POST(req: Request, ctx: RouteContext<"/api/admin/brains/[id]">) {
  const session = await getSession();
  if (!session) return Response.json({ error: "Sign in required" }, { status: 401 });
  if (!session.isAdmin) return Response.json({ error: "Admin only" }, { status: 403 });

  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  }
  const b = parsed.data;
  const db = getDb();
  const { brains, seats } = schema;
  const [brain] = await db.select({ id: brains.id }).from(brains).where(eq(brains.id, id)).limit(1);
  if (!brain) return Response.json({ error: "Brain not found" }, { status: 404 });

  const pricingTouched = b.seatSupply !== undefined || b.seatPriceLamports !== undefined || b.renewalPriceLamports !== undefined;
  if (pricingTouched && b.priceOverride === false) {
    return Response.json({ error: "Pricing values require priceOverride: true" }, { status: 400 });
  }
  if (b.seatSupply !== undefined) {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(seats)
      .where(eq(seats.brainId, id));
    if (b.seatSupply < n) {
      return Response.json({ error: `Supply cannot drop below the ${n} seats already minted` }, { status: 400 });
    }
  }

  const set: Partial<typeof brains.$inferInsert> = {};
  if (b.listed !== undefined) set.listed = b.listed;
  if (b.alertDelaySec !== undefined) set.alertDelaySec = b.alertDelaySec;
  if (b.clearRevenueHold) {
    set.revenueHeld = false;
    set.revenueHeldReason = null;
  }
  if (pricingTouched || b.priceOverride === true) set.priceOverride = true;
  if (b.priceOverride === false) set.priceOverride = false;
  if (b.seatSupply !== undefined) set.seatSupply = b.seatSupply;
  if (b.seatPriceLamports !== undefined) set.seatPriceLamports = b.seatPriceLamports;
  if (b.renewalPriceLamports !== undefined) set.renewalPriceLamports = b.renewalPriceLamports;

  if (Object.keys(set).length === 0) return Response.json({ error: "Nothing to update" }, { status: 400 });
  await db.update(brains).set(set).where(eq(brains.id, id));
  if (b.priceOverride === false) await applyTierPricing(id);

  const [updated] = await db
    .select({
      id: brains.id,
      listed: brains.listed,
      priceOverride: brains.priceOverride,
      seatSupply: brains.seatSupply,
      seatPriceLamports: brains.seatPriceLamports,
      renewalPriceLamports: brains.renewalPriceLamports,
      alertDelaySec: brains.alertDelaySec,
      revenueHeld: brains.revenueHeld,
    })
    .from(brains)
    .where(eq(brains.id, id));
  return Response.json(updated);
}
