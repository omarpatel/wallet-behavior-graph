/**
 * Keeps ONE Helius `raw` webhook (PUBLIC_URL/api/helius/webhook) subscribed to the live-tier brain wallets
 * (brains.tracking = 'live', chosen in src/server/directory/tracking.ts; standard brains are reconciled by polling).
 * Ours = the webhook(s) carrying our HELIUS_WEBHOOK_AUTH secret, so a changed PUBLIC_URL (e.g. a new tunnel URL)
 * re-points the same webhook instead of adding a second one (each would bill every event). Edits cost 100 credits,
 * so it is only PUT when the URL or address list actually changed.
 */
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { requireEnv } from "@/lib/env";
import { fetchJson, RateLimiter } from "./http";

const API = "https://api-mainnet.helius-rpc.com/v0/webhooks";
const limiter = new RateLimiter(2, 1000);

interface HeliusWebhook {
  webhookID: string;
  webhookURL: string;
  webhookType: string;
  accountAddresses?: string[];
  transactionTypes: string[];
  authHeader?: string;
}

export interface WebhookSyncResult {
  action: "created" | "updated" | "unchanged";
  webhookID: string;
  addresses: number;
}

/** Sorted wallets of the live tier (what the webhook should subscribe). */
export async function liveWallets(): Promise<string[]> {
  const rows = await getDb().select({ wallet: schema.brains.wallet }).from(schema.brains).where(eq(schema.brains.tracking, "live"));
  return rows.map((b) => b.wallet).sort();
}

export async function syncHeliusWebhook(): Promise<WebhookSyncResult> {
  const { HELIUS_API_KEY, HELIUS_WEBHOOK_AUTH, PUBLIC_URL } = requireEnv("HELIUS_API_KEY", "HELIUS_WEBHOOK_AUTH", "PUBLIC_URL");
  const webhookURL = `${PUBLIC_URL.replace(/\/$/, "")}/api/helius/webhook`;
  const wallets = await liveWallets();
  const body = {
    webhookURL,
    webhookType: "raw",
    accountAddresses: wallets,
    // Helius requires ≥1 type; "ANY" covers PumpSwap BUY/SELL and unparsed pump curve trades (not only SWAP).
    transactionTypes: ["ANY"],
    authHeader: HELIUS_WEBHOOK_AUTH,
    txnStatus: "success",
  };
  const key = `api-key=${encodeURIComponent(HELIUS_API_KEY)}`;
  const ours = (await fetchJson<HeliusWebhook[]>(`${API}?${key}`, { limiter })).filter(
    (w) => w.authHeader === HELIUS_WEBHOOK_AUTH || w.webhookURL === webhookURL,
  );
  const [existing, ...duplicates] = ours;
  for (const d of duplicates) {
    await fetchJson(`${API}/${d.webhookID}?${key}`, { limiter, init: { method: "DELETE" } });
  }
  if (!existing) {
    const created = await fetchJson<HeliusWebhook>(`${API}?${key}`, {
      limiter,
      init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    });
    return { action: "created", webhookID: created.webhookID, addresses: wallets.length };
  }
  // The list endpoint omits accountAddresses; the single-webhook endpoint returns them.
  const addresses =
    existing.accountAddresses ??
    (await fetchJson<HeliusWebhook>(`${API}/${existing.webhookID}?${key}`, { limiter })).accountAddresses ??
    [];
  const same =
    existing.webhookURL === webhookURL &&
    existing.webhookType === "raw" &&
    existing.authHeader === HELIUS_WEBHOOK_AUTH &&
    [...addresses].sort().join(",") === wallets.join(",");
  if (same) return { action: "unchanged", webhookID: existing.webhookID, addresses: wallets.length };
  await fetchJson<HeliusWebhook>(`${API}/${existing.webhookID}?${key}`, {
    limiter,
    init: { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  });
  return { action: "updated", webhookID: existing.webhookID, addresses: wallets.length };
}
