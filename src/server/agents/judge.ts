/**
 * Optional LLM judge: after the deterministic rules pass, a fast model reads the brain's playbook, the strategy summary
 * and the candidate's features and returns buy/skip with a ≤30-word rationale. Budget: AGENT_LLM_CALLS_PER_HOUR per
 * agent (counted from agent_decisions.llm_model); over budget or with the provider down the rules decide alone.
 * Brain Picks (src/server/picks) use the same judge with a publishing framing (judgePick; budget kept by the caller).
 */
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db/client";
import { env } from "@/lib/env";
import { aiPausedUntil, complete, guardrailViolation, modelLabel, reportAiFailure, reportAiSuccess } from "@/server/ai/client";
import type { CandidateFeatures, StrategySpec } from "./types";

export interface JudgeVerdict {
  decision: "buy" | "skip";
  confidence: number; // 0–1
  why: string;
  model: string;
}

const Reply = z.object({
  decision: z.enum(["buy", "skip"]),
  confidence: z.number().min(0).max(1).catch(0.5),
  why: z.string().min(1),
});

const SYSTEM = `You are the entry judge of an autonomous paper/live trading agent on Solana memecoins.
The agent trades IN THE STYLE of one public wallet ("the brain"), described by its playbook and a rule summary. It never copies that wallet's trades.
Deterministic rules have already passed for this candidate. Decide whether this specific entry fits the style well enough to take.
Use only the numbers given; unknown values are unknown, not zero. Never use accusatory words (scam, rug, shill, fraud).
Reply with ONLY a JSON object: {"decision":"buy"|"skip","confidence":0..1,"why":"<= 30 words, neutral, cites the deciding numbers"}`;

const PICK_SYSTEM = `You review candidate "picks" for Wallet Behavior Graph on Solana memecoins: tokens published to a brain's seat holders because they match the trading style of one public wallet ("the brain"), described by its playbook and a rule summary. Picks are tracked on paper; they are not advice.
Deterministic rules have already passed for this candidate. Decide whether it fits the style well enough to publish ("buy" = publish, "skip" = don't).
Use only the numbers given; unknown values are unknown, not zero. Describe the fit to the style; never tell anyone what to do (no "you should", "buy now"). Never use accusatory words (scam, rug, shill, fraud).
Reply with ONLY a JSON object: {"decision":"buy"|"skip","confidence":0..1,"why":"<= 30 words, neutral, cites the deciding numbers"}`;

export async function llmCallsLastHour(agentId: string): Promise<number> {
  const r = await getDb()
    .select({ n: sql<number>`count(*)` })
    .from(schema.agentDecisions)
    .where(
      and(
        eq(schema.agentDecisions.agentId, agentId),
        isNotNull(schema.agentDecisions.llmModel),
        gte(schema.agentDecisions.createdAt, Math.floor(Date.now() / 1000) - 3600),
      ),
    );
  return Number(r[0]?.n ?? 0);
}

export type JudgeOutcome = { ok: true; verdict: JudgeVerdict } | { ok: false; note: string };

export async function judgeEntry(agentId: string, playbook: string | null, strategy: StrategySpec, f: CandidateFeatures, rulesLine: string): Promise<JudgeOutcome> {
  const budget = env().AGENT_LLM_CALLS_PER_HOUR;
  if (budget <= 0) return { ok: false, note: "LLM judge disabled (AGENT_LLM_CALLS_PER_HOUR=0): rules only" };
  if (aiPausedUntil()) return { ok: false, note: "LLM unavailable (provider paused): rules only" };
  if ((await llmCallsLastHour(agentId)) >= budget) return { ok: false, note: `LLM budget ${budget}/h used: rules only` };
  return ask(SYSTEM, "Agent rules", "agent judge", playbook, strategy, f, rulesLine);
}

/** The judge for a Brain Pick; the caller enforces PICKS_LLM_CALLS_PER_HOUR. */
export async function judgePick(playbook: string | null, strategy: StrategySpec, f: CandidateFeatures, rulesLine: string): Promise<JudgeOutcome> {
  if (aiPausedUntil()) return { ok: false, note: "LLM unavailable (provider paused): rules only" };
  return ask(PICK_SYSTEM, "Style rules", "pick judge", playbook, strategy, f, rulesLine);
}

async function ask(
  system: string,
  rulesLabel: string,
  label: string,
  playbook: string | null,
  strategy: StrategySpec,
  f: CandidateFeatures,
  rulesLine: string,
): Promise<JudgeOutcome> {
  const user = [
    `Brain playbook:\n${(playbook ?? "(no playbook yet)").slice(0, 3_500)}`,
    `${rulesLabel}: ${strategy.summary}`,
    `Rule checks: ${rulesLine}`,
    `Candidate: ${JSON.stringify(f)}`,
  ].join("\n\n");
  try {
    const reply = await complete({ tier: "fast", system, messages: [{ role: "user", content: user }], maxTokens: 200 });
    reportAiSuccess();
    const json = reply.text.match(/\{[\s\S]*\}/)?.[0];
    const parsed = json ? Reply.safeParse(JSON.parse(json)) : null;
    if (!parsed?.success) return { ok: false, note: "LLM reply unparseable: rules only" };
    const words = parsed.data.why.trim().split(/\s+/);
    let why = words.slice(0, 30).join(" ");
    if (guardrailViolation(why)) why = "rationale withheld (wording guardrail)";
    return { ok: true, verdict: { decision: parsed.data.decision, confidence: parsed.data.confidence, why, model: modelLabel(reply) } };
  } catch (err) {
    reportAiFailure(err, label);
    return { ok: false, note: `LLM error: rules only (${err instanceof Error ? err.message.slice(0, 80) : "unknown"})` };
  }
}
