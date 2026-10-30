// Generates server keys/secrets into .env.local (never overwrites existing values) and funds the devnet
// mint authority (+ treasury rent) via airdrop. Re-runnable: only tops up when balances are low.
//   pnpm keygen
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

const ENV_PATH = ".env.local";
const DEVNET_RPCS = ["https://api.devnet.solana.com", "https://rpc.ankr.com/solana_devnet", "https://devnet.sonic.game"];

function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out.set(m[1], m[2].replace(/^["']|["']$/g, ""));
  }
  return out;
}

const original = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
const current = parseEnv(original);
const additions: [string, string][] = [];
const has = (k: string) => (current.get(k) ?? "") !== "";
const add = (k: string, v: string) => {
  if (has(k)) return;
  current.set(k, v);
  additions.push([k, v]);
};

function keypairVars(label: string) {
  const secretKey = `${label}_SECRET`;
  if (has(secretKey)) {
    const kp = Keypair.fromSecretKey(bs58.decode(current.get(secretKey)!));
    add(`${label}_PUBKEY`, kp.publicKey.toBase58());
    return;
  }
  const kp = Keypair.generate();
  add(secretKey, bs58.encode(kp.secretKey));
  add(`${label}_PUBKEY`, kp.publicKey.toBase58());
}

keypairVars("MINT_AUTHORITY");
keypairVars("MARKET_DELEGATE");
keypairVars("TREASURY");
add("ASSET_SEED_SECRET", randomBytes(32).toString("hex"));
add("SESSION_SECRET", randomBytes(48).toString("base64url"));
add("HELIUS_WEBHOOK_AUTH", randomBytes(32).toString("base64url"));
// Seals custodial agent wallet secrets (src/server/agents/vault.ts). Never rotate in place: existing agents
// would become unopenable. Back it up with the database.
add("AGENT_MASTER_KEY", randomBytes(32).toString("base64"));
add("SOLANA_CLUSTER", "devnet");
add("SOLANA_RPC_URL", "https://api.devnet.solana.com");
add("NEXT_PUBLIC_SOLANA_CLUSTER", "devnet");
add("NEXT_PUBLIC_SOLANA_RPC_URL", "https://api.devnet.solana.com");

if (additions.length) {
  const block = [
    original && !original.endsWith("\n") ? "\n" : "",
    `\n# --- added by scripts/keygen.ts (${new Date().toISOString()}) ---\n`,
    ...additions.map(([k, v]) => `${k}=${v}\n`),
  ].join("");
  writeFileSync(ENV_PATH, original + block);
  console.log(`Added to ${ENV_PATH}: ${additions.map(([k]) => k).join(", ")}`);
} else {
  console.log(`${ENV_PATH} already has every key; nothing written.`);
}

// ---------------------------------------------------------------- devnet funding

if (current.get("SOLANA_CLUSTER") !== "devnet") {
  console.log("SOLANA_CLUSTER is not devnet; skipping airdrops.");
  process.exit(0);
}

const mintAuthority = Keypair.fromSecretKey(bs58.decode(current.get("MINT_AUTHORITY_SECRET")!));
const treasury = new PublicKey(current.get("TREASURY_PUBKEY")!);
const primaryRpc = current.get("SOLANA_RPC_URL")!;
const conn = new Connection(primaryRpc, "confirmed");
const TARGET = 2 * LAMPORTS_PER_SOL;

async function airdrop(to: PublicKey, lamports: number): Promise<boolean> {
  const rpcs = [primaryRpc, ...DEVNET_RPCS.filter((u) => u !== primaryRpc)];
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const url of rpcs) {
      try {
        const c = new Connection(url, "confirmed");
        const sig = await c.requestAirdrop(to, lamports);
        const bh = await c.getLatestBlockhash();
        await c.confirmTransaction({ signature: sig, ...bh }, "confirmed");
        console.log(`  airdrop ${lamports / LAMPORTS_PER_SOL} SOL via ${url}: ${sig}`);
        return true;
      } catch (e) {
        console.warn(`  airdrop via ${url} failed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
      }
    }
    const wait = 5_000 * 2 ** attempt;
    console.warn(`  retrying in ${wait / 1000}s…`);
    await sleep(wait);
  }
  return false;
}

const balance = await conn.getBalance(mintAuthority.publicKey);
console.log(`Mint authority ${mintAuthority.publicKey.toBase58()} balance: ${balance / LAMPORTS_PER_SOL} SOL`);
if (balance < TARGET / 2) {
  await airdrop(mintAuthority.publicKey, TARGET);
  if ((await conn.getBalance(mintAuthority.publicKey)) === 0) {
    console.warn(
      `\nCould not airdrop (devnet faucets are rate-limited). Fund the mint authority manually:\n` +
        `  1. Open https://faucet.solana.com (sign in with GitHub for a higher limit)\n` +
        `  2. Paste ${mintAuthority.publicKey.toBase58()} and request 2–5 SOL on devnet\n` +
        `  3. Re-run \`pnpm keygen\` to fund the treasury rent from it.\n`,
    );
    process.exit(0);
  }
}

// Treasury must exist (rent-exempt) so small fee transfers into it never fail.
const treasuryBalance = await conn.getBalance(treasury);
const rentMin = await conn.getMinimumBalanceForRentExemption(0);
if (treasuryBalance < rentMin) {
  const sig = await sendAndConfirmTransaction(
    conn,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: mintAuthority.publicKey, toPubkey: treasury, lamports: rentMin * 2 })),
    [mintAuthority],
  );
  console.log(`Funded treasury ${treasury.toBase58()} with ${(rentMin * 2) / LAMPORTS_PER_SOL} SOL: ${sig}`);
}
console.log(`Mint authority balance now ${(await conn.getBalance(mintAuthority.publicKey)) / LAMPORTS_PER_SOL} SOL`);
