import { createHash, randomBytes } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { getDb } from "@/db/client";
import { brains, oauthStates } from "@/db/schema";
import { env, requireEnv } from "@/lib/env";
import { X_API, xGet } from "./api";

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = `${X_API}/oauth2/token`;
const SCOPES = "tweet.read users.read offline.access";
const STATE_TTL_SEC = 600;

/** A link attempt that can't proceed; `status` is the HTTP status the route should use. */
export class XLinkError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly brainId: string | null = null,
  ) {
    super(message);
    this.name = "XLinkError";
  }
}

export function xRedirectUri(): string {
  return new URL("/api/claim/x/callback", env().PUBLIC_URL).toString();
}

/** Only the KOL who claimed the brain (signed in with the brain wallet) may link X. */
async function assertClaimedBy(brainId: string, wallet: string) {
  const [brain] = await getDb()
    .select({ wallet: brains.wallet, status: brains.status })
    .from(brains)
    .where(eq(brains.id, brainId))
    .limit(1);
  if (!brain) throw new XLinkError(404, "Brain not found", brainId);
  if (brain.status !== "claimed") throw new XLinkError(403, "Claim this brain with its wallet before linking X", brainId);
  if (brain.wallet !== wallet) throw new XLinkError(403, "Only the KOL who claimed this brain can link X", brainId);
}

/** Create PKCE (S256) + state and return the X authorize URL. */
export async function startXLink(input: { brainId: string; wallet: string }): Promise<string> {
  const { X_CLIENT_ID } = requireEnv("X_CLIENT_ID");
  await assertClaimedBy(input.brainId, input.wallet);

  const state = randomBytes(24).toString("base64url");
  const codeVerifier = randomBytes(48).toString("base64url"); // 64 chars, within 43–128
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const now = Math.floor(Date.now() / 1000);

  const db = getDb();
  await db.delete(oauthStates).where(lt(oauthStates.expiresAt, now));
  await db.insert(oauthStates).values({
    state,
    codeVerifier,
    wallet: input.wallet,
    brainId: input.brainId,
    expiresAt: now + STATE_TTL_SEC,
  });

  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: X_CLIENT_ID,
    redirect_uri: xRedirectUri(),
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/** Look up and consume the state row; it is single-use whatever the outcome. */
export async function consumeXState(state: string) {
  const db = getDb();
  const [row] = await db.select().from(oauthStates).where(eq(oauthStates.state, state)).limit(1);
  if (!row) throw new XLinkError(400, "Unknown or already used X link request; start again");
  await db.delete(oauthStates).where(eq(oauthStates.state, state));
  if (row.expiresAt < Math.floor(Date.now() / 1000)) {
    throw new XLinkError(400, "X link request expired; start again", row.brainId);
  }
  return row;
}

/**
 * Exchange the authorization code (confidential client: HTTP Basic client auth), read the
 * authenticated user via GET /2/users/me and store xUserId + xHandle on the claimed brain.
 */
export async function completeXLink(input: {
  state: string;
  code: string;
  wallet: string;
}): Promise<{ brainId: string; xUserId: string; username: string }> {
  const { X_CLIENT_ID, X_CLIENT_SECRET } = requireEnv("X_CLIENT_ID", "X_CLIENT_SECRET");
  const st = await consumeXState(input.state);
  if (st.wallet !== input.wallet) throw new XLinkError(403, "This X link was started by a different wallet", st.brainId);
  await assertClaimedBy(st.brainId, input.wallet);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: xRedirectUri(),
      code_verifier: st.codeVerifier,
      client_id: X_CLIENT_ID,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new XLinkError(502, `X token exchange failed (${res.status}): ${body.slice(0, 200)}`, st.brainId);
  }
  const token = (await res.json()) as { access_token?: string };
  if (!token.access_token) throw new XLinkError(502, "X token exchange returned no access token", st.brainId);

  const me = await xGet<{ data?: { id: string; username: string } }>("/users/me", token.access_token);
  if (!me.data) throw new XLinkError(502, "X /2/users/me returned no user", st.brainId);

  await getDb()
    .update(brains)
    .set({ xUserId: me.data.id, xHandle: me.data.username })
    .where(eq(brains.id, st.brainId));
  return { brainId: st.brainId, xUserId: me.data.id, username: me.data.username };
}
