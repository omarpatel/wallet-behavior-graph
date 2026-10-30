// Sign-In With Solana. Nonces are single-use, 5 minutes, stored in auth_nonces.
import { randomBytes } from "node:crypto";
import * as ed from "@noble/ed25519";
import type { SolanaSignInInput, SolanaSignInOutput } from "@solana/wallet-standard-features";
import { createSignInMessageText, verifySignIn } from "@solana/wallet-standard-util";
import bs58 from "bs58";
import { eq, lt } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { env } from "@/lib/env";
import { HttpError } from "./http";

const NONCE_TTL_SEC = 300;
const { authNonces, users } = schema;

export const siwsChainId = () => (env().SOLANA_CLUSTER === "mainnet-beta" ? "solana:mainnet" : "solana:devnet");

/** Builds and stores a fresh SIWS input for the requesting origin. */
export async function createSignInInput(requestUrl: URL): Promise<SolanaSignInInput> {
  const now = Date.now();
  const input: SolanaSignInInput = {
    domain: requestUrl.host,
    uri: requestUrl.origin,
    version: "1",
    statement: "Sign in to Wallet Behavior Graph. This does not send a transaction or cost fees.",
    chainId: siwsChainId(),
    nonce: randomBytes(16).toString("hex"),
    issuedAt: new Date(now).toISOString(),
    expirationTime: new Date(now + NONCE_TTL_SEC * 1000).toISOString(),
  };
  const db = getDb();
  await db.delete(authNonces).where(lt(authNonces.expiresAt, Math.floor(now / 1000)));
  await db.insert(authNonces).values({
    nonce: input.nonce!,
    inputJson: JSON.stringify(input),
    expiresAt: Math.floor(now / 1000) + NONCE_TTL_SEC,
  });
  return input;
}

const b64 = (v: unknown, field: string): Uint8Array => {
  if (typeof v !== "string" || !v) throw new HttpError(400, `${field} required (base64)`);
  return new Uint8Array(Buffer.from(v, "base64"));
};

/**
 * Verifies a SIWS response and returns the wallet address.
 * Body (signIn): `{ nonce, address, signedMessage, signature }` (base64 bytes).
 * Body (signMessage fallback): `{ nonce, address, signature, mode: "signMessage" }` where the wallet signed
 * `createSignInMessageText({ ...input, address })`.
 */
export async function verifySiws(body: Record<string, unknown>): Promise<string> {
  const { nonce, address, mode } = body;
  if (typeof nonce !== "string" || typeof address !== "string") throw new HttpError(400, "nonce and address required");
  const [row] = await getDb().delete(authNonces).where(eq(authNonces.nonce, nonce)).returning();
  if (!row) throw new HttpError(401, "Unknown or already used sign-in nonce");
  const input = JSON.parse(row.inputJson) as SolanaSignInInput;
  if (Date.parse(input.expirationTime!) < Date.now()) throw new HttpError(401, "Sign-in request expired");

  let pk: Uint8Array;
  try {
    pk = bs58.decode(address);
  } catch {
    throw new HttpError(400, "Invalid address");
  }
  if (pk.length !== 32) throw new HttpError(400, "Invalid address");
  const signature = b64(body.signature, "signature");

  let ok: boolean;
  if (mode === "signMessage") {
    const text = createSignInMessageText({ ...input, domain: input.domain!, address });
    ok = await ed.verifyAsync(signature, new TextEncoder().encode(text), pk);
  } else {
    const output = {
      account: { address, publicKey: pk, chains: [], features: [] },
      signedMessage: b64(body.signedMessage, "signedMessage"),
      signature,
    } as unknown as SolanaSignInOutput;
    ok = verifySignIn(input, output);
  }
  if (!ok) throw new HttpError(401, "Signature verification failed");

  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(users)
    .values({ wallet: address, lastSeenAt: now })
    .onConflictDoUpdate({ target: users.wallet, set: { lastSeenAt: now } });
  return address;
}
