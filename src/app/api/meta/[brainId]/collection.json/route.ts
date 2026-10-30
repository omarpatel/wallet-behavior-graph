import { connection } from "next/server";
import { collectionMetadata, loadBrainForMeta } from "@/server/solana/metadata";

export async function GET(_req: Request, { params }: { params: Promise<{ brainId: string }> }) {
  await connection();
  const brain = await loadBrainForMeta((await params).brainId);
  if (!brain) return Response.json({ error: "Brain not found" }, { status: 404 });
  return Response.json(collectionMetadata(brain), { headers: { "cache-control": "public, max-age=300" } });
}
