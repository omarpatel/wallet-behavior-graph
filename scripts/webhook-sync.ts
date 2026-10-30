/** Create/update the single Helius raw webhook with the live-tier brain wallets (brains.tracking = live). Needs HELIUS_API_KEY, HELIUS_WEBHOOK_AUTH, PUBLIC_URL. */
import { syncHeliusWebhook } from "@/server/ingest/webhooks";

try {
  const res = await syncHeliusWebhook();
  console.log(`[webhook-sync] ${res.action} ${res.webhookID} with ${res.addresses} addresses`);
} catch (err) {
  console.error(`[webhook-sync] ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
}
