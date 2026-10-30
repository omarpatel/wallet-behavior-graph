import { and, desc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { getDb } from "@/db/client";
import { brains, shillEvents, tweets } from "@/db/schema";
import { requireEnv } from "@/lib/env";
import { AiUnavailableError, aiPausedUntil, complete, mapLimit, reportAiFailure, reportAiSuccess } from "@/server/ai/client";
import { XApiError, snowflakeMs, xGet, type XProblem, type XTweet } from "./api";
import { extractMentions, type TweetMention } from "./mentions";

type Stance = "bullish" | "neutral" | "bearish" | "unknown";

const BACKFILL_DAYS = 90;
const BACKFILL_MAX_PAGES = 32; // X returns at most the latest 3,200 posts of a timeline
const LIVE_MAX_PAGES = 10;
const COMPLIANCE_EVERY_SEC = 24 * 3600;
const TWEET_FIELDS = "created_at,entities,edit_history_tweet_ids";

/** Newest timeline id seen per brain in this process (we only store tweets that mention tokens). */
const newestSeen = new Map<string, string>();

interface TimelinePage {
  data?: XTweet[];
  meta?: { newest_id?: string; next_token?: string; result_count?: number };
}

const maxId = (a: string | undefined, b: string | undefined) =>
  a === undefined ? b : b === undefined ? a : BigInt(a) >= BigInt(b) ? a : b;

/**
 * Fast-model stance of the author toward the mentioned token(s). "unknown" when the AI provider is
 * unavailable; such posts are re-classified by later polls (reclassifyUnknown).
 */
async function classifyStance(text: string, mentions: TweetMention[]): Promise<Stance> {
  if (aiPausedUntil()) return "unknown";
  try {
    const res = await complete({
      tier: "fast",
      maxTokens: 5,
      system:
        "Classify the author's stance toward the token(s) named in a crypto post. Answer with exactly one word: bullish (promotes, hypes, encourages buying, announces own buy positively, price targets), neutral (news, question, mention without opinion, disclosure only), or bearish (warns, criticises, says they sold or exited negatively).",
      messages: [
        {
          role: "user",
          content: `Tokens: ${mentions.map((m) => (m.symbol ? `$${m.symbol} (${m.mint})` : m.mint)).join(", ")}\nPost:\n${text}`,
        },
      ],
    });
    reportAiSuccess();
    const word = res.text.toLowerCase().match(/bullish|neutral|bearish/)?.[0];
    return (word as Stance | undefined) ?? "unknown";
  } catch (err) {
    const e = reportAiFailure(err, "tweet stance");
    if (e instanceof AiUnavailableError) return "unknown";
    throw e;
  }
}

async function reclassifyUnknown(): Promise<void> {
  const db = getDb();
  const rows = await db.select().from(tweets).where(eq(tweets.stance, "unknown")).limit(50);
  for (const t of rows) {
    if (aiPausedUntil()) return;
    const stance = await classifyStance(t.text, JSON.parse(t.mentionsJson) as TweetMention[]);
    if (stance !== "unknown") await db.update(tweets).set({ stance }).where(eq(tweets.id, t.id));
  }
}

async function pollBrain(brain: { id: string; xUserId: string }, token: string): Promise<number> {
  const db = getDb();
  let sinceId = newestSeen.get(brain.id);
  if (!sinceId) {
    const [newest] = await db
      .select({ id: tweets.id })
      .from(tweets)
      .where(eq(tweets.brainId, brain.id))
      .orderBy(desc(tweets.createdAtMs))
      .limit(1);
    sinceId = newest?.id;
  }
  const startTime = sinceId ? undefined : new Date(Date.now() - BACKFILL_DAYS * 86_400_000).toISOString();

  const fetched: XTweet[] = [];
  let newest: string | undefined = sinceId;
  let pageToken: string | undefined;
  for (let page = 0; page < (sinceId ? LIVE_MAX_PAGES : BACKFILL_MAX_PAGES); page++) {
    const res = await xGet<TimelinePage>(`/users/${brain.xUserId}/tweets`, token, {
      max_results: "100",
      exclude: "retweets",
      "tweet.fields": TWEET_FIELDS,
      since_id: sinceId,
      start_time: startTime,
      pagination_token: pageToken,
    });
    fetched.push(...(res.data ?? []));
    newest = maxId(newest, res.meta?.newest_id);
    pageToken = res.meta?.next_token;
    if (!pageToken) break;
  }

  let stored = 0;
  await mapLimit(fetched, 3, async (t) => {
    const createdAtMs = snowflakeMs(t.id);
    const mentions = await extractMentions(brain.id, t, createdAtMs);
    if (!mentions.length) return;
    const stance = await classifyStance(t.text, mentions);
    await db
      .insert(tweets)
      .values({ id: t.id, brainId: brain.id, text: t.text, createdAtMs, mentionsJson: JSON.stringify(mentions), stance })
      .onConflictDoUpdate({
        target: tweets.id,
        set: { text: t.text, mentionsJson: JSON.stringify(mentions), stance, fetchedAt: Math.floor(Date.now() / 1000) },
      });
    stored++;
    // An edited post gets a new id; earlier versions must not be kept.
    const older = (t.edit_history_tweet_ids ?? []).filter((id) => id !== t.id);
    if (older.length) await deleteTweets(older);
  });
  if (newest) newestSeen.set(brain.id, newest);
  return stored;
}

async function deleteTweets(ids: string[]) {
  if (!ids.length) return;
  const db = getDb();
  await db.delete(shillEvents).where(inArray(shillEvents.tweetId, ids));
  await db.delete(tweets).where(inArray(tweets.id, ids));
}

/**
 * X Developer Policy compliance: re-hydrate stored posts at least daily and delete any that are no
 * longer available (deleted, protected, suspended), plus the evidence derived from them.
 */
async function compliancePass(token: string): Promise<number> {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - COMPLIANCE_EVERY_SEC;
  const stale = await db.select({ id: tweets.id }).from(tweets).where(lt(tweets.fetchedAt, cutoff));
  let removed = 0;
  for (let i = 0; i < stale.length; i += 100) {
    const ids = stale.slice(i, i + 100).map((r) => r.id);
    const res = await xGet<{ data?: XTweet[]; errors?: XProblem[] }>("/tweets", token, {
      ids: ids.join(","),
      "tweet.fields": TWEET_FIELDS,
    });
    const alive = new Set((res.data ?? []).map((t) => t.id));
    const gone = ids.filter((id) => !alive.has(id));
    await deleteTweets(gone);
    removed += gone.length;
    for (const t of res.data ?? []) {
      await db.update(tweets).set({ text: t.text, fetchedAt: Math.floor(Date.now() / 1000) }).where(eq(tweets.id, t.id));
    }
  }
  return removed;
}

/**
 * Poll the timelines of claimed, X-linked brains via the official API (app bearer token), store
 * posts that mention tokens with their stance, and run the daily deletion-compliance pass.
 */
export async function pollClaimedTweets(): Promise<void> {
  const db = getDb();
  const linked = await db
    .select({ id: brains.id, xUserId: brains.xUserId })
    .from(brains)
    .where(and(eq(brains.status, "claimed"), isNotNull(brains.xUserId)));
  const [anyStored] = await db.select({ id: tweets.id }).from(tweets).limit(1);
  if (!linked.length && !anyStored) return;

  const { X_BEARER_TOKEN } = requireEnv("X_BEARER_TOKEN");
  for (const b of linked) {
    try {
      const n = await pollBrain({ id: b.id, xUserId: b.xUserId! }, X_BEARER_TOKEN);
      if (n) console.log(`[x] ${b.id}: stored ${n} token posts`);
    } catch (err) {
      if (err instanceof XApiError && err.status === 429) {
        console.warn(`[x] rate limited until ${err.resetAt ?? "?"}; stopping this pass`);
        return;
      }
      console.error(`[x] ${b.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  await reclassifyUnknown();
  const removed = await compliancePass(X_BEARER_TOKEN);
  if (removed) console.log(`[x] compliance: deleted ${removed} posts no longer available on X`);
}
