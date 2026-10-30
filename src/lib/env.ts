import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const schema = z.object({
  DATABASE_URL: z.string().default("file:./data/wbg.db"),
  DATABASE_AUTH_TOKEN: optional,

  // --- on-chain data (mainnet) ---
  HELIUS_API_KEY: optional,
  /** Mainnet RPC used for wallet history when no Helius key is set. */
  DATA_RPC_URL: z.string().default("https://api.mainnet-beta.solana.com"),
  /** Shared secret Helius sends back in the Authorization header of webhook POSTs. */
  HELIUS_WEBHOOK_AUTH: optional,
  JUPITER_API_KEY: optional,
  /** Max transactions to pull per wallet on first backfill. */
  BACKFILL_MAX_TXS: z.coerce.number().int().positive().default(1500),
  /** Parallel backfills in the worker. */
  BACKFILL_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(3),
  /** Brains in the live tier (Helius webhook); the rest are reconciled every 6 h. */
  LIVE_TRACKED_MAX: z.coerce.number().int().min(0).default(80),

  // --- seats / NFTs ---
  SOLANA_CLUSTER: z.enum(["devnet", "mainnet-beta"]).default("devnet"),
  SOLANA_RPC_URL: z.string().default("https://api.devnet.solana.com"),
  MINT_AUTHORITY_SECRET: optional, // base58 64-byte secret; collection update authority
  MARKET_DELEGATE_SECRET: optional, // base58; TransferDelegate/FreezeDelegate authority
  TREASURY_PUBKEY: optional,
  TREASURY_SECRET: optional, // only needed by the payout script
  ASSET_SEED_SECRET: optional, // HMAC key deriving per-action asset keypairs
  MARKET_FEE_BPS: z.coerce.number().int().min(0).max(1000).default(250),

  // --- app ---
  PUBLIC_URL: z.string().default("http://localhost:3000"),
  SESSION_SECRET: optional,
  /** Brain pfp cache directory (src/server/avatars); relative paths resolve against the working directory. */
  AVATARS_DIR: z.string().default("data/avatars"),
  ADMIN_WALLETS: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((w) => w.trim()).filter(Boolean)),
  /** ISO-3166 alpha-2. UK: FCA financial-promotion regime; others: OFAC comprehensive sanctions. */
  BLOCKED_COUNTRIES: z
    .string()
    .default("GB,CU,IR,KP,SY")
    .transform((s) => s.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean)),

  // --- AI (Anthropic first; OpenAI takes over while Anthropic is out of credits / unreachable) ---
  ANTHROPIC_API_KEY: optional,
  AI_MODEL_FAST: z.string().default("claude-haiku-5-5"),
  AI_MODEL_SMART: z.string().default("claude-sonnet-5-5"),
  OPENAI_API_KEY: optional,
  AI_OPENAI_MODEL_FAST: z.string().default("gpt-5.4-mini"),
  AI_OPENAI_MODEL_SMART: z.string().default("gpt-5.5"),
  /**
   * Hourly cap on alert-explanation model calls; live-tier, larger and swarm alerts go first. At ~9k alerts/day,
   * 60/h ≈ $4/day on gpt-5.4-mini (estimate: ~1.5k input + ~400 output/reasoning tokens per call).
   */
  AI_MAX_EXPLANATIONS_PER_HOUR: z.coerce.number().int().min(0).default(60),
  /** A brain's playbook (smart model, ~$0.05–0.10 each) is rewritten at most this often after its profile changes. */
  PLAYBOOK_REFRESH_DAYS: z.coerce.number().min(0).default(7),

  // --- brain agents (custodial, mainnet; src/server/agents) ---
  /** 32 bytes (64 hex or base64) sealing agent wallet secrets with AES-256-GCM. `pnpm keygen` generates it. */
  AGENT_MASTER_KEY: optional,
  /** Global kill switch: false = the agents runner places no orders at all (marks, deposits, withdrawals still work). */
  AGENTS_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  /** Live (real-funds) trading: off unless explicitly "true". Paper agents are unaffected. */
  AGENTS_LIVE_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  /** Net deposits above this per agent are flagged and halt the agent (a transfer can't be refused). */
  AGENT_MAX_DEPOSIT_SOL: z.coerce.number().positive().max(1_000).default(5),
  /** LLM judge calls per agent per hour; over budget the agent decides on the deterministic rules alone. */
  AGENT_LLM_CALLS_PER_HOUR: z.coerce.number().int().min(0).default(20),
  /** Mainnet RPC for agent wallets (balances, sends). Default: Helius mainnet when HELIUS_API_KEY is set, else DATA_RPC_URL. */
  AGENT_RPC_URL: optional,
  /** Jupiter Swap API base (quote + swap). Default: https://api.jup.ag/swap/v1 with JUPITER_API_KEY, else https://lite-api.jup.ag/swap/v1 (keyless, ~5 req/10 s per IP). */
  JUPITER_SWAP_API: optional,
  /** PumpPortal data websocket (keyless: new tokens + migrations). */
  PUMPPORTAL_WS_URL: z.string().default("wss://pumpportal.fun/api/data"),

  // --- Brain Picks (src/server/picks): style-matched tokens for seat holders, paper-tracked; never places orders ---
  /** Generate picks inside the agents runner. false = no new picks (open picks keep being tracked and closed). */
  PICKS_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  /** New picks per brain per rolling hour. */
  PICKS_MAX_PER_BRAIN_HOUR: z.coerce.number().int().min(1).max(60).default(6),
  /** LLM one-liner calls per hour across all brains' picks (0 = rules only; the judge can also veto a pick). */
  PICKS_LLM_CALLS_PER_HOUR: z.coerce.number().int().min(0).default(30),

  // --- X (claimed brains only) ---
  X_BEARER_TOKEN: optional,
  X_CLIENT_ID: optional,
  X_CLIENT_SECRET: optional,
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}

/** Throws a clear error naming the missing variable(s) for a feature. */
export function requireEnv<K extends keyof Env>(...keys: K[]): { [P in K]: NonNullable<Env[P]> } {
  const e = env();
  const missing = keys.filter((k) => e[k] === undefined || e[k] === "");
  if (missing.length) {
    throw new MissingConfigError(missing as string[]);
  }
  return Object.fromEntries(keys.map((k) => [k, e[k]])) as { [P in K]: NonNullable<Env[P]> };
}

export class MissingConfigError extends Error {
  constructor(public readonly keys: string[]) {
    super(`Missing configuration: ${keys.join(", ")}. See README "Configuration".`);
    this.name = "MissingConfigError";
  }
}
