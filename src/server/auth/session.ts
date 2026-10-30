import "server-only";
import { cookies } from "next/headers";
import { isAdminWallet, SESSION_COOKIE, verifySessionToken } from "./jwt";

export interface Session {
  wallet: string;
  isAdmin: boolean;
}

/** Current SIWS session from the httpOnly cookie, or null. */
export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const s = await verifySessionToken(token);
  return s ? { wallet: s.wallet, isAdmin: isAdminWallet(s.wallet) } : null;
}

/** Like getSession but throws a 401 JSON `Response` when signed out. */
export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) throw Response.json({ error: "Sign in with your wallet first" }, { status: 401 });
  return s;
}
