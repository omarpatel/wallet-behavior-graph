import { getSession } from "@/server/auth/session";

/** `{ wallet, isAdmin }` or `null`. */
export async function GET() {
  return Response.json(await getSession(), { headers: { "cache-control": "no-store" } });
}
