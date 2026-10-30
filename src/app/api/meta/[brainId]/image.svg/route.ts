import { connection } from "next/server";
import { loadBrainForMeta, seatImageSvg } from "@/server/solana/metadata";

/** Generative seat art; `?n=` adds the seat number. */
export async function GET(req: Request, { params }: { params: Promise<{ brainId: string }> }) {
  await connection();
  const brain = await loadBrainForMeta((await params).brainId);
  if (!brain) return new Response("Not found", { status: 404 });
  const nParam = new URL(req.url).searchParams.get("n");
  const n = nParam === null ? null : Number(nParam);
  if (n !== null && (!Number.isInteger(n) || n < 1 || n > brain.seatSupply)) {
    return new Response("Seat number out of range", { status: 404 });
  }
  return new Response(seatImageSvg(brain, n), {
    headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
