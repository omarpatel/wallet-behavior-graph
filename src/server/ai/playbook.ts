import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { brains } from "@/db/schema";
import type { BrainProfile } from "@/server/profile/types";
import {
  AiUnavailableError,
  GUARDRAILS,
  aiPausedUntil,
  complete,
  guardrailViolation,
  modelLabel,
  personaFor,
  reportAiFailure,
  reportAiSuccess,
} from "./client";
import { loadBrain, parseProfile, profileFactsSheet } from "./context";

const SECTIONS = [
  "How this wallet trades",
  "Entries",
  "Sizing",
  "Exits",
  "What's copyable and what isn't",
  "Risks to understand",
] as const;

const MULT: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };
const NUMBER_RE = /(\$)?(\d[\d,]*(?:\.\d+)?)(?:\s*([kKmMbB])(?![a-zA-Z]))?/g;

/** Every numeric value in a text, with $-suffix multipliers expanded (e.g. "$38.2K" → 38200 and 38.2). */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const base = Number(m[2].replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    out.push(base);
    if (m[3]) out.push(base * MULT[m[3].toLowerCase()]);
  }
  return out;
}

/**
 * Numbers stated in `text` that do not appear in `facts`. Small integers (≤ 10) are allowed
 * because they appear in ordinary prose ("3 sells", "one of 5"). Tolerance 1% for re-rounding.
 */
export function unsupportedNumbers(text: string, facts: string): string[] {
  const known = numbersIn(facts);
  const bad = new Set<string>();
  for (const m of text.matchAll(NUMBER_RE)) {
    const base = Number(m[2].replace(/,/g, ""));
    if (!Number.isFinite(base) || (Number.isInteger(base) && base <= 10)) continue;
    const candidates = m[3] ? [base, base * MULT[m[3].toLowerCase()]] : [base];
    const ok = candidates.some((c) => known.some((k) => Math.abs(k - c) <= Math.max(0.011 * Math.abs(k), 0.006)));
    if (!ok) bad.add(m[0].trim());
  }
  return [...bad];
}

function thinSampleNote(p: BrainProfile | null, name: string): string {
  if (!p) {
    return `## Playbook not available yet\n\n${name}'s on-chain history hasn't been profiled yet. The playbook is written once the profile is computed from the wallet's trades.`;
  }
  return `## Playbook not available yet\n\n${name} has ${p.sample.trades} trades across ${p.sample.tokens} tokens in the last ${p.windowDays} days. A playbook needs at least 20 trades and 5 tokens so the patterns aren't noise; it will be written automatically once the sample is large enough.`;
}

/** brainId → profile version whose model output failed validation in this process (don't re-spend on it). */
const failedVersion = new Map<string, number>();

/**
 * Write the markdown playbook for a brain from its BrainProfile (smart model) and save it with the
 * profile version it was built from. Skips when the stored playbook already matches the profile version.
 * Unrated (thin-sample) profiles get a short deterministic note instead of a model-written playbook.
 * When the AI provider is unavailable (or output fails validation) the previous playbook stays untouched
 * and the failure is logged once; the process-wide AI breaker defers further attempts.
 */
export async function refreshPlaybook(brainId: string): Promise<void> {
  const brain = await loadBrain(brainId);
  if (!brain) throw new Error(`refreshPlaybook: unknown brain ${brainId}`);
  if (brain.playbookMd && brain.playbookProfileVersion === brain.profileVersion) return;

  const profile = parseProfile(brain);
  const persona = personaFor(brain);
  const save = (md: string) =>
    getDb()
      .update(brains)
      .set({ playbookMd: md, playbookProfileVersion: brain.profileVersion, playbookUpdatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(brains.id, brainId));

  if (!profile?.rated) {
    await save(thinSampleNote(profile, persona.name));
    return;
  }
  if (aiPausedUntil() || failedVersion.get(brainId) === brain.profileVersion) return;

  const facts = profileFactsSheet(profile);
  const system = `${GUARDRAILS}
${persona.instructions}

Task: write the trading playbook of this wallet in markdown for people learning from its style.
Use exactly these level-2 headings, in this order: ${SECTIONS.map((s) => `"## ${s}"`).join(", ")}.
Under each heading write 2–5 short bullet points or a short paragraph.
- Every quantitative statement (percentages, dollar amounts, durations, counts, ratios, scores) must be copied from the facts sheet exactly as written there. Do not compute new numbers, averages or differences. If something isn't in the facts sheet, describe it qualitatively or say it isn't measured.
- "What's copyable and what isn't" must be built on the Copyability score and reason and on hold time / entry delay: explain which parts are habits a person can learn (discipline, sizing, exits) and which can't be replicated by following alerts (latency, block-zero entries, seconds-long holds).
- "Risks to understand" covers what the numbers show about losses, thin liquidity launches, open positions and the fact that past patterns can change.
- Describe the wallet's behaviour; never tell the reader what to buy, sell or size.
Output only the markdown, starting with the first heading.`;

  const messages: { role: "user" | "assistant"; content: string }[] = [
    { role: "user", content: `Facts sheet for ${persona.name}:\n\n${facts}` },
  ];

  for (let attempt = 0; attempt < 3; attempt++) {
    let md: string;
    let producedBy: string;
    try {
      const res = await complete({ tier: "smart", maxTokens: 2500, system, messages });
      reportAiSuccess();
      md = res.text;
      producedBy = modelLabel(res);
    } catch (err) {
      const e = reportAiFailure(err, `playbook ${brainId}`);
      if (e instanceof AiUnavailableError) return; // logged once by the breaker; old playbook kept
      throw e;
    }
    const missing = SECTIONS.filter((s) => !md.includes(`## ${s}`));
    const unsupported = unsupportedNumbers(md, facts);
    const forbidden = guardrailViolation(md);
    if (!missing.length && !unsupported.length && !forbidden) {
      await save(md);
      console.log(`[playbook] ${brainId}: written by ${producedBy} (profile v${brain.profileVersion}, attempt ${attempt + 1})`);
      return;
    }
    const problems = [
      missing.length ? `missing headings: ${missing.join(", ")}` : "",
      unsupported.length ? `numbers not in the facts sheet: ${unsupported.join(", ")} (remove them or use the exact figures from the sheet)` : "",
      forbidden ? `forbidden accusatory word "${forbidden}"` : "",
    ].filter(Boolean);
    messages.push({ role: "assistant", content: md }, { role: "user", content: `Fix these problems and output the full corrected playbook: ${problems.join("; ")}.` });
  }
  failedVersion.set(brainId, brain.profileVersion);
  console.error(`[playbook] ${brainId}: model output failed validation 3 times for profile v${brain.profileVersion}; previous playbook kept`);
}
