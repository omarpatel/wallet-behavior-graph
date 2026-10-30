import { cookies } from "next/headers";
import { HttpError, readJson, withApi } from "@/server/auth/http";
import { createSessionToken, isAdminWallet, SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/jwt";
import { createSignInInput, verifySiws } from "@/server/auth/siws";

/**
 * The origin the user's browser is on. Behind a proxy/tunnel `req.url` is the upstream (localhost:3000), and the
 * wallet compares the SIWS `domain` with the page origin, so prefer the forwarded host/proto.
 */
function browserOrigin(req: Request): URL {
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim() ?? url.protocol.slice(0, -1);
  return new URL(`${proto}://${host}`);
}

/** SIWS input for `wallet.signIn(input)` (or `createSignInMessageText` for the signMessage fallback). */
export const GET = withApi(async (req: Request) => {
  return Response.json(await createSignInInput(browserOrigin(req)), { headers: { "cache-control": "no-store" } });
});

/** Verifies the signed SIWS message and sets the httpOnly session cookie. */
export const POST = withApi(async (req: Request) => {
  const body = await readJson(req);
  if (!body.nonce) throw new HttpError(400, "nonce required");
  const wallet = await verifySiws(body);
  const token = await createSessionToken(wallet);
  (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions());
  return Response.json({ wallet, isAdmin: isAdminWallet(wallet) });
});
