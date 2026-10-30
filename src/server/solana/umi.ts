// Server-side Umi + keys. Not marked "server-only" because the worker (plain tsx) imports it
// through actions.ts; it is never imported by client components.
import { createHmac } from "node:crypto";
import { mplCore } from "@metaplex-foundation/mpl-core";
import { mplToolbox } from "@metaplex-foundation/mpl-toolbox";
import {
  createSignerFromKeypair,
  publicKey,
  signerIdentity,
  type KeypairSigner,
  type PublicKey,
  type Umi,
} from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { base58 } from "@metaplex-foundation/umi/serializers";
import { env, requireEnv } from "@/lib/env";
import { z } from "zod";

const g = globalThis as unknown as {
  __wbgUmi?: Umi;
  __wbgAuthorityUmi?: Umi;
  __wbgRentMin?: bigint;
};

/** Read/build context. Payers and authorities are always passed explicitly. */
export function getUmi(): Umi {
  g.__wbgUmi ??= createUmi(env().SOLANA_RPC_URL, "confirmed").use(mplCore()).use(mplToolbox());
  return g.__wbgUmi;
}

function signerFromSecret(umi: Umi, secret: string, name: string): KeypairSigner {
  let bytes: Uint8Array;
  try {
    bytes = base58.serialize(secret);
  } catch {
    throw new Error(`${name} is not valid base58`);
  }
  if (bytes.length !== 64) throw new Error(`${name} must be a 64-byte secret key (base58)`);
  return createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(bytes));
}

/** Collection update authority: gates every mint and pays collection rent. */
export function getMintAuthority(): KeypairSigner {
  const { MINT_AUTHORITY_SECRET } = requireEnv("MINT_AUTHORITY_SECRET");
  return signerFromSecret(getUmi(), MINT_AUTHORITY_SECRET, "MINT_AUTHORITY_SECRET");
}

/** TransferDelegate / FreezeDelegate authority for escrowless listings. */
export function getMarketDelegate(): KeypairSigner {
  const { MARKET_DELEGATE_SECRET } = requireEnv("MARKET_DELEGATE_SECRET");
  return signerFromSecret(getUmi(), MARKET_DELEGATE_SECRET, "MARKET_DELEGATE_SECRET");
}

export function getTreasury(): PublicKey {
  const { TREASURY_PUBKEY } = requireEnv("TREASURY_PUBKEY");
  return publicKey(TREASURY_PUBKEY);
}

/** Treasury signer: used only by the payout script. */
export function getTreasurySigner(): KeypairSigner {
  const { TREASURY_SECRET } = requireEnv("TREASURY_SECRET");
  const s = signerFromSecret(getUmi(), TREASURY_SECRET, "TREASURY_SECRET");
  if (s.publicKey !== getTreasury()) throw new Error("TREASURY_SECRET does not match TREASURY_PUBKEY");
  return s;
}

/** Umi whose identity + payer is the mint authority (collection creation / royalty updates). */
export function getAuthorityUmi(): Umi {
  if (!g.__wbgAuthorityUmi) {
    const umi = createUmi(env().SOLANA_RPC_URL, "confirmed").use(mplCore()).use(mplToolbox());
    const { MINT_AUTHORITY_SECRET } = requireEnv("MINT_AUTHORITY_SECRET");
    umi.use(signerIdentity(signerFromSecret(umi, MINT_AUTHORITY_SECRET, "MINT_AUTHORITY_SECRET")));
    g.__wbgAuthorityUmi = umi;
  }
  return g.__wbgAuthorityUmi;
}

function hmacSeed(label: string): Uint8Array {
  const { ASSET_SEED_SECRET } = requireEnv("ASSET_SEED_SECRET");
  return createHmac("sha256", ASSET_SEED_SECRET).update(label).digest();
}

/** Deterministic asset keypair per mint action: nothing secret to store between build and submit. */
export function assetSignerFor(actionId: string): KeypairSigner {
  const umi = getUmi();
  return createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSeed(hmacSeed(actionId)));
}

/** Deterministic collection keypair per brain: creation is idempotent and race-safe. */
export function collectionSignerFor(brainId: string): KeypairSigner {
  const umi = getUmi();
  return createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSeed(hmacSeed(`collection:${brainId}`)));
}

const blockHeightResponse = z.union([
  z.object({ result: z.number().int() }),
  z.object({ error: z.object({ message: z.string() }) }),
]);

/** Current confirmed block height (Umi's RPC interface lacks getBlockHeight). */
export async function getBlockHeight(): Promise<number> {
  const res = await fetch(env().SOLANA_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBlockHeight", params: [{ commitment: "confirmed" }] }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`RPC getBlockHeight HTTP ${res.status}`);
  const body = blockHeightResponse.parse(await res.json());
  if ("error" in body) throw new Error(`RPC getBlockHeight: ${body.error.message}`);
  return body.result;
}

/** Minimum balance for a 0-byte system account (≈890,880 lamports). */
export async function rentExemptMinimum(): Promise<bigint> {
  g.__wbgRentMin ??= (await getUmi().rpc.getRent(0, { includesHeaderBytes: true })).basisPoints;
  return g.__wbgRentMin;
}

export function explorerTx(signature: string): string {
  const c = env().SOLANA_CLUSTER;
  return `https://explorer.solana.com/tx/${signature}${c === "mainnet-beta" ? "" : `?cluster=${c}`}`;
}

export function explorerAddress(address: string): string {
  const c = env().SOLANA_CLUSTER;
  return `https://explorer.solana.com/address/${address}${c === "mainnet-beta" ? "" : `?cluster=${c}`}`;
}

export function isValidAddress(a: unknown): a is string {
  if (typeof a !== "string" || a.length < 32 || a.length > 44) return false;
  try {
    return base58.serialize(a).length === 32;
  } catch {
    return false;
  }
}

export const signatureToString = (sig: Uint8Array) => base58.deserialize(sig)[0];
