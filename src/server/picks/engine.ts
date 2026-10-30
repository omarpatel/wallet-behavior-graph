/**
 * The Brain Picks engine, run inside the agents runner (scripts/agents.ts) on the runner's MarketHub — no second set of
 * websockets or sweeps. It never places orders.
 *
 *  universe (2 min)  brains with ≥1 active seat or ≥1 non-stopped agent (user agents),
 *                    listed, with a tradable profile → their StrategySpec (deriveStrategy, cached per profile version)
 *  tick (5 s)        1. open picks: mark against live prices and apply the style's exit plan on paper (stepPick)
 *                    2. new picks (PICKS_ENABLED): every hub candidate × every universe brain through the same market
 *                       rules → safety rules as the agents, then the council (swarm, tracked-wallet flow, connectome
 *                       leaders; it can veto), then the optional LLM judge (PICKS_LLM_CALLS_PER_HOUR across brains);
 *                       gated by pickGate (one pick per brain + token per 24 h, PICKS_MAX_PER_BRAIN_HOUR, open cap)
 *  flush (15 s)      changed paper state of open picks → brain_picks (the SSE stream pushes them to seat holders)
 */
import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { withBusyRetry } from "@/db/retry";
import { env } from "@/lib/env";
import { PRICE_MAX_AGE_SEC } from "@/server/agents/config";
import { buildFeatures, marketChecks, momentumChange, safetyChecks, verdict, type RuleCheck } from "@/server/agents/features";
import type { MarketHub, TokenState } from "@/server/agents/feeds/hub";
import { judgePick } from "@/server/agents/judge";
import { ARCHETYPE_DEFAULTS, deriveStrategy, type TradableArchetype } from "@/server/agents/strategy";
import type { CandidateFeatures, ExitPlan, StrategySpec } from "@/server/agents/types";
import { brainLabels, buildCouncil, loadLeaders, recentFlow } from "./council";
import type { BrainProfile } from "@/server/profile/types";
import { gainPct, PICK_DEDUPE_SEC, pickGate, pickMark, pickReason, round2, stepPick, suggestedFraction, type PaperPick } from "./logic";

const nowSec = () => Math.floor(Date.now() / 1000);
const TICK_MS = 5_000;
const UNIVERSE_MS = 120_000;
const FLUSH_MS = 15_000;
/** Re-evaluate the same mint for the same brain at most this often (as the agents runner). */
const REEVAL_CURVE_SEC = 15;
const REEVAL_POOL_SEC = 60;
/** Fresh safety checks (RPC + RugCheck) per tick across all brains; results are cached per mint by the hub. */
const SAFETY_CHECKS_PER_TICK = 2;
const LEADERS_TTL_SEC = 600;

interface Style {
  brainId: string;
  profileVersion: number;
  spec: StrategySpec;
  playbook: string | null;
  label: string;
}

interface OpenPick extends PaperPick {
  id: number;
  brainId: string;
  mint: string;
  symbol: string | null;
  plan: ExitPlan;
  dirty: boolean;
}

export class PickEngine {
  private timers: NodeJS.Timeout[] = [];
  private stopping = false;
  private busy = new Set<string>();
  private inFlight = new Set<Promise<void>>();
  private readonly startedAt = nowSec();
  private styles = new Map<string, Style>();
  private open = new Map<number, OpenPick>();
  /** brainId → createdAt of its picks in the last 24 h, keyed by mint (dedupe) and as a list (hourly cap). */
  private lastOnMint = new Map<string, Map<string, number>>();
  private recent = new Map<string, number[]>();
  /** brainId → mint → last evaluation (s). */
  private memo = new Map<string, Map<string, number>>();
  private llmCalls: number[] = [];
  private leaders: { at: number; set: Set<string> } = { at: 0, set: new Set() };
  private labels = new Map<string, string>();
  readonly counters = { ticks: 0, evaluated: 0, rulePasses: 0, vetoes: 0, llmCalls: 0, llmSkips: 0, picks: 0, exits: 0, closes: 0, errors: 0 };

  constructor(
    private readonly hub: MarketHub,
    private readonly log: (msg: string) => void,
  ) {}

  async start(): Promise<void> {
    const e = env();
    this.log(`starting: PICKS_ENABLED=${e.PICKS_ENABLED}, ${e.PICKS_MAX_PER_BRAIN_HOUR}/h per brain, LLM ${e.PICKS_LLM_CALLS_PER_HOUR}/h`);
    await this.loadState();
    await this.guard("universe", () => this.refreshUniverse());
    this.every("tick", TICK_MS, () => this.tick());
    this.every("universe", UNIVERSE_MS, () => this.refreshUniverse());
    this.every("flush", FLUSH_MS, () => this.flush());
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await Promise.allSettled([...this.inFlight]);
    await this.flush().catch((err) => this.log(`final flush failed: ${errMsg(err)}`));
  }

  logStats(): void {
    const c = this.counters;
    this.log(
      `stats: ${this.styles.size} brains, ${this.open.size} open picks; ${c.ticks} ticks, ${c.evaluated} evaluations, ${c.rulePasses} rule passes, ` +
        `${c.vetoes} council vetoes, ${c.llmCalls} LLM calls (${c.llmSkips} skips), ${c.picks} picks, ${c.exits} exit steps, ${c.closes} closed, ${c.errors} errors`,
    );
  }

  private guard(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.stopping || this.busy.has(name)) return Promise.resolve();
    this.busy.add(name);
    const p = fn()
      .catch((err) => {
        this.counters.errors++;
        this.log(`${name} failed: ${errMsg(err)}`);
      })
      .finally(() => {
        this.busy.delete(name);
        this.inFlight.delete(p);
      });
    this.inFlight.add(p);
    return p;
  }

  private every(name: string, ms: number, fn: () => Promise<void>): void {
    this.timers.push(setInterval(() => void this.guard(name, fn), ms));
  }

  // ---------------------------------------------------------------- state

  private async loadState(): Promise<void> {
    const db = getDb();
    const rows = await db.select().from(schema.brainPicks).where(eq(schema.brainPicks.status, "open"));
    for (const r of rows) this.open.set(r.id, toOpen(r));
    const since = nowSec() - PICK_DEDUPE_SEC;
    const recent = await db
      .select({ brainId: schema.brainPicks.brainId, mint: schema.brainPicks.mint, createdAt: schema.brainPicks.createdAt })
      .from(schema.brainPicks)
      .where(gte(schema.brainPicks.createdAt, since));
    for (const r of recent) this.remember(r.brainId, r.mint, r.createdAt);
    this.log(`loaded ${this.open.size} open picks, ${recent.length} picks from the last 24h`);
  }

  private remember(brainId: string, mint: string, at: number): void {
    const m = this.lastOnMint.get(brainId) ?? new Map<string, number>();
    m.set(mint, Math.max(m.get(mint) ?? 0, at));
    this.lastOnMint.set(brainId, m);
    this.recent.set(brainId, [...(this.recent.get(brainId) ?? []), at]);
  }

  private async refreshUniverse(): Promise<void> {
    const db = getDb();
    const now = nowSec();
    const [seatRows, agentRows] = await Promise.all([
      db
        .selectDistinct({ brainId: schema.seats.brainId })
        .from(schema.seats)
        .where(and(gte(schema.seats.expiresAt, now), ne(schema.seats.owner, "burned"))),
      db.selectDistinct({ brainId: schema.agents.brainId }).from(schema.agents).where(ne(schema.agents.status, "stopped")),
    ]);
    const ids = [...new Set([...seatRows, ...agentRows].map((r) => r.brainId))];
    const brains = ids.length
      ? await db
          .select({
            id: schema.brains.id,
            profileJson: schema.brains.profileJson,
            profileVersion: schema.brains.profileVersion,
            playbookMd: schema.brains.playbookMd,
          })
          .from(schema.brains)
          .where(and(inArray(schema.brains.id, ids), eq(schema.brains.listed, true), sql`${schema.brains.profileJson} is not null`))
      : [];
    const next = new Map<string, Style>();
    for (const b of brains) {
      const cached = this.styles.get(b.id);
      if (cached && cached.profileVersion === b.profileVersion) {
        next.set(b.id, { ...cached, playbook: b.playbookMd });
        continue;
      }
      const d = deriveStrategy(JSON.parse(b.profileJson!) as BrainProfile, { brainId: b.id, playbook: b.playbookMd });
      if (!d.ok) continue;
      const label = ARCHETYPE_DEFAULTS[d.strategy.archetype as TradableArchetype]?.label ?? d.strategy.archetype;
      next.set(b.id, { brainId: b.id, profileVersion: b.profileVersion, spec: d.strategy, playbook: b.playbookMd, label });
    }
    const added = [...next.keys()].filter((id) => !this.styles.has(id));
    const removed = [...this.styles.keys()].filter((id) => !next.has(id));
    this.styles = next;
    if (added.length || removed.length) this.log(`universe: ${next.size} brains (${ids.length} with a seat or agent)${added.length ? `, +${added.join(",")}` : ""}${removed.length ? `, −${removed.join(",")}` : ""}`);
  }

  // ---------------------------------------------------------------- tick

  private async tick(): Promise<void> {
    this.counters.ticks++;
    const now = nowSec();
    const specs = [...this.styles.values()].map((s) => s.spec);
    const curve = specs.filter((s) => s.entry.phase !== "graduated" && (s.entry.launchpads.length === 0 || s.entry.launchpads.includes("pump.fun")));
    const generating = env().PICKS_ENABLED;
    this.hub.setInterest("picks", {
      curve: generating && curve.length > 0,
      maxCurveAgeSec: Math.min(3600, Math.max(0, ...curve.map((s) => s.entry.entryDelaySec.max))),
      pools: generating && specs.some((s) => s.entry.phase !== "curve"),
      pinned: [],
      tracked: [...new Set([...this.open.values()].map((p) => p.mint))],
    });
    await this.track(now);
    if (generating) await this.generate(now);
  }

  /** Mark open picks and run the style's exit plan on paper. */
  private async track(now: number): Promise<void> {
    for (const p of this.open.values()) {
      const t = this.hub.tokens.get(p.mint);
      const step = stepPick(p.plan, p, pickMark(t ?? null, p, this.startedAt, PRICE_MAX_AGE_SEC, now), now);
      if (!step.changed) continue;
      Object.assign(p, step.pick, { dirty: true });
      if (step.fired.length) {
        this.counters.exits += step.fired.length;
        this.log(`pick ${p.id} ${p.brainId} ${p.symbol ?? p.mint.slice(0, 6)}: ${step.fired.join("; ")}`);
      }
      if (step.closed) {
        await withBusyRetry(
          () =>
            getDb()
              .update(schema.brainPicks)
              .set({ ...paperColumns(p), status: "closed", closedAt: now, closeReason: step.closed!.reason, outcomePct: step.closed!.outcomePct, updatedAt: now })
              .where(eq(schema.brainPicks.id, p.id)),
          { label: "pick close" },
        );
        this.open.delete(p.id);
        this.counters.closes++;
        this.log(`pick ${p.id} ${p.brainId} ${p.symbol ?? p.mint.slice(0, 6)} CLOSED (${step.closed.reason}): paper outcome ${step.closed.outcomePct >= 0 ? "+" : ""}${step.closed.outcomePct}%`);
      }
    }
  }

  private async flush(): Promise<void> {
    const now = nowSec();
    for (const p of this.open.values()) {
      if (!p.dirty) continue;
      p.dirty = false;
      await withBusyRetry(
        () =>
          getDb()
            .update(schema.brainPicks)
            .set({ ...paperColumns(p), updatedAt: now })
            .where(and(eq(schema.brainPicks.id, p.id), eq(schema.brainPicks.status, "open"))),
        { label: "pick mark" },
      );
    }
  }

  // ---------------------------------------------------------------- generation

  private async generate(now: number): Promise<void> {
    if (!this.styles.size) return;
    const e = env();
    const candidates = this.hub.candidates(30, { includePinned: true });
    if (!candidates.length) return;
    let safetyBudget = SAFETY_CHECKS_PER_TICK;
    for (const [brainId, list] of this.recent) this.recent.set(brainId, list.filter((at) => now - at < 3600));
    const openByBrain = new Map<string, Set<string>>();
    for (const p of this.open.values()) openByBrain.set(p.brainId, (openByBrain.get(p.brainId) ?? new Set()).add(p.mint));

    for (const style of this.styles.values()) {
      if (this.stopping) return;
      const { brainId, spec } = style;
      const openMints = openByBrain.get(brainId) ?? new Set<string>();
      const lastOn = this.lastOnMint.get(brainId);
      const gateBase = { now, picksLastHour: this.recent.get(brainId)?.length ?? 0, openPicks: openMints.size, maxPerHour: e.PICKS_MAX_PER_BRAIN_HOUR };
      if (pickGate({ ...gateBase, lastPickOnMintAt: null, mintOpen: false })) continue; // brain-level cap reached
      const memo = this.memo.get(brainId) ?? new Map<string, number>();
      this.memo.set(brainId, memo);
      for (const [m, at] of memo) if (now - at > 3600) memo.delete(m);

      for (const t of candidates) {
        if (pickGate({ ...gateBase, lastPickOnMintAt: lastOn?.get(t.mint) ?? null, mintOpen: openMints.has(t.mint) })) continue;
        const evalAt = memo.get(t.mint);
        if (evalAt != null && now - evalAt < (t.phase === "curve" ? REEVAL_CURVE_SEC : REEVAL_POOL_SEC)) continue;
        memo.set(t.mint, now);
        this.counters.evaluated++;

        const swarm = t.swarmBrains.length;
        let f = buildFeatures(t, now, spec.entry, swarm);
        const market = verdict("market", marketChecks(spec.entry, f, momentumChange(t, spec.entry.momentum.lookbackSec || 300)));
        if (!market.pass) {
          if (market.misses.length === 1) this.hub.watchFlow(t.mint); // near miss: keep its flow numbers fresh
          continue;
        }
        if (!t.safety || now - t.safety.checkedAt >= 600) {
          if (safetyBudget-- <= 0) {
            memo.delete(t.mint); // evaluate again next tick
            continue;
          }
          await this.hub.ensureSafety(t.mint);
        }
        f = buildFeatures(t, now, spec.entry, swarm);
        const safe = verdict("safety", safetyChecks(spec.entry, f));
        if (!safe.pass) continue;
        this.counters.rulePasses++;
        if (await this.publish(style, t, f, market.checks, safe.checks, now)) {
          openMints.add(t.mint);
          gateBase.openPicks++;
          gateBase.picksLastHour++;
          break; // at most one new pick per brain per tick
        }
      }
    }
  }

  private async council(t: TokenState, styleBrainId: string, now: number) {
    if (now - this.leaders.at > LEADERS_TTL_SEC) this.leaders = { at: now, set: await loadLeaders() };
    const flow = await recentFlow(t.mint, now);
    const missing = [...t.swarmBrains, ...flow.buyers, ...flow.sellers, styleBrainId].filter((id) => !this.labels.has(id));
    if (missing.length) for (const [id, label] of await brainLabels(missing)) this.labels.set(id, label);
    return buildCouncil({ swarm: t.swarmBrains, buyers: flow.buyers, sellers: flow.sellers, leaders: this.leaders.set, styleBrainId, labels: this.labels, topStyles: [] });
  }

  /** Council → LLM judge → insert. True when a pick was published. */
  private async publish(
    style: Style,
    t: TokenState,
    f: CandidateFeatures,
    market: RuleCheck[],
    safety: RuleCheck[],
    now: number,
  ): Promise<boolean> {
    const { brainId, spec } = style;
    const council = await this.council(t, brainId, now);
    if (council.veto) {
      this.counters.vetoes++;
      return false;
    }
    const reason = pickReason(style.label, market, safety);
    let confidence = 0.5;
    let llm: { model: string; text: string } | null = null;
    const budget = env().PICKS_LLM_CALLS_PER_HOUR;
    this.llmCalls = this.llmCalls.filter((at) => now - at < 3600);
    if (budget > 0 && this.llmCalls.length < budget) {
      this.llmCalls.push(now);
      const playbook = council.judgeNote ? `${style.playbook ?? "(no playbook yet)"}\n\n${council.judgeNote}` : style.playbook;
      const j = await judgePick(playbook, spec, f, reason);
      if (j.ok) {
        this.counters.llmCalls++;
        if (j.verdict.decision === "skip") {
          this.counters.llmSkips++;
          return false;
        }
        confidence = j.verdict.confidence;
        llm = { model: j.verdict.model, text: j.verdict.why };
      }
    }
    confidence = Math.min(1, Math.max(0, confidence + council.confidence));
    const fraction = suggestedFraction(spec.sizing, confidence);
    const entry = f.priceUsd!;
    const [row] = await withBusyRetry(
      () =>
        getDb()
          .insert(schema.brainPicks)
          .values({
            brainId,
            mint: t.mint,
            symbol: t.symbol,
            createdAt: now,
            featuresJson: JSON.stringify(f),
            reason,
            chipsJson: JSON.stringify(council.chips),
            llmModel: llm?.model ?? null,
            llmText: llm?.text ?? null,
            entryMcUsd: f.mcUsd,
            entryPriceUsd: entry,
            suggestedFraction: fraction,
            exitPlanJson: JSON.stringify(spec.exit),
            peakPriceUsd: entry,
            lastPriceUsd: entry,
            lastPriceAt: t.priceAt ?? now,
            maxGainPct: 0,
            lastGainPct: 0,
            updatedAt: now,
          })
          .returning(),
      { label: "pick insert" },
    );
    this.open.set(row.id, toOpen(row));
    this.remember(brainId, t.mint, now);
    this.counters.picks++;
    this.log(
      `PICK ${row.id} ${brainId} (${style.label}) ${t.symbol ?? t.mint.slice(0, 6)} ${t.mint} at MC ${f.mcUsd != null ? `$${Math.round(f.mcUsd)}` : "?"}, size ${round2(fraction * 100)}%` +
        `${council.chips.length ? ` [${council.chips.join(", ")}]` : ""}${llm ? ` — LLM: ${llm.text}` : ""}`,
    );
    return true;
  }
}

type PickRow = typeof schema.brainPicks.$inferSelect;

function toOpen(r: PickRow): OpenPick {
  return {
    id: r.id,
    brainId: r.brainId,
    mint: r.mint,
    symbol: r.symbol,
    plan: JSON.parse(r.exitPlanJson) as ExitPlan,
    createdAt: r.createdAt,
    entryPriceUsd: r.entryPriceUsd,
    peakPriceUsd: r.peakPriceUsd,
    lastPriceUsd: r.lastPriceUsd,
    lastPriceAt: r.lastPriceAt,
    tpStepsHit: r.tpStepsHit,
    initialsOutDone: r.initialsOutDone,
    remaining: r.remaining,
    realized: r.realized,
    dirty: false,
  };
}

function paperColumns(p: OpenPick) {
  return {
    peakPriceUsd: p.peakPriceUsd,
    lastPriceUsd: p.lastPriceUsd,
    lastPriceAt: p.lastPriceAt,
    tpStepsHit: p.tpStepsHit,
    initialsOutDone: p.initialsOutDone,
    remaining: p.remaining,
    realized: p.realized,
    lastGainPct: gainPct(p.lastPriceUsd, p.entryPriceUsd),
    maxGainPct: gainPct(p.peakPriceUsd, p.entryPriceUsd),
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : String(err);
}
