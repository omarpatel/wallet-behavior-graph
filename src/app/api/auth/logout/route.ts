import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/server/auth/jwt";

export async function POST() {
  (await cookies()).delete(SESSION_COOKIE);
  return Response.json(null);
}
