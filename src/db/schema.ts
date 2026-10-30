import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch())`;

/** Where the wallet → person attribution comes from. Drives what the UI may show. */
export type Provenance =
  | "self_verified" // KOL signed in with the wallet (claim)
  | "platform_attributed" // listed with a public label by the wallet directory (data/directory)
  | "community_attributed" // circulated publicly, not confirmed
  | "unattributed"; // any wallet, no person attached

export type BrainTier = "S" | "A" | "B" | "C" | "unrated";

export const brains = sqliteTable(
  "brains",
  {
    id: text("id").primaryKey(), // url slug
    wallet: text("wallet").notNull().unique(),
    codename: text("codename").notNull().unique(), // neutral deterministic name, unique (src/lib/codename.ts); always safe to show
    displayName: text("display_name"), // attributed name (shown with provenance label)
    xHandle: text("x_handle"),
    provenance: text("provenance").$type<Provenance>().notNull().default("unattributed"),
    provenanceSource: text("provenance_source"), // evidence URL
    status: text("status").$type<"unclaimed" | "claimed">().notNull().default("unclaimed"),
    claimedAt: integer("claimed_at"),
    kolPayoutWallet: text("kol_payout_wallet"),
    xUserId: text("x_user_id"), // set only after X OAuth on a claimed brain
    avatarUrl: text("avatar_url"), // claimed brains only (KOL-provided)
    bio: text("bio"),

    // public identity from KOL directories (src/server/directory); shown with source labels
    publicAvatarUrl: text("public_avatar_url"), // pfp published by the wallet directory
    telegram: text("telegram"),
    followers: integer("followers"),
    /** DirectorySource[] — every directory that lists this wallet, with its own name/handle/url/rank. */
    sourcesJson: text("sources_json").notNull().default("[]"),
    /** ExternalStats — the directory's leaderboard stats + early-entry study record (src/server/directory/types.ts). */
    externalStatsJson: text("external_stats_json").notNull().default("{}"),
    /** live = in the Helius webhook (real-time alerts); standard = reconciled periodically. */
    tracking: text("tracking").$type<"live" | "standard">().notNull().default("standard"),
    lastReconciledAt: integer("last_reconciled_at"),

    // seat economics (lamports)
    seatSupply: integer("seat_supply").notNull().default(100),
    seatPriceLamports: integer("seat_price_lamports").notNull().default(500_000_000),
    renewalPriceLamports: integer("renewal_price_lamports").notNull().default(150_000_000),
    termDays: integer("term_days").notNull().default(30),
    kolShareBps: integer("kol_share_bps").notNull().default(3000),
    royaltyBps: integer("royalty_bps").notNull().default(500),
    priceOverride: integer("price_override", { mode: "boolean" }).notNull().default(false),
    collectionAddress: text("collection_address"),

    // profile
    tier: text("tier").$type<BrainTier>().notNull().default("unrated"),
    trackScore: real("track_score"),
    profileJson: text("profile_json"), // BrainProfile (src/server/profile/types.ts)
    profileVersion: integer("profile_version").notNull().default(0),
    profileUpdatedAt: integer("profile_updated_at"),
    playbookMd: text("playbook_md"),
    playbookProfileVersion: integer("playbook_profile_version"),
    playbookUpdatedAt: integer("playbook_updated_at"), // unix s; refreshes are rate-limited (PLAYBOOK_REFRESH_DAYS)

    // anti-scalping (claimed KOLs)
    alertDelaySec: integer("alert_delay_sec").notNull().default(0),
    revenueHeld: integer("revenue_held", { mode: "boolean" }).notNull().default(false),
    revenueHeldReason: text("revenue_held_reason"),

    // ingestion state
    backfillStatus: text("backfill_status")
      .$type<"pending" | "running" | "done" | "error">()
      .notNull()
      .default("pending"),
    backfillError: text("backfill_error"),
    /** Consecutive failed backfills; an errored backfill is retried after 15 min × attempts, up to 5 attempts. */
    backfillAttempts: integer("backfill_attempts").notNull().default(0),
    /** Unix s after which an errored backfill is retried (null = immediately). */
    backfillRetryAt: integer("backfill_retry_at"),
    lastSignature: text("last_signature"), // newest ingested signature (live cursor)
    lastSlot: integer("last_slot"),
    listed: integer("listed", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("brains_tier_idx").on(t.tier)],
);

export const tokens = sqliteTable("tokens", {
  mint: text("mint").primaryKey(),
  symbol: text("symbol"),
  name: text("name"),
  icon: text("icon"),
  decimals: integer("decimals"),
  totalSupply: real("total_supply"),
  launchpad: text("launchpad"), // e.g. "pump.fun"
  createdAtTs: integer("created_at_ts"), // token creation (unix s)
  firstPoolCreatedAt: integer("first_pool_created_at"),
  dev: text("dev"),
  liquidityUsd: real("liquidity_usd"),
  mcapUsd: real("mcap_usd"),
  usdPrice: real("usd_price"),
  holderCount: integer("holder_count"),
  organicScore: real("organic_score"),
  topHoldersPct: real("top_holders_pct"),
  mintAuthorityDisabled: integer("mint_authority_disabled", { mode: "boolean" }),
  freezeAuthorityDisabled: integer("freeze_authority_disabled", { mode: "boolean" }),
  // RugCheck summary (api.rugcheck.xyz, keyless), refreshed ≤ every 6 h
  rugScore: integer("rug_score"), // normalised 0–100 risk (higher = riskier)
  lpLockedPct: real("lp_locked_pct"),
  rugRisksJson: text("rug_risks_json"), // [{name, level, description}]
  rugCheckedAt: integer("rug_checked_at"),
  source: text("source"), // jupiter | dexscreener | das
  updatedAt: integer("updated_at").notNull().default(now),
});

export const trades = sqliteTable(
  "trades",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    brainId: text("brain_id")
      .notNull()
      .references(() => brains.id, { onDelete: "cascade" }),
    wallet: text("wallet").notNull(),
    signature: text("signature").notNull(),
    slot: integer("slot").notNull(),
    txIndex: integer("tx_index").notNull().default(0),
    blockTime: integer("block_time").notNull(), // unix s
    side: text("side").$type<"buy" | "sell">().notNull(),
    mint: text("mint").notNull(),
    tokenAmount: real("token_amount").notNull(), // UI units
    quoteMint: text("quote_mint").notNull(), // SOL | USDC | USDT | other
    quoteAmount: real("quote_amount").notNull(), // UI units, ex network fees
    solValue: real("sol_value"), // trade value in SOL
    usdValue: real("usd_value"),
    feesSol: real("fees_sol").notNull().default(0),
    priceUsd: real("price_usd"),
    solUsd: real("sol_usd"),
    mcUsd: real("mc_usd"), // market cap at trade
    venue: text("venue"), // pump_curve | pumpswap | raydium | meteora | jupiter | orca | unknown
    launchpad: text("launchpad"),
    tokenCreatedAt: integer("token_created_at"),
    entryDelaySec: integer("entry_delay_sec"), // buys only: blockTime - tokenCreatedAt
    source: text("source").$type<"backfill" | "live">().notNull(),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("trades_dedupe").on(t.wallet, t.signature, t.mint, t.side),
    index("trades_brain_time").on(t.brainId, t.blockTime),
    index("trades_brain_mint").on(t.brainId, t.mint),
    // per-token lookups: swarm outcome windows, token replay
    index("trades_mint_time").on(t.mint, t.blockTime),
    // live firing (source = 'live' newest-first by id; rowid is the implicit last key)
    index("trades_source").on(t.source),
  ],
);

/** Non-swap token movements in/out of a tracked wallet (PnL basis, transfer-out-before-dump). */
export const tokenTransfers = sqliteTable(
  "token_transfers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    brainId: text("brain_id")
      .notNull()
      .references(() => brains.id, { onDelete: "cascade" }),
    signature: text("signature").notNull(),
    blockTime: integer("block_time").notNull(),
    mint: text("mint").notNull(),
    amount: real("amount").notNull(),
    direction: text("direction").$type<"in" | "out">().notNull(),
  },
  (t) => [uniqueIndex("transfers_dedupe").on(t.brainId, t.signature, t.mint, t.direction)],
);

export const solUsd1m = sqliteTable("sol_usd_1m", {
  minuteTs: integer("minute_ts").primaryKey(), // floor(unix s / 60) * 60
  close: real("close").notNull(),
});

/** One alert per live trade, fanned out to seat holders via SSE once publishAt passes. */
export const alerts = sqliteTable(
  "alerts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    brainId: text("brain_id")
      .notNull()
      .references(() => brains.id, { onDelete: "cascade" }),
    tradeId: integer("trade_id")
      .notNull()
      .unique()
      .references(() => trades.id, { onDelete: "cascade" }),
    headline: text("headline").notNull(), // deterministic
    factsJson: text("facts_json").notNull(), // AlertFacts (src/server/alerts/types.ts)
    explanation: text("explanation"), // LLM, filled async
    explanationModel: text("explanation_model"),
    publishAt: integer("publish_at").notNull(), // unix s; blockTime + brain.alertDelaySec
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("alerts_brain_publish").on(t.brainId, t.publishAt)],
);

/** Claimed brains only (X Developer Policy: no tweet↔wallet correlation without opt-in). */
export const tweets = sqliteTable(
  "tweets",
  {
    id: text("id").primaryKey(),
    brainId: text("brain_id")
      .notNull()
      .references(() => brains.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    mentionsJson: text("mentions_json").notNull().default("[]"), // TweetMention[]
    stance: text("stance").$type<"bullish" | "neutral" | "bearish" | "unknown">(),
    fetchedAt: integer("fetched_at").notNull().default(now),
  },
  (t) => [index("tweets_brain_time").on(t.brainId, t.createdAtMs)],
);

/** "Promote-then-sell" evidence events computed from tweets × trades. */
export const shillEvents = sqliteTable(
  "shill_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    brainId: text("brain_id")
      .notNull()
      .references(() => brains.id, { onDelete: "cascade" }),
    tweetId: text("tweet_id").notNull(),
    mint: text("mint").notNull(),
    strong: integer("strong", { mode: "boolean" }).notNull(),
    prePositionUsd: real("pre_position_usd"),
    leadTimeSec: integer("lead_time_sec"),
    entryDiscount: real("entry_discount"),
    soldFrac1h: real("sold_frac_1h"),
    soldFrac24h: real("sold_frac_24h"),
    firstSellAfterSec: integer("first_sell_after_sec"),
    evidenceJson: text("evidence_json").notNull(), // signatures etc.
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("shill_dedupe").on(t.brainId, t.tweetId, t.mint)],
);

export const users = sqliteTable("users", {
  wallet: text("wallet").primaryKey(),
  createdAt: integer("created_at").notNull().default(now),
  lastSeenAt: integer("last_seen_at"),
});

export const authNonces = sqliteTable("auth_nonces", {
  nonce: text("nonce").primaryKey(),
  inputJson: text("input_json").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const oauthStates = sqliteTable("oauth_states", {
  state: text("state").primaryKey(),
  codeVerifier: text("code_verifier").notNull(),
  wallet: text("wallet").notNull(),
  brainId: text("brain_id").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

/** Every minted seat (all mints go through our server, so this is the full set). */
export const seats = sqliteTable(
  "seats",
  {
    asset: text("asset").primaryKey(),
    brainId: text("brain_id")
      .notNull()
      .references(() => brains.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    owner: text("owner").notNull(), // last known on-chain owner
    ownerCheckedAt: integer("owner_checked_at"),
    expiresAt: integer("expires_at").notNull(), // access term end (unix s); travels with the NFT
    mintSignature: text("mint_signature"),
    mintedAt: integer("minted_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("seats_brain_number").on(t.brainId, t.number),
    index("seats_owner").on(t.owner),
  ],
);

export type ChainActionKind = "mint" | "list" | "delist" | "buy" | "renew" | "collection";

/** Server-built transactions awaiting the wallet signature (wallet-first, server co-signs). */
export const chainActions = sqliteTable(
  "chain_actions",
  {
    id: text("id").primaryKey(), // uuid; also seeds the asset keypair for mints
    kind: text("kind").$type<ChainActionKind>().notNull(),
    wallet: text("wallet").notNull(),
    brainId: text("brain_id"),
    asset: text("asset"),
    listingId: text("listing_id"),
    seatNumber: integer("seat_number"),
    payloadJson: text("payload_json").notNull().default("{}"), // amounts/splits used to build
    txBase64: text("tx_base64").notNull(),
    lastValidBlockHeight: integer("last_valid_block_height").notNull(),
    status: text("status")
      .$type<"pending" | "confirmed" | "expired" | "failed">()
      .notNull()
      .default("pending"),
    signature: text("signature"),
    error: text("error"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("actions_brain_kind_status").on(t.brainId, t.kind, t.status)],
);

export const listings = sqliteTable(
  "listings",
  {
    id: text("id").primaryKey(),
    asset: text("asset")
      .notNull()
      .references(() => seats.asset),
    brainId: text("brain_id")
      .notNull()
      .references(() => brains.id, { onDelete: "cascade" }),
    seller: text("seller").notNull(),
    priceLamports: integer("price_lamports").notNull(),
    status: text("status")
      .$type<"pending" | "active" | "sold" | "cancelled">()
      .notNull()
      .default("pending"),
    buyer: text("buyer"),
    listSignature: text("list_signature"),
    saleSignature: text("sale_signature"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [index("listings_brain_status").on(t.brainId, t.status), index("listings_asset").on(t.asset)],
);

/** Every lamport that moved through a sale/renewal, with the KOL split. */
export const ledger = sqliteTable(
  "ledger",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    brainId: text("brain_id")
      .notNull()
      .references(() => brains.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"primary" | "renewal" | "royalty" | "market_fee">().notNull(),
    asset: text("asset"),
    payer: text("payer").notNull(),
    amountLamports: integer("amount_lamports").notNull(),
    kolLamports: integer("kol_lamports").notNull().default(0),
    treasuryLamports: integer("treasury_lamports").notNull().default(0),
    kolPaidInline: integer("kol_paid_inline", { mode: "boolean" }).notNull().default(false),
    signature: text("signature").notNull(),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("ledger_brain").on(t.brainId)],
);

/** Payouts of accrued (not inline-paid) KOL share, e.g. revenue earned before the claim. */
export const kolPayouts = sqliteTable("kol_payouts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  brainId: text("brain_id")
    .notNull()
    .references(() => brains.id, { onDelete: "cascade" }),
  wallet: text("wallet").notNull(),
  amountLamports: integer("amount_lamports").notNull(),
  status: text("status").$type<"pending" | "sent" | "failed">().notNull().default("pending"),
  signature: text("signature"),
  error: text("error"),
  createdAt: integer("created_at").notNull().default(now),
});

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    brainId: text("brain_id")
      .notNull()
      .references(() => brains.id, { onDelete: "cascade" }),
    wallet: text("wallet").notNull(),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull(),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("chat_brain_wallet").on(t.brainId, t.wallet, t.id)],
);

/** Disputes / corrections / opt-out requests (GDPR Art. 21, defamation right-of-reply). */
export const disputes = sqliteTable("disputes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  brainId: text("brain_id"),
  contact: text("contact").notNull(),
  kind: text("kind").$type<"correction" | "opt_out" | "other">().notNull(),
  message: text("message").notNull(),
  status: text("status").$type<"open" | "resolved">().notNull().default("open"),
  createdAt: integer("created_at").notNull().default(now),
});

/**
 * Connectome synapses between brains (directed pre → post). A "co-entry" event: both wallets first-bought the same
 * token within the window and pre bought first. Weight is IDF-normalised so tokens everyone apes count less.
 * Recomputed wholesale by the worker (src/server/connectome); one row per (pre, post).
 */
export const synapses = sqliteTable(
  "synapses",
  {
    pre: text("pre")
      .notNull()
      .references(() => brains.id, { onDelete: "cascade" }),
    post: text("post")
      .notNull()
      .references(() => brains.id, { onDelete: "cascade" }),
    weight: real("weight").notNull(), // Σ idf(token)·exp(−lag/τ) over co-entries where pre led (significant pairs only)
    events: integer("events").notNull(), // co-entry count where pre led
    medianLagSec: integer("median_lag_sec").notNull(),
    lastEventAt: integer("last_event_at").notNull(), // unix s; recency for "plasticity"
    sampleJson: text("sample_json").notNull().default("[]"), // up to 5 {mint, symbol, lagSec, at}
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("synapses_pair").on(t.pre, t.post), index("synapses_post").on(t.post)],
);

/** Per-brain connectome metrics (one row per brain), recomputed with `synapses`. */
export const neurons = sqliteTable("neurons", {
  brainId: text("brain_id")
    .primaryKey()
    .references(() => brains.id, { onDelete: "cascade" }),
  region: integer("region").notNull(), // Louvain community id
  pagerank: real("pagerank").notNull(), // on the reversed graph: influence flows from leaders
  inWeight: real("in_weight").notNull(), // Σ weight of synapses where this brain followed
  outWeight: real("out_weight").notNull(), // Σ weight where it led
  leadShare: real("lead_share"), // out / (in + out)
  partners: integer("partners").notNull(), // distinct connected brains
  entries: integer("entries").notNull(), // first-buys in the window (activity)
  updatedAt: integer("updated_at").notNull().default(now),
});

/**
 * Swarm: several tracked brains first-buying the same token within a short window (an external study measured
 * ≥5 KOLs in 10 min → ~15% runners, ≥10 → ~50%). One row per token per swarm; grows as more brains join.
 */
export const swarms = sqliteTable(
  "swarms",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    mint: text("mint").notNull(),
    startedAt: integer("started_at").notNull(), // first member's entry (unix s)
    lastJoinAt: integer("last_join_at").notNull(),
    members: integer("members").notNull(),
    membersJson: text("members_json").notNull(), // [{brainId, at, solValue, mcUsd}] in entry order
    mcAtStartUsd: real("mc_at_start_usd"),
    publishAt: integer("publish_at").notNull(), // when the threshold was crossed (holders alerted)
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("swarms_mint_start").on(t.mint, t.startedAt),
    index("swarms_last_join").on(t.lastJoinAt),
    index("swarms_started").on(t.startedAt),
  ],
);

/**
 * Precomputed request-time aggregates (leaderboard, landing, squads, swarm rates, replays), written by the worker in
 * one short upsert per key and read by the site with a primary-key lookup (src/server/snapshots).
 */
export const snapshots = sqliteTable("snapshots", {
  key: text("key").primaryKey(),
  json: text("json").notNull(),
  computedAt: integer("computed_at").notNull(), // unix s
});

/**
 * Brain agents: an autonomous trader that owns its own wallet and trades IN THE STYLE of a brain (strategy derived
 * from the brain's BrainProfile — launchpads, entry MC/delay, sizing, hold, exits). It does not mirror the KOL's
 * trades. Requires an active seat on the brain. Custodial: the server holds the agent key, encrypted at rest
 * (AES-256-GCM, AGENT_MASTER_KEY). Owner can withdraw at any time, whatever the agent's status.
 */
export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull(), // user wallet (session)
    brainId: text("brain_id")
      .notNull()
      .references(() => brains.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    walletPubkey: text("wallet_pubkey").notNull().unique(),
    encSecret: text("enc_secret").notNull(), // base64(iv | tag | ciphertext) of the 64-byte secret key
    mode: text("mode").$type<"paper" | "live">().notNull().default("paper"),
    status: text("status").$type<"running" | "paused" | "halted" | "stopped">().notNull().default("paused"),
    haltedReason: text("halted_reason"),
    strategyJson: text("strategy_json").notNull(), // StrategySpec (src/server/agents/types.ts)
    strategyProfileVersion: integer("strategy_profile_version").notNull(),
    /** Owner edits (StrategyOverrides), re-applied on top of every re-derived strategy. */
    overridesJson: text("overrides_json"),
    useLlm: integer("use_llm", { mode: "boolean" }).notNull().default(true),
    paperStartLamports: integer("paper_start_lamports").notNull().default(5_000_000_000),
    /** Simulated SOL cash in paper mode (fills debit/credit it). Ignored in live mode (on-chain balance is the cash). */
    paperCashLamports: integer("paper_cash_lamports").notNull().default(5_000_000_000),
    /** Daily-loss guardian baseline (Perp guardian.ts): equity at the first mark of the UTC day `dayKey`. */
    dayKey: text("day_key"),
    dayStartEquityLamports: integer("day_start_equity_lamports"),
    /** Latest marked equity (cash + open positions at fresh prices), written by the runner. */
    equityLamports: integer("equity_lamports"),
    /** Last on-chain SOL balance seen (live wallet; also tracked for paper agents so deposits are noticed). */
    chainLamports: integer("chain_lamports"),
    markedAt: integer("marked_at"),
    /** Owner asked to sell every position (POST /api/agents/[id]/close-all); the runner executes and clears it. */
    closeAllRequestedAt: integer("close_all_requested_at"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
    /**
     * user = a seat holder's agent. "hive" / "shadow" are legacy platform-agent kinds kept for migration
     * compatibility; nothing creates them any more.
     */
    kind: text("kind").$type<"user" | "hive" | "shadow">().notNull().default("user"),
  },
  (t) => [index("agents_owner").on(t.owner), index("agents_status").on(t.status)],
);

/** Every candidate the agent looked at and what it decided (the public tape), incl. skips with reasons. */
export const agentDecisions = sqliteTable(
  "agent_decisions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    mint: text("mint").notNull(),
    action: text("action").$type<"buy" | "sell" | "skip">().notNull(),
    reason: text("reason").notNull(), // deterministic rule summary
    featuresJson: text("features_json").notNull(), // CandidateFeatures at decision time
    llmModel: text("llm_model"),
    llmText: text("llm_text"), // the model's short rationale, if the LLM judge ran
    /** Platform agents only (legacy): DecisionContext (src/server/agents/types.ts) — style in charge + context chips. */
    contextJson: text("context_json"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("agent_decisions_agent").on(t.agentId, t.id)],
);

export const agentOrders = sqliteTable(
  "agent_orders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    decisionId: integer("decision_id"),
    side: text("side").$type<"buy" | "sell">().notNull(),
    mint: text("mint").notNull(),
    inAmount: text("in_amount").notNull(), // raw units as string (lamports for buys, token raw for sells)
    outAmount: text("out_amount"),
    /** Idempotency key: one order per (agent, intent); a re-run of the same intent can never send twice. Always set
     *  by src/server/agents (nullable only because SQLite can't add a NOT NULL column without a default). */
    clientKey: text("client_key"),
    reason: text("reason").notNull().default("entry"),
    symbol: text("symbol"),
    /** SOL leg in lamports: spent (buy) or received (sell), after fees. */
    lamports: integer("lamports"),
    feeLamports: integer("fee_lamports"),
    status: text("status").$type<"queued" | "sent" | "filled" | "failed">().notNull().default("queued"),
    paper: integer("paper", { mode: "boolean" }).notNull(),
    signature: text("signature"),
    priceUsd: real("price_usd"),
    mcUsd: real("mc_usd"),
    error: text("error"),
    createdAt: integer("created_at").notNull().default(now),
    filledAt: integer("filled_at"),
  },
  (t) => [
    index("agent_orders_agent").on(t.agentId, t.id),
    index("agent_orders_status").on(t.status),
    uniqueIndex("agent_orders_client_key").on(t.agentId, t.clientKey),
  ],
);

export const agentPositions = sqliteTable(
  "agent_positions",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    mint: text("mint").notNull(),
    qtyRaw: text("qty_raw").notNull(), // token raw units as string
    decimals: integer("decimals").notNull(),
    costLamports: integer("cost_lamports").notNull(), // remaining cost basis
    realizedLamports: integer("realized_lamports").notNull().default(0),
    peakQtyRaw: text("peak_qty_raw").notNull(),
    symbol: text("symbol"),
    entryPriceUsd: real("entry_price_usd"),
    entryMcUsd: real("entry_mc_usd"),
    peakPriceUsd: real("peak_price_usd"),
    lastPriceUsd: real("last_price_usd"),
    lastPriceAt: integer("last_price_at"),
    tpStepsHit: integer("tp_steps_hit").notNull().default(0),
    initialsOutDone: integer("initials_out_done", { mode: "boolean" }).notNull().default(false),
    exitPlanJson: text("exit_plan_json").notNull(), // ExitPlan snapshot at entry
    status: text("status").$type<"open" | "closed">().notNull().default("open"),
    openedAt: integer("opened_at").notNull(),
    lastTradeAt: integer("last_trade_at").notNull(),
    closedAt: integer("closed_at"),
  },
  (t) => [uniqueIndex("agent_positions_pk").on(t.agentId, t.mint, t.openedAt), index("agent_positions_open").on(t.agentId, t.status)],
);

/** Deposits seen on-chain, withdrawals sent by the server, and paper top-ups. */
export const agentLedger = sqliteTable(
  "agent_ledger",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** fee_claim: legacy kind kept for migration compatibility (amount = wallet gain, net of the tx fee). */
    kind: text("kind").$type<"deposit" | "withdraw" | "paper_reset" | "fee_claim">().notNull(),
    amountLamports: integer("amount_lamports").notNull(),
    signature: text("signature"),
    /** Set when the row breaks a limit, e.g. "over AGENT_MAX_DEPOSIT_SOL" (a transfer can't be refused, only flagged). */
    flagged: text("flagged"),
    /** Withdraw destination (owner wallet at the time), for the audit trail. */
    counterparty: text("counterparty"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("agent_ledger_agent").on(t.agentId), uniqueIndex("agent_ledger_sig").on(t.signature)],
);

/** Equity samples (every 5 min per agent) for sparklines and the leaderboard. */
export const agentEquity = sqliteTable(
  "agent_equity",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    t: integer("t").notNull(),
    equityLamports: integer("equity_lamports").notNull(),
  },
  (t) => [uniqueIndex("agent_equity_pk").on(t.agentId, t.t)],
);

/** Legacy table (unused): style switches of a removed platform agent. Kept so the migration history stays consistent. */
export const hiveSwitches = sqliteTable("hive_switches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: integer("at").notNull(),
  fromBrainId: text("from_brain_id"), // null = initial selection
  toBrainId: text("to_brain_id").notNull(),
  fromScore: real("from_score"),
  toScore: real("to_score").notNull(),
  reason: text("reason").notNull(),
  scoresJson: text("scores_json").notNull(), // StyleScore[] at the time of the switch
});

/** Legacy table (unused): per-style scores of a removed platform agent. Kept so the migration history stays consistent. */
export const hiveScores = sqliteTable(
  "hive_scores",
  {
    brainId: text("brain_id").notNull(),
    t: integer("t").notNull(),
    agentId: text("agent_id").notNull(), // the shadow agent
    score: real("score").notNull(),
    exploit: real("exploit").notNull(),
    bonus: real("bonus").notNull(),
    pnlLamports: integer("pnl_lamports").notNull(),
    returnPct: real("return_pct"),
    drawdownPct: real("drawdown_pct").notNull(),
    hitRate: real("hit_rate"),
    sample: integer("sample").notNull(),
    eligible: integer("eligible", { mode: "boolean" }).notNull(),
  },
  (t) => [uniqueIndex("hive_scores_pk").on(t.brainId, t.t), index("hive_scores_t").on(t.t)],
);

/**
 * Brain Picks (src/server/picks): a token that matched a brain's style (same rules as its agents) when the agents
 * runner saw it. Seat holders see it at once, the public after PUBLIC_DELAY_SEC. Never an order: the pick is tracked on
 * paper by the style's exit plan (1 unit staked at entryPriceUsd) and its outcome is the brain's pick track record.
 */
export const brainPicks = sqliteTable(
  "brain_picks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    brainId: text("brain_id")
      .notNull()
      .references(() => brains.id, { onDelete: "cascade" }),
    mint: text("mint").notNull(),
    symbol: text("symbol"),
    createdAt: integer("created_at").notNull().default(now),
    featuresJson: text("features_json").notNull(), // CandidateFeatures at pick time
    reason: text("reason").notNull(), // deterministic rule summary
    chipsJson: text("chips_json").notNull().default("[]"), // council chips (string[])
    llmModel: text("llm_model"),
    llmText: text("llm_text"), // optional LLM one-liner
    entryMcUsd: real("entry_mc_usd"),
    entryPriceUsd: real("entry_price_usd").notNull(),
    suggestedFraction: real("suggested_fraction").notNull(), // the style's size, fraction of a bankroll
    exitPlanJson: text("exit_plan_json").notNull(), // ExitPlan snapshot
    status: text("status").$type<"open" | "closed">().notNull().default("open"),
    closedAt: integer("closed_at"),
    closeReason: text("close_reason").$type<"tp" | "sl" | "trail" | "time" | "dead">(),
    // paper position state (evaluateExit inputs), stake = 1
    peakPriceUsd: real("peak_price_usd"),
    lastPriceUsd: real("last_price_usd"),
    lastPriceAt: integer("last_price_at"),
    tpStepsHit: integer("tp_steps_hit").notNull().default(0),
    initialsOutDone: integer("initials_out_done", { mode: "boolean" }).notNull().default(false),
    remaining: real("remaining").notNull().default(1), // share of the stake still held (0–1)
    realized: real("realized").notNull().default(0), // proceeds so far, in stakes
    maxGainPct: real("max_gain_pct"),
    lastGainPct: real("last_gain_pct"),
    outcomePct: real("outcome_pct"), // (realized − 1) × 100 once closed
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [
    index("brain_picks_brain").on(t.brainId, t.createdAt),
    index("brain_picks_brain_mint").on(t.brainId, t.mint),
    index("brain_picks_status").on(t.status),
    index("brain_picks_created").on(t.createdAt),
  ],
);
