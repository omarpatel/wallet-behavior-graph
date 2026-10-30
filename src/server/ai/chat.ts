import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { alerts, chatMessages, tokens, trades } from "@/db/schema";
import { GUARDRAILS, personaFor, streamText } from "./client";
import { loadBrain, parseProfile, trimmedProfile } from "./context";

export const CHAT_LIMIT_PER_HOUR = 30;
export const CHAT_MAX_CHARS = 2000;
const HISTORY_FOR_MODEL = 20;
const HISTORY_FOR_UI = 50;

export class ChatRateLimitError extends Error {
  constructor(public readonly retryAfterSec: number) {
    super(`Chat limit reached (${CHAT_LIMIT_PER_HOUR} messages per hour per brain). Try again in ${Math.ceil(retryAfterSec / 60)} min.`);
    this.name = "ChatRateLimitError";
  }
}

export interface ChatMessageDTO {
  id: number;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

/** User messages left this hour and, when exhausted, seconds until the oldest one ages out. */
export async function chatQuota(brainId: string, wallet: string): Promise<{ remaining: number; retryAfterSec: number }> {
  const since = Math.floor(Date.now() / 1000) - 3600;
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)`, oldest: sql<number | null>`min(${chatMessages.createdAt})` })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.brainId, brainId),
        eq(chatMessages.wallet, wallet),
        eq(chatMessages.role, "user"),
        gte(chatMessages.createdAt, since),
      ),
    );
  const used = Number(row?.n ?? 0);
  const retryAfterSec = row?.oldest ? Math.max(1, row.oldest - since) : 0;
  return { remaining: Math.max(0, CHAT_LIMIT_PER_HOUR - used), retryAfterSec };
}

export async function getChatHistory(brainId: string, wallet: string, limit = HISTORY_FOR_UI): Promise<ChatMessageDTO[]> {
  const rows = await getDb()
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(and(eq(chatMessages.brainId, brainId), eq(chatMessages.wallet, wallet)))
    .orderBy(desc(chatMessages.id))
    .limit(limit);
  return rows.reverse();
}

async function buildContext(brainId: string) {
  const db = getDb();
  const nowSec = Math.floor(Date.now() / 1000);
  const [brain, recentTrades, recentAlerts] = await Promise.all([
    loadBrain(brainId),
    db
      .select({
        blockTime: trades.blockTime,
        side: trades.side,
        mint: trades.mint,
        symbol: tokens.symbol,
        tokenAmount: trades.tokenAmount,
        solValue: trades.solValue,
        usdValue: trades.usdValue,
        mcUsd: trades.mcUsd,
        venue: trades.venue,
        launchpad: trades.launchpad,
        entryDelaySec: trades.entryDelaySec,
      })
      .from(trades)
      .leftJoin(tokens, eq(tokens.mint, trades.mint))
      .where(eq(trades.brainId, brainId))
      .orderBy(desc(trades.blockTime), desc(trades.id))
      .limit(40),
    db
      .select({ headline: alerts.headline, explanation: alerts.explanation, publishAt: alerts.publishAt })
      .from(alerts)
      .where(and(eq(alerts.brainId, brainId), lte(alerts.publishAt, nowSec)))
      .orderBy(desc(alerts.publishAt), desc(alerts.id))
      .limit(10),
  ]);
  if (!brain) throw new Error(`Unknown brain ${brainId}`);
  const profile = parseProfile(brain);
  const round = (x: number | null) => (x == null ? null : Math.round(x * 100) / 100);
  const tradeLines = recentTrades.map((t) =>
    [
      new Date(t.blockTime * 1000).toISOString().slice(0, 16).replace("T", " "),
      t.side,
      t.symbol ? `$${t.symbol}` : t.mint,
      `usd=${round(t.usdValue) ?? "?"}`,
      `sol=${round(t.solValue) ?? "?"}`,
      `mc=${t.mcUsd == null ? "?" : Math.round(t.mcUsd)}`,
      `venue=${t.venue ?? "?"}`,
      t.side === "buy" && t.entryDelaySec != null ? `entryDelaySec=${t.entryDelaySec}` : "",
    ]
      .filter(Boolean)
      .join(" | "),
  );
  const context = [
    `# Profile (JSON; money in USD, durations in seconds, shares are 0–1 fractions)`,
    profile ? JSON.stringify(trimmedProfile(profile)) : "No profile computed yet.",
    `# Playbook`,
    brain.playbookMd ?? "Not written yet.",
    `# Last ${tradeLines.length} trades (UTC, newest first)`,
    tradeLines.join("\n") || "none",
    `# Last ${recentAlerts.length} published alerts (newest first)`,
    recentAlerts
      .map((a) => `- ${new Date(a.publishAt * 1000).toISOString().slice(0, 16).replace("T", " ")} ${a.headline}${a.explanation ? ` — ${a.explanation}` : ""}`)
      .join("\n") || "none",
  ].join("\n\n");
  return { brain, context };
}

/**
 * Stream the brain's reply as UTF-8 text chunks (Anthropic, failing over to OpenAI; src/server/ai/client.ts).
 * Waits for the provider's first text before returning, so when every provider rejects the request (billing,
 * auth, overload) AiUnavailableError is thrown and nothing is persisted; once streaming starts the user
 * message is stored, and the assistant message when the stream ends (also partial text when the client disconnects).
 * Throws ChatRateLimitError over 30 user messages / wallet / brain / hour, MissingConfigError without an AI key.
 */
export async function streamChat(input: {
  brainId: string;
  wallet: string;
  message: string;
  signal?: AbortSignal;
}): Promise<ReadableStream<Uint8Array>> {
  const { brainId, wallet, signal } = input;
  const message = input.message.trim();
  const quota = await chatQuota(brainId, wallet);
  if (quota.remaining <= 0) throw new ChatRateLimitError(quota.retryAfterSec);

  const [{ brain, context }, history] = await Promise.all([
    buildContext(brainId),
    getChatHistory(brainId, wallet, HISTORY_FOR_MODEL),
  ]);
  const persona = personaFor(brain);
  const db = getDb();

  // The conversation must start with a user turn.
  const firstUser = history.findIndex((m) => m.role === "user");
  const prior = firstUser < 0 ? [] : history.slice(firstUser).map((m) => ({ role: m.role, content: m.content }));

  const system = `${GUARDRAILS}
${persona.instructions}

You are coaching a seat holder who wants to understand ${persona.name}'s trading style. Answer from the data below only (profile, playbook, recent trades and alerts). Be concise and concrete (usually under 180 words), cite the numbers you rely on, and say when the data can't answer something.
If the user asks whether they should buy, sell or hold a token, or how much to put in: describe what this wallet's recorded pattern is with that kind of token or position, then state clearly that this is not a recommendation and you can't advise them personally.
Educational analysis of public on-chain activity only; not investment advice.

${context}`;

  // Fails (before any byte is sent) when every provider rejects the request.
  const ai = await streamText({
    tier: "smart",
    maxTokens: 1200,
    system,
    messages: [...prior, { role: "user", content: message }],
    signal,
  });

  await db
    .insert(chatMessages)
    .values({ brainId, wallet, role: "user", content: message })
    .catch((e: unknown) => {
      ai.abort();
      throw e;
    });

  const encoder = new TextEncoder();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (s: string) => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          // client went away; keep accumulating so the reply is still persisted
        }
      };
      void (async () => {
        let reply = "";
        let failure: unknown = null;
        try {
          for await (const delta of ai.deltas) {
            reply += delta;
            emit(delta);
          }
        } catch (err) {
          failure = err;
        }
        if (reply.trim()) {
          await db
            .insert(chatMessages)
            .values({ brainId, wallet, role: "assistant", content: reply.trim() })
            .catch((e: unknown) => console.error(`[chat] ${brainId}: persist failed: ${e instanceof Error ? e.message : e}`));
        }
        if (failure && !cancelled && !signal?.aborted) {
          console.error(`[chat] ${brainId} (${ai.provider}/${ai.model}): ${failure instanceof Error ? failure.message : String(failure)}`);
          emit(`\n\n[error: the brain could not finish this reply]`);
        }
        try {
          controller.close();
        } catch {}
      })();
    },
    cancel() {
      cancelled = true;
      ai.abort();
    },
  });
}
