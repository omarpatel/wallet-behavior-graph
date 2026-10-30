/**
 * Shared HTTP plumbing for third-party data APIs: sliding-window rate limiters,
 * 429 handling that honours Retry-After, and a JSON-RPC client.
 */
import { setTimeout as sleep } from "node:timers/promises";


/** Sliding-window limiter: at most `max` acquisitions per `windowMs`. Also supports a global pause (429 cool-down). */
export class RateLimiter {
  private stamps: number[] = [];
  private pausedUntil = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Resolves when a slot is free. Calls are served in FIFO order. */
  acquire(): Promise<void> {
    const next = this.queue.then(() => this.waitForSlot());
    this.queue = next.catch(() => undefined);
    return next;
  }

  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const now = Date.now();
      if (now < this.pausedUntil) {
        await sleep(this.pausedUntil - now);
        continue;
      }
      this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
      if (this.stamps.length < this.max) {
        this.stamps.push(now);
        return;
      }
      await sleep(this.windowMs - (now - this.stamps[0]) + 5);
    }
  }
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    body: string,
  ) {
    super(`HTTP ${status} from ${redact(url)}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

/** Strip api keys from URLs before they reach logs or error messages. */
export function redact(url: string): string {
  return url.replace(/(api-key=)[^&]+/gi, "$1***");
}

function retryAfterMs(res: Response, attempt: number): number {
  const h = res.headers.get("retry-after");
  if (h) {
    const sec = Number(h);
    if (Number.isFinite(sec)) return Math.max(500, sec * 1000);
    const at = Date.parse(h);
    if (Number.isFinite(at)) return Math.max(500, at - Date.now());
  }
  return Math.min(30_000, 1000 * 2 ** attempt);
}

export interface FetchOptions {
  limiter?: RateLimiter;
  init?: RequestInit;
  retries?: number;
  timeoutMs?: number;
}

/**
 * fetch + JSON with limiter, timeout and retries on 429/5xx/network errors.
 * A 429 pauses the whole limiter for the Retry-After duration so concurrent callers back off too.
 * `timeoutMs` covers headers and body: a stall while streaming a large body (e.g. the worker's event loop blocked by a
 * long synchronous rebuild, so the abort timer fires before the buffered bytes are read) is retried like a network error.
 */
export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const { limiter, init, retries = 5, timeoutMs = 30_000 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await limiter?.acquire();
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      lastErr = err;
      await sleep(Math.min(15_000, 500 * 2 ** attempt));
      continue;
    }
    if (res.status === 429) {
      const wait = retryAfterMs(res, attempt);
      limiter?.pause(wait);
      lastErr = new HttpError(429, url, await res.text().catch(() => ""));
      if (!limiter) await sleep(wait);
      continue;
    }
    if (res.status >= 500) {
      lastErr = new HttpError(res.status, url, await res.text().catch(() => ""));
      await sleep(Math.min(15_000, 1000 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new HttpError(res.status, url, await res.text().catch(() => ""));
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      lastErr = err;
      await sleep(Math.min(15_000, 500 * 2 ** attempt));
      continue;
    }
    return JSON.parse(text) as T;
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Request failed: ${redact(url)}`);
}

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly method: string,
  ) {
    super(`RPC ${method} error ${code}: ${message}`);
    this.name = "RpcError";
  }
}

/** JSON-RPC 2.0 call. Rate-limited per method by the supplied limiter lookup. */
export async function jsonRpc<T>(
  url: string,
  method: string,
  params: unknown,
  limiter?: RateLimiter,
): Promise<T> {
  const body = await fetchJson<{ result?: T; error?: { code: number; message: string } }>(url, {
    limiter,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
  });
  if (body.error) {
    // -32429 / "rate limit" style errors arrive as JSON-RPC errors on some providers
    if (body.error.code === 429 || /rate limit/i.test(body.error.message)) {
      limiter?.pause(5000);
    }
    throw new RpcError(body.error.code, body.error.message, method);
  }
  return body.result as T;
}
