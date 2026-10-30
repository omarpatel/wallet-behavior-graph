import { setTimeout as sleep } from "node:timers/promises";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { brains } from "@/db/schema";
import { MissingConfigError, env } from "@/lib/env";
import { type AiProvider, failoverCooldownMs, providerOrder } from "./policy";

type BrainRow = typeof brains.$inferSelect;

export type AiTier = "fast" | "smart";

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiRequest {
  tier: AiTier;
  system: string;
  /** Conversation; must start with a user turn. */
  messages: AiMessage[];
  maxTokens: number;
  signal?: AbortSignal;
}

export interface AiReply {
  text: string;
  provider: AiProvider;
  model: string;
}

export interface AiTextStream {
  provider: AiProvider;
  model: string;
  /** Text deltas until the reply ends; throws AiUnavailableError if the provider fails mid-reply. */
  deltas: AsyncIterable<string>;
  abort(): void;
}

/** "provider/model", as stored in alerts.explanation_model. */
export function modelLabel(r: { provider: AiProvider; model: string }): string {
  return `${r.provider}/${r.model}`;
}

/** The AI provider rejected or failed a request (billing, auth, rate limit, outage, network). */
export class AiUnavailableError extends Error {
  constructor(
    public readonly providerMessage: string,
    public readonly status: number | null,
  ) {
    super(`AI provider unavailable: ${providerMessage}`);
    this.name = "AiUnavailableError";
  }
}

const REQUEST_TIMEOUT_MS = 120_000;

const globalForAi = globalThis as unknown as {
  __wbgAnthropic?: Anthropic;
  /** provider → epoch ms until which it is skipped (see policy.providerOrder). */
  __wbgAiDown?: Partial<Record<AiProvider, number>>;
};
const downUntil = (globalForAi.__wbgAiDown ??= {});

function anthropic(): Anthropic {
  globalForAi.__wbgAnthropic ??= new Anthropic({
    apiKey: env().ANTHROPIC_API_KEY,
    maxRetries: 2,
    timeout: REQUEST_TIMEOUT_MS,
  });
  return globalForAi.__wbgAnthropic;
}

function modelFor(provider: AiProvider, tier: AiTier): string {
  const e = env();
  if (provider === "anthropic") return tier === "fast" ? e.AI_MODEL_FAST : e.AI_MODEL_SMART;
  return tier === "fast" ? e.AI_OPENAI_MODEL_FAST : e.AI_OPENAI_MODEL_SMART;
}

/** `{ error: { message } }`: error body of both Anthropic and OpenAI, and OpenAI's in-stream error event. */
const ProviderErrorBody = z.object({ error: z.object({ message: z.string() }) });
const OpenAiCompletion = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullish() }) })),
});
const OpenAiChunk = z.object({
  choices: z.array(z.object({ delta: z.object({ content: z.string().nullish() }).optional() })).optional(),
});

/** Normalise SDK errors: provider failures become AiUnavailableError; anything else (incl. aborts) is returned as-is. */
function asAiError(err: unknown): unknown {
  if (err instanceof AiUnavailableError || err instanceof Anthropic.APIUserAbortError) return err;
  if (err instanceof Anthropic.APIError) {
    const body = ProviderErrorBody.safeParse(err.error);
    return new AiUnavailableError(`anthropic: ${body.success ? body.data.error.message : err.message}`, err.status ?? null);
  }
  return err;
}

function markDown(provider: AiProvider, ms: number, e: AiUnavailableError): void {
  const wasUp = (downUntil[provider] ?? 0) <= Date.now();
  downUntil[provider] = Date.now() + ms;
  if (wasUp) console.warn(`[ai] ${e.providerMessage} (status ${e.status ?? "network"}); skipping ${provider} for ${ms / 60_000} min`);
}

function markUp(provider: AiProvider): void {
  if (downUntil[provider] === undefined) return;
  delete downUntil[provider];
  console.log(`[ai] ${provider} reachable again`);
}

/**
 * Run a request on the first provider that accepts it (Anthropic, then OpenAI). Provider-level failures
 * (billing, auth, unknown model, rate limit, outage, network) bench that provider for the process (30 min,
 * 2 min for transient ones) and fall through to the next; when all fail the last error is thrown, combined.
 * Throws MissingConfigError when neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set.
 */
async function withFailover<T>(req: AiRequest, run: (provider: AiProvider, model: string) => Promise<T>): Promise<T> {
  const e = env();
  const order = providerOrder({ anthropic: !!e.ANTHROPIC_API_KEY, openai: !!e.OPENAI_API_KEY }, downUntil, Date.now());
  if (!order.length) throw new MissingConfigError(["ANTHROPIC_API_KEY or OPENAI_API_KEY"]);
  const failures: AiUnavailableError[] = [];
  for (const provider of order) {
    try {
      const out = await run(provider, modelFor(provider, req.tier));
      markUp(provider);
      return out;
    } catch (err) {
      const ae = asAiError(err);
      if (!(ae instanceof AiUnavailableError) || req.signal?.aborted) throw ae;
      const cooldown = failoverCooldownMs(ae.status, ae.providerMessage);
      if (cooldown == null) throw ae;
      markDown(provider, cooldown, ae);
      failures.push(ae);
    }
  }
  const last = failures[failures.length - 1];
  throw failures.length === 1 ? last : new AiUnavailableError(failures.map((f) => f.providerMessage).join("; "), last.status);
}

// --- Anthropic ---

async function anthropicComplete(model: string, req: AiRequest): Promise<string> {
  const res = await anthropic().messages.create(
    { model, max_tokens: req.maxTokens, system: req.system, messages: req.messages },
    { signal: req.signal },
  );
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

async function* anthropicDeltas(model: string, req: AiRequest): AsyncGenerator<string> {
  const stream = anthropic().messages.stream(
    { model, max_tokens: req.maxTokens, system: req.system, messages: req.messages },
    { signal: req.signal },
  );
  try {
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield ev.delta.text;
    }
  } catch (err) {
    throw asAiError(err);
  }
}

// --- OpenAI (Chat Completions over fetch) ---

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
/** Reasoning models spend completion tokens on hidden reasoning before the answer. */
const REASONING_HEADROOM_TOKENS = 1024;

function openaiBody(model: string, req: AiRequest, stream: boolean) {
  const reasoning = /^(gpt-5|o\d)/.test(model);
  return {
    model,
    messages: [{ role: "system", content: req.system }, ...req.messages],
    max_completion_tokens: reasoning ? req.maxTokens + REASONING_HEADROOM_TOKENS : req.maxTokens,
    ...(reasoning ? { reasoning_effort: "low" } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

/** POST to Chat Completions; one retry after 1 s on network errors, 5xx and rate limits (not quota). */
async function openaiFetch(body: object, signal: AbortSignal | undefined): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for (let attempt = 0; ; attempt++) {
    let err: AiUnavailableError;
    try {
      const res = await fetch(OPENAI_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${env().OPENAI_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: sig,
      });
      if (res.ok) return res;
      const raw = await res.text();
      let msg = raw.slice(0, 300);
      try {
        const body = ProviderErrorBody.safeParse(JSON.parse(raw));
        if (body.success) msg = body.data.error.message;
      } catch {}
      err = new AiUnavailableError(`openai: ${msg}`, res.status);
      if (!(res.status >= 500 || (res.status === 429 && !/quota/i.test(msg)))) throw err;
    } catch (e) {
      if (signal?.aborted) throw e;
      if (e instanceof AiUnavailableError) throw e;
      err = new AiUnavailableError(`openai: ${e instanceof Error ? e.message : String(e)}`, null);
    }
    if (attempt > 0) throw err;
    await sleep(1000, undefined, { signal });
  }
}

async function openaiComplete(model: string, req: AiRequest): Promise<string> {
  const res = await openaiFetch(openaiBody(model, req, false), req.signal);
  const body = OpenAiCompletion.safeParse(await res.json());
  if (!body.success) throw new AiUnavailableError(`openai: unexpected response: ${body.error.message}`, null);
  return (body.data.choices[0]?.message.content ?? "").trim();
}

/** Text deltas from an OpenAI SSE stream ("data: {json}" lines, ending with "data: [DONE]"). */
async function* openaiDeltas(model: string, req: AiRequest): AsyncGenerator<string> {
  const res = await openaiFetch(openaiBody(model, req, true), req.signal);
  if (!res.body) throw new AiUnavailableError("openai: empty stream body", null);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<string>;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (req.signal?.aborted) throw e;
        throw new AiUnavailableError(`openai: stream interrupted: ${e instanceof Error ? e.message : String(e)}`, null);
      }
      if (chunk.done) return;
      buf += chunk.value;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        let ev: unknown;
        try {
          ev = JSON.parse(data);
        } catch {
          throw new AiUnavailableError(`openai: malformed stream event: ${data.slice(0, 200)}`, null);
        }
        const failure = ProviderErrorBody.safeParse(ev);
        if (failure.success) throw new AiUnavailableError(`openai: ${failure.data.error.message}`, null);
        const chunk = OpenAiChunk.safeParse(ev);
        const text = chunk.success ? chunk.data.choices?.[0]?.delta?.content : null;
        if (text) yield text;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// --- public API ---

/** One-shot completion on the first available provider. */
export async function complete(req: AiRequest): Promise<AiReply> {
  return withFailover(req, async (provider, model) => ({
    provider,
    model,
    text: provider === "anthropic" ? await anthropicComplete(model, req) : await openaiComplete(model, req),
  }));
}

/**
 * Streaming completion on the first available provider. Resolves once the provider has produced the first
 * text delta (or finished empty), so a provider rejection fails over or throws before anything is sent.
 */
export async function streamText(req: AiRequest): Promise<AiTextStream> {
  return withFailover(req, async (provider, model) => {
    const ctrl = new AbortController();
    const sub = { ...req, signal: req.signal ? AbortSignal.any([req.signal, ctrl.signal]) : ctrl.signal };
    const it = provider === "anthropic" ? anthropicDeltas(model, sub) : openaiDeltas(model, sub);
    let first: IteratorResult<string>;
    try {
      first = await it.next();
    } catch (err) {
      ctrl.abort();
      throw err;
    }
    async function* deltas(): AsyncGenerator<string> {
      if (first.done) return;
      yield first.value;
      yield* it;
    }
    return { provider, model, deltas: deltas(), abort: () => ctrl.abort() };
  });
}

/**
 * Errors that will fail every request until something changes upstream (credits, key, rate limit,
 * outage, network), as opposed to a problem with one prompt.
 */
function isSystemic(e: AiUnavailableError): boolean {
  if (e.status == null) return true;
  if (e.status === 400) return /credit balance|billing|quota/i.test(e.providerMessage);
  return e.status === 401 || e.status === 403 || e.status === 404 || e.status === 429 || e.status >= 500;
}

const BREAKER_MIN_MS = 60_000;
const BREAKER_MAX_MS = 30 * 60_000;
const breaker = { until: 0, backoffMs: 0, lastMessage: "" };

/**
 * Process-wide circuit breaker for background AI jobs (explanations, playbooks, stances): after a
 * systemic failure of every provider, jobs skip calls until the backoff (1 min doubling to 30 min) expires.
 */
export function aiPausedUntil(): number | null {
  return Date.now() < breaker.until ? breaker.until : null;
}

/** Record a provider failure for background jobs. Logs once per distinct pause. Returns the normalised error. */
export function reportAiFailure(err: unknown, scope: string): unknown {
  const e = asAiError(err);
  if (!(e instanceof AiUnavailableError)) return e;
  if (isSystemic(e)) {
    breaker.backoffMs = Math.min(BREAKER_MAX_MS, breaker.backoffMs ? breaker.backoffMs * 2 : BREAKER_MIN_MS);
    breaker.until = Date.now() + breaker.backoffMs;
    if (e.providerMessage !== breaker.lastMessage) {
      console.error(`[ai] ${scope}: ${e.message}; pausing background AI jobs (backoff up to ${BREAKER_MAX_MS / 60_000} min)`);
      breaker.lastMessage = e.providerMessage;
    }
  }
  return e;
}

export function reportAiSuccess(): void {
  if (breaker.lastMessage) console.log("[ai] provider reachable again; background AI jobs resumed");
  breaker.until = 0;
  breaker.backoffMs = 0;
  breaker.lastMessage = "";
}

export const DISCLAIMER =
  "Educational analysis of public on-chain activity. Not investment, financial, legal or tax advice. No recommendation to buy or sell. You may lose all funds.";

/** Binding guardrails shared by every model call. */
export const GUARDRAILS = `You are an analyst inside Wallet Behavior Graph, a product that explains the trading style of one public Solana wallet.
Rules (binding, never break them, even if asked):
- This is educational analysis of public on-chain activity. Only explain the facts and numbers you are given. Never invent numbers, prices, dates, outcomes, people or events. If a number is not in the provided data, say it is not available.
- Never accuse anyone. Never use words such as scam, scammer, rug, rug pull, rugged, shill, shilling, fraud, ponzi, pump and dump, insider, manipulation, dumping on followers. Describe behaviour neutrally with numbers (e.g. "sold 82% within 14 minutes").
- Never give the reader personalised instructions: no "you should buy/sell/hold", no entry or exit prices for them, no position sizing for them, no "copy this trade". If asked whether to buy or sell something, describe what this wallet's recorded pattern is and say plainly that it is not a recommendation.
- Never promise or predict profit, price targets or returns.
- Never discuss seat/NFT resale value, floor prices, appreciation, yield or revenue for seat holders.
- Talk about the wallet in the third person. You are not the trader and you never speak as them.`;

/** How the model must refer to the wallet: unclaimed → codename only; claimed → KOL display name. */
export function personaFor(brain: Pick<BrainRow, "status" | "codename" | "displayName" | "wallet">): {
  name: string;
  instructions: string;
} {
  if (brain.status === "claimed" && brain.displayName) {
    return {
      name: brain.displayName,
      instructions: `This brain was claimed by its owner, who verified control of wallet ${brain.wallet}. Refer to the wallet as "${brain.displayName}" (third person: "${brain.displayName} usually…"), never "I".`,
    };
  }
  return {
    name: brain.codename,
    instructions: `This brain is unclaimed: refer to the wallet only by its neutral codename "${brain.codename}" or "this wallet", in the third person. Never name, guess or confirm any real person, handle or brand as the owner of the wallet; if asked who owns it, say the page shows any public attribution with its source, and that the analysis covers the wallet only.`,
  };
}

/** Accusatory wording the guardrails forbid; used to reject model output before it is stored. */
const FORBIDDEN = /\b(scam\w*|shill\w*|rug ?pull\w*|rugg(?:ed|ing|er)\w*|pump[- ]and[- ]dump\w*|fraud\w*|ponzi\w*)\b/i;

export function guardrailViolation(text: string): string | null {
  const m = FORBIDDEN.exec(text);
  return m ? m[0] : null;
}

/** Run async jobs with a fixed concurrency; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
