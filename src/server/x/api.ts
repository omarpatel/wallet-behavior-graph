/** Minimal client for the official X API v2 (https://api.x.com/2). */

export const X_API = "https://api.x.com/2";

export class XApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Unix seconds when the rate-limit window resets (429 only). */
    public readonly resetAt: number | null = null,
  ) {
    super(message);
    this.name = "XApiError";
  }
}

export interface XTweetEntities {
  urls?: { url: string; expanded_url?: string; unwound_url?: string; display_url?: string }[];
  cashtags?: { start: number; end: number; tag: string }[];
}

export interface XTweet {
  id: string;
  text: string;
  created_at?: string;
  entities?: XTweetEntities;
  edit_history_tweet_ids?: string[];
}

export interface XProblem {
  value?: string;
  resource_id?: string;
  resource_type?: string;
  title?: string;
  type?: string;
  detail?: string;
}

export async function xGet<T>(path: string, token: string, query: Record<string, string | undefined> = {}): Promise<T> {
  const url = new URL(`${X_API}${path}`);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    const reset = Number(res.headers.get("x-rate-limit-reset"));
    const body = await res.text().catch(() => "");
    throw new XApiError(
      res.status,
      `X API ${res.status} on ${path}: ${body.slice(0, 300)}`,
      res.status === 429 && Number.isFinite(reset) ? reset : null,
    );
  }
  return (await res.json()) as T;
}

/** Millisecond timestamp encoded in an X snowflake id (created_at only has 1s resolution). */
export function snowflakeMs(id: string): number {
  return Number((BigInt(id) >> 22n) + 1288834974657n);
}
