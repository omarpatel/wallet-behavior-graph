import { connection } from "next/server";
import { loadBrainForMeta, seatMetadata } from "@/server/solana/metadata";

/** Seat metadata; `n` may carry a `.json` suffix (the on-chain uri uses `<n>.json`). */
export async function GET(_req: Request, { params }: { params: Promise<{ brainId: string; n: string }> }) {
  await connection();
  const { brainId, n: raw } = await params;
  const n = Number(raw.replace(/\.json$/, ""));
  const brain = await loadBrainForMeta(brainId);
  if (!brain) return Response.json({ error: "Brain not found" }, { status: 404 });
  if (!Number.isInteger(n) || n < 1 || n > brain.seatSupply) {
    return Response.json({ error: "Seat number out of range" }, { status: 404 });
  }
  return Response.json(seatMetadata(brain, n), { headers: { "cache-control": "public, max-age=300" } });
}
