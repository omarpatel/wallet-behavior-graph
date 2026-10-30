/**
 * Custodial key vault for agent wallets. Each agent gets a fresh ed25519 keypair; the 64-byte secret is sealed with
 * AES-256-GCM under AGENT_MASTER_KEY (32 bytes, base64 or hex, in .env.local; `pnpm keygen` adds it) and stored as
 * base64(iv[12] | tag[16] | ciphertext[64]) in agents.enc_secret. The agent id is bound as additional authenticated
 * data, so a sealed secret copied onto another agent row fails to open.
 *
 * Rules: secrets are opened only by the signing paths (execute.ts, funds.ts); a Keypair never leaves the function
 * that signs with it, is never logged and never returned by any API.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { requireEnv } from "@/lib/env";

const IV_LEN = 12;
const TAG_LEN = 16;
const SECRET_LEN = 64;

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

/** Parse a 32-byte key given as 64 hex chars or base64/base64url. */
export function parseMasterKey(raw: string): Buffer {
  const s = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, "hex") : Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.length !== 32) throw new VaultError("AGENT_MASTER_KEY must be exactly 32 bytes (64 hex chars or base64)");
  return key;
}

function masterKey(): Buffer {
  return parseMasterKey(requireEnv("AGENT_MASTER_KEY").AGENT_MASTER_KEY);
}

export function sealSecret(secret: Uint8Array, agentId: string, key: Buffer = masterKey()): string {
  if (secret.length !== SECRET_LEN) throw new VaultError(`secret must be ${SECRET_LEN} bytes`);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(agentId, "utf8"));
  const ct = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function openSecret(sealed: string, agentId: string, key: Buffer = masterKey()): Uint8Array {
  const buf = Buffer.from(sealed, "base64");
  if (buf.length !== IV_LEN + TAG_LEN + SECRET_LEN) throw new VaultError("sealed secret has the wrong length");
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, IV_LEN));
  decipher.setAAD(Buffer.from(agentId, "utf8"));
  decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
  try {
    return new Uint8Array(Buffer.concat([decipher.update(buf.subarray(IV_LEN + TAG_LEN)), decipher.final()]));
  } catch {
    throw new VaultError("sealed secret failed authentication (wrong AGENT_MASTER_KEY, wrong agent, or tampered)");
  }
}

/** New agent wallet: returns the public key and the sealed secret only. */
export function createAgentWallet(agentId: string, key?: Buffer): { pubkey: string; encSecret: string } {
  const kp = Keypair.generate();
  const secret = kp.secretKey; // a copy; sealed, then zeroed
  const encSecret = sealSecret(secret, agentId, key);
  secret.fill(0);
  return { pubkey: kp.publicKey.toBase58(), encSecret };
}

/**
 * Run `fn` with the agent's signer. The keypair is checked against the stored pubkey and its secret bytes are zeroed
 * when `fn` settles. Never store or return the Keypair from `fn`.
 */
export async function withAgentSigner<T>(
  agent: { id: string; encSecret: string; walletPubkey: string },
  fn: (signer: Keypair) => Promise<T>,
): Promise<T> {
  const secret = openSecret(agent.encSecret, agent.id);
  // Keypair keeps `secret` itself (no copy) and its `secretKey` getter returns copies: zero `secret` after `fn` signed
  const signer = Keypair.fromSecretKey(secret);
  try {
    if (signer.publicKey.toBase58() !== agent.walletPubkey) throw new VaultError("sealed secret does not match the agent wallet");
    return await fn(signer);
  } finally {
    secret.fill(0);
  }
}
