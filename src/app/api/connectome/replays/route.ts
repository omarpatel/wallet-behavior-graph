import { getReplays } from "@/server/connectome/queries";

/** Tokens available for replay (≥3 tracked brains, first entry older than PUBLIC_DELAY_SEC). */
export async function GET() {
  return Response.json(await getReplays());
}
