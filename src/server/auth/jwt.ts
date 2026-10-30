// Session JWT (HS256, jose). No next/* imports so scripts and tests can mint tokens.
import { jwtVerify, SignJWT } from "jose";
import { env, requireEnv } from "@/lib/env";

export const SESSION_COOKIE = "wbg_session";
export const SESSION_MAX_AGE_SEC = 30 * 24 * 3600;

const key = () => new TextEncoder().encode(requireEnv("SESSION_SECRET").SESSION_SECRET);

export async function createSessionToken(wallet: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(wallet)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SEC}s`)
    .sign(key());
}

export async function verifySessionToken(token: string): Promise<{ wallet: string } | null> {
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    return payload.sub ? { wallet: payload.sub } : null;
  } catch {
    return null;
  }
}

export const isAdminWallet = (wallet: string) => env().ADMIN_WALLETS.includes(wallet);

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env().PUBLIC_URL.startsWith("https://"),
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  };
}
