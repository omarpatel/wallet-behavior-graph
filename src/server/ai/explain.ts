import { and, eq, gt, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { alerts, brains } from "@/db/schema";
import { env } from "@/lib/env";
import type { AlertFacts } from "@/server/alerts/types";
import {
  GUARDRAILS,
  aiPausedUntil,
  complete,
  guardrailViolation,
  mapLimit,
  modelLabel,
  personaFor,
  reportAiFailure,
  reportAiSuccess,
} from "./client";
import { parseProfile, profileSummary } from "./context";
import { explainPriority, minExplainPriority } from "./policy";

const EXPLAIN_WINDOW_SEC = 2 * 3600;
const MAX_WORDS = 55;
/** Per-alert attempts in this process before giving up on it (explanation stays NULL; facts still ship). */
const MAX_ATTEMPTS_PER_ALERT = 3;
const attemptsByAlert = new Map<number, { n: number; createdAt: number }>();
/** Epoch ms of every explanation model call in the last hour (incl. retries and failures). */
const callTimes: number[] = [];
/** Highest alert id created before the explanation window; scans start after it (ids grow with createdAt). */
let windowFloorId = 0;

/** Facts the model sees: everything deterministic except links, icon and the raw signature. */
function factsForModel(f: AlertFacts) {
  const { links: _links, icon: _icon, signature: _sig, ...rest } = f;
  return { ...rest, blockTimeIso: new Date(f.blockTime * 1000).toISOString() };
}

/**
 * Fill `alerts.explanation` for recent alerts (created in the last 2h) that don't have one yet.
 * Fast model, ≤ 55 words, explains the trade against the wallet's own pattern. Returns how many were stored.
 * Model calls are capped at AI_MAX_EXPLANATIONS_PER_HOUR: alerts are taken by priority (live-tier brain,
 * swarm member, trade size; src/server/ai/policy.ts) and low-priority ones are skipped as the hourly budget
 * fills, so their explanation stays NULL. Provider failures never throw: the process-wide AI breaker pauses
 * calls with backoff and each alert is tried at most 3 times per process.
 */
export async function explainPendingAlerts(limit = 10): Promise<number> {
  if (aiPausedUntil()) return 0;
  const db = getDb();
  const nowMs = Date.now();
  const since = Math.floor(nowMs / 1000) - EXPLAIN_WINDOW_SEC;
  const budget = env().AI_MAX_EXPLANATIONS_PER_HOUR;

  const [floor] = await db
    .select({ id: sql<number | null>`max(${alerts.id})` })
    .from(alerts)
    .where(and(gt(alerts.id, windowFloorId), lt(alerts.createdAt, since)));
  windowFloorId = Math.max(windowFloorId, Number(floor?.id ?? 0));

  while (callTimes.length && callTimes[0] < nowMs - 3600_000) callTimes.shift();
  // After a restart the in-process log is empty; explanations stored in the last hour are a lower bound.
  const [stored1h] = await db
    .select({ n: sql<number>`count(*)` })
    .from(alerts)
    .where(and(gt(alerts.id, windowFloorId), isNotNull(alerts.explanation), gte(alerts.createdAt, Math.floor(nowMs / 1000) - 3600)));
  const used = Math.max(callTimes.length, Number(stored1h?.n ?? 0));
  const minPriority = minExplainPriority(used, budget);
  if (minPriority === Infinity) return 0;

  const candidates = await db
    .select({
      id: alerts.id,
      tracking: brains.tracking,
      usdValue: sql<number | null>`json_extract(${alerts.factsJson}, '$.usdValue')`,
      swarm: sql<number>`json_extract(${alerts.factsJson}, '$.swarm') is not null`,
    })
    .from(alerts)
    .innerJoin(brains, eq(brains.id, alerts.brainId))
    .where(and(gt(alerts.id, windowFloorId), isNull(alerts.explanation), gte(alerts.createdAt, since)));
  const chosen = candidates
    .filter((c) => (attemptsByAlert.get(c.id)?.n ?? 0) < MAX_ATTEMPTS_PER_ALERT)
    .map((c) => ({ id: c.id, priority: explainPriority({ live: c.tracking === "live", swarm: !!c.swarm, usdValue: c.usdValue }) }))
    .filter((c) => c.priority >= minPriority)
    .sort((a, b) => b.priority - a.priority || b.id - a.id)
    .slice(0, Math.min(limit, budget - used))
    .map((c) => c.id);
  if (!chosen.length) return 0;

  const pending = await db
    .select({
      id: alerts.id,
      headline: alerts.headline,
      factsJson: alerts.factsJson,
      createdAt: alerts.createdAt,
      brain: {
        status: brains.status,
        codename: brains.codename,
        displayName: brains.displayName,
        wallet: brains.wallet,
        profileJson: brains.profileJson,
      },
    })
    .from(alerts)
    .innerJoin(brains, eq(brains.id, alerts.brainId))
    .where(inArray(alerts.id, chosen));
  pending.sort((x, y) => chosen.indexOf(x.id) - chosen.indexOf(y.id));

  const stored = await mapLimit(pending, 3, async (a) => {
    if (aiPausedUntil()) return false;
    const persona = personaFor(a.brain);
    const facts = JSON.parse(a.factsJson) as AlertFacts;
    const system = `${GUARDRAILS}
${persona.instructions}

Task: write a short explanation (at most ${MAX_WORDS} words, plain text, no markdown, no headings, no emojis) of ONE live trade by this wallet, read against the wallet's own usual pattern:
- how this trade's size, entry market cap and timing compare with what the wallet usually does (use the inCharacter ratios and the profile numbers),
- for buys: what this wallet typically does next with this kind of position (hold time, exit style), stated as its historical pattern;
- for sells: how this exit compares with its usual exits,
- mention any safety warnings given in the facts.
Only use numbers present in the data. If an inCharacter ratio is extreme (above 20×, e.g. a wallet whose usual buys are micro-sized), say "far larger/smaller than its usual" instead of quoting the multiplier, and don't read meaning into its size. Do not repeat the headline verbatim.`;
    const user = `Headline: ${a.headline}

Trade facts (JSON):
${JSON.stringify(factsForModel(facts))}

Wallet profile summary:
${profileSummary(parseProfile(a.brain))}`;

    let text: string | null = null;
    let producedBy = "";
    for (let attempt = 0; attempt < 2 && text == null; attempt++) {
      if (callTimes.length >= budget) return false;
      attemptsByAlert.set(a.id, { n: (attemptsByAlert.get(a.id)?.n ?? 0) + 1, createdAt: a.createdAt });
      callTimes.push(Date.now());
      let out: string;
      try {
        const res = await complete({
          tier: "fast",
          maxTokens: 220,
          system,
          messages: [
            {
              role: "user",
              content:
                attempt === 0
                  ? user
                  : `${user}\n\nYour previous answer used forbidden accusatory wording. Rewrite it neutrally, numbers only.`,
            },
          ],
        });
        reportAiSuccess();
        out = res.text.replace(/\s+/g, " ").trim();
        producedBy = modelLabel(res);
      } catch (err) {
        const e = reportAiFailure(err, `explain alert ${a.id}`);
        if (!aiPausedUntil()) console.error(`[explain] alert ${a.id}: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
      if (out && !guardrailViolation(out)) text = out;
    }
    if (text == null) {
      console.warn(`[explain] alert ${a.id}: model output kept using forbidden wording; left unexplained`);
      return false;
    }
    await db
      .update(alerts)
      .set({ explanation: text, explanationModel: producedBy })
      .where(and(eq(alerts.id, a.id), isNull(alerts.explanation)));
    attemptsByAlert.delete(a.id);
    return true;
  });

  // Forget alerts that left the 2h window so the map stays bounded.
  for (const [id, v] of attemptsByAlert) if (v.createdAt < since) attemptsByAlert.delete(id);
  return stored.filter(Boolean).length;
}
