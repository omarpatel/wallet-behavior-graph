/** Pure decisions behind the AI layer: provider failover and the alert-explanation budget. */

export type AiProvider = "anthropic" | "openai";

/** Preference order: Anthropic is primary, OpenAI takes over while it is out. */
export const PROVIDER_PREFERENCE: readonly AiProvider[] = ["anthropic", "openai"];

/** Billing, auth, unknown model: skip the provider, re-probe it after this long. */
export const PROVIDER_DOWN_MS = 30 * 60_000;
/** Rate limit, overload, outage, network: skip the provider briefly. */
export const PROVIDER_BLIP_MS = 2 * 60_000;

/**
 * How long a provider sits out after this failure, or null when the failure is specific to the request
 * (bad prompt, too long, …) and switching providers would not help.
 */
export function failoverCooldownMs(status: number | null, message: string): number | null {
  if (status == null) return PROVIDER_BLIP_MS;
  if (/credit balance|billing|quota/i.test(message)) return PROVIDER_DOWN_MS;
  if (status === 401 || status === 403 || status === 404) return PROVIDER_DOWN_MS;
  if (status === 408 || status === 409 || status === 429 || status >= 500) return PROVIDER_BLIP_MS;
  return null;
}

/**
 * Providers to try for one request, in order: configured ones that are not sitting out, by preference.
 * When every configured provider is sitting out, all of them are probed rather than failing untried.
 */
export function providerOrder(
  configured: Record<AiProvider, boolean>,
  downUntil: Partial<Record<AiProvider, number>>,
  now: number,
): AiProvider[] {
  const usable = PROVIDER_PREFERENCE.filter((p) => configured[p]);
  const up = usable.filter((p) => (downUntil[p] ?? 0) <= now);
  return up.length ? up : usable;
}

/** Explanation priority of an alert: live-tier brain, swarm member, then trade size. */
export function explainPriority(a: { live: boolean; swarm: boolean; usdValue: number | null }): number {
  const usd = a.usdValue ?? 0;
  const size = usd >= 1000 ? 3 : usd >= 300 ? 2 : usd >= 100 ? 1 : 0;
  return (a.live ? 4 : 0) + (a.swarm ? 3 : 0) + size;
}

/**
 * Lowest priority still explained with `used` of the hourly `budget` spent: everything in the first half,
 * then trades ≥ $100 or from live-tier / swarm brains, then only live-tier brains and the largest swarm
 * trades; nothing once the budget is spent.
 */
export function minExplainPriority(used: number, budget: number): number {
  if (used >= budget) return Infinity;
  const share = used / budget;
  if (share < 0.5) return 0;
  if (share < 0.8) return 1;
  return 4;
}
