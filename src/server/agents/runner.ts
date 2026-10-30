/**
 * The agents runner (scripts/agents.ts): one process drives every agent.
 *
 *  tick (3 s)   per agent, isolated: exits first (stale-price guard, dead tokens), close-all requests, then entries
 *               (market rules → safety rules → optional LLM judge → buy), recording decisions on the public tape
 *  marks (30 s) equity = cash + positions at fresh prices; 5-min equity samples; daily-loss guardian (Perp guardian.ts)
 *  funds (15 s) wallet balances (one getMultipleAccounts); on change, deposit scan + AGENT_MAX_DEPOSIT_SOL enforcement
 *  access (10 m) seat re-check: owners who lost access get their agent halted
 *
 * Kill switches: AGENTS_ENABLED=false → no orders at all; live orders additionally need AGENTS_LIVE_ENABLED=true.
 * Paused/halted agents place no new entries but their exits keep running.
 *
 * Platform agents (legacy kinds "hive" / "shadow") run through the same loop; everything that differs for
 * them (kill switches, gas reserve, cross-brain council) comes from RunnerHooks. Without hooks they place no orders.
 */
import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { withBusyRetry } from "@/db/retry";
import { env } from "@/lib/env";
import { hasBrainAccess } from "@/server/access";
import { agentRpcUrl, LIVE_FEE_RESERVE_LAMPORTS, maxDepositLamports, PRICE_MAX_AGE_SEC } from "./config";
import { type AgentRow, executeBuy, executeSell, type Mark, type PositionRow, reconcileOrders } from "./execute";
import { DEAD_AFTER_SEC, evaluateExit } from "./exits";
import { buildFeatures, describeVerdict, marketChecks, momentumChange, safetyChecks, verdict, type EntryVerdict } from "./features";
import { MarketHub, type TokenState } from "./feeds/hub";
import { scanDeposits } from "./funds";
import { judgeEntry } from "./judge";
import { getLamports } from "./solana";
import { sol } from "./strategy";
import type { CandidateFeatures, DecisionContext, ExitPlan, StrategySpec } from "./types";

const nowSec = () => Math.floor(Date.now() / 1000);
const TICK_MS = 3_000;
const MARK_MS = 30_000;
const FUNDS_MS = 15_000;
const ACCESS_MS = 10 * 60_000;
const STATS_MS = 60_000;
const RECONCILE_MS = 60_000;
/** Re-evaluate the same mint for the same agent at most this often. */
const REEVAL_CURVE_SEC = 15;
const REEVAL_POOL_SEC = 60;
/** Record a near miss again only when its reasons change or after this long. */
const NEAR_MISS_REPEAT_SEC = 600;
/** Far misses: keep 1 in N on the tape, at most once per mint per 30 min. */
const FAR_MISS_SAMPLE = 30;
const FAR_MISS_REPEAT_SEC = 1800;
/** Don't re-enter a mint within this long of the last position in it. */
const REENTRY_COOLDOWN_SEC = 1800;
const SAFETY_CHECKS_PER_TICK = 2;

interface Memo {
  evalAt: number;
  recordedAt: number;
  recordedKey: string;
}

/** Cross-brain knowledge for one candidate that passed the rules (the cross-brain council, src/server/picks/council.ts). */
export interface Council {
  /** Short tape chips, e.g. "swarm ×4", "2 connectome leaders in". */
  chips: string[];
  /** Appended to the playbook the LLM judge reads. */
  judgeNote: string;
  /** Added to the entry confidence (sizing), −1…+1 before clamping to 0…1. */
  confidence: number;
  /** Skip the entry with this reason. */
  veto: string | null;
  /** Built from seat-gated live data (swarms, tracked-wallet buys): held back from the public for PUBLIC_DELAY_SEC. */
  gated: boolean;
}

/** Policy for platform agents (kind ≠ "user"); user agents never consult it. */
export interface RunnerHooks {
  canTrade(a: AgentRow): boolean;
  /** SOL a live platform agent never spends on entries (gas for exits and fee claims). */
  reserveLamports(a: AgentRow): number;
  /** null = no council for this agent (shadows trade the bare style). */
  council(a: AgentRow, t: TokenState, f: CandidateFeatures): Promise<Council | null>;
}

export class AgentRunner {
  readonly hub: MarketHub;
  private timers: NodeJS.Timeout[] = [];
  private stopping = false;
  private inFlight = new Set<Promise<void>>();
  private busy = new Set<string>();
  private memo = new Map<string, Map<string, Memo>>();
  private farCounter = new Map<string, number>();
  private lastAccess = new Map<string, number>();
  private playbooks = new Map<string, { at: number; md: string | null }>();
  readonly counters = { ticks: 0, evaluated: 0, decisions: 0, buys: 0, sells: 0, nearMisses: 0, llmCalls: 0, errors: 0 };
  private hooks: RunnerHooks | null = null;

  constructor(private readonly log: (msg: string) => void) {
    this.hub = new MarketHub(agentRpcUrl(), env().PUMPPORTAL_WS_URL, log);
  }

  /** Install the platform-agent policy (needs this runner's hub first). */
  setHooks(hooks: RunnerHooks): void {
    this.hooks = hooks;
  }

  private canTrade(a: AgentRow): boolean {
    const e = env();
    if (a.kind !== "user") return this.hooks?.canTrade(a) ?? false;
    return e.AGENTS_ENABLED && (a.mode === "paper" || e.AGENTS_LIVE_ENABLED);
  }

  async start(): Promise<void> {
    await reconcileOrders(this.log).catch((err) => this.log(`reconcile failed: ${errMsg(err)}`));
    this.hub.start();
    const every = (name: string, ms: number, fn: () => Promise<void>, immediate = true) => {
      const run = () => {
        if (this.stopping || this.busy.has(name)) return;
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
      };
      if (immediate) run();
      this.timers.push(setInterval(run, ms));
    };
    every("tick", TICK_MS, () => this.tick());
    every("marks", MARK_MS, () => this.markAll());
    every("funds", FUNDS_MS, () => this.pollFunds());
    every("reconcile", RECONCILE_MS, () => reconcileOrders(this.log), false);
    every("stats", STATS_MS, async () => this.logStats(), false);
  }

  /** Graceful: stop scheduling, let in-flight work (an order mid-confirmation) finish, then close the feeds. */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await Promise.allSettled([...this.inFlight]);
    this.hub.stop();
  }

  logStats(): void {
    const s = this.hub.stats();
    const pp = s.pumpportal;
    this.log(
      `feeds: pumpportal ${pp.connected ? `up ${Math.round(pp.upSec / 60)}m` : "DOWN"} (${pp.connects} connects, ${pp.reconnects} reconnects, ${pp.messages} msgs, ${pp.creates} new tokens, ${pp.migrations} migrations); ` +
        `tokens ${s.tokens} (${s.curves} curves, ${s.pools} pools, ${s.freshPrices} fresh prices); curve sweeps ${s.curveSweeps} (${s.curveAccounts} accounts), ` +
        `dex sweeps ${s.dexSweeps}, jupiter lists ${s.listPolls}, swarm polls ${s.swarmPolls}, rpc calls ${s.rpcCalls}; SOL $${s.solUsd?.toFixed(2) ?? "?"}` +
        (Object.keys(s.errors).length ? `; feed errors ${JSON.stringify(s.errors)} last ${JSON.stringify(s.lastError)}` : ""),
    );
    const c = this.counters;
    this.log(`agents: ${c.ticks} ticks, ${c.evaluated} evaluations, ${c.decisions} decisions recorded (${c.nearMisses} near misses), ${c.llmCalls} LLM calls, ${c.buys} buys, ${c.sells} sells, ${c.errors} errors`);
  }

  // ---------------------------------------------------------------- tick

  private async loadAgents(): Promise<AgentRow[]> {
    return getDb().select().from(schema.agents).where(ne(schema.agents.status, "stopped"));
  }

  private async tick(): Promise<void> {
    this.counters.ticks++;
    const agents = await this.loadAgents();
    const open = agents.length
      ? await getDb()
          .select()
          .from(schema.agentPositions)
          .where(and(inArray(schema.agentPositions.agentId, agents.map((a) => a.id)), eq(schema.agentPositions.status, "open")))
      : [];
    const hunting = agents.filter((a) => a.status === "running");
    const strategies = new Map(agents.map((a) => [a.id, JSON.parse(a.strategyJson) as StrategySpec]));
    const curveHunters = hunting.filter((a) => {
      const en = strategies.get(a.id)!.entry;
      return en.phase !== "graduated" && (en.launchpads.length === 0 || en.launchpads.includes("pump.fun"));
    });
    this.hub.setInterest("agents", {
      curve: curveHunters.length > 0,
      maxCurveAgeSec: Math.min(3600, Math.max(0, ...curveHunters.map((a) => strategies.get(a.id)!.entry.entryDelaySec.max))),
      pools: hunting.some((a) => strategies.get(a.id)!.entry.phase !== "curve"),
      pinned: [...new Set(open.map((p) => p.mint))],
    });
    for (const a of agents) {
      if (this.stopping) return;
      const canTrade = this.canTrade(a);
      try {
        const mine = open.filter((p) => p.agentId === a.id);
        await this.manageExits(a, strategies.get(a.id)!, mine, canTrade);
        if (canTrade && a.status === "running" && !a.closeAllRequestedAt) await this.hunt(a, strategies.get(a.id)!, mine);
      } catch (err) {
        this.counters.errors++;
        this.log(`${a.id} tick failed: ${errMsg(err)}`);
      }
    }
  }

  private mark(t: TokenState | undefined): Mark {
    return { priceUsd: t?.priceUsd ?? null, mcUsd: t?.mcUsd ?? null, solUsd: this.hub.solUsd(), phase: t?.phase ?? "unknown" };
  }

  private async manageExits(a: AgentRow, s: StrategySpec, positions: PositionRow[], canTrade: boolean): Promise<void> {
    const now = nowSec();
    const db = getDb();
    for (const p of positions) {
      const t = this.hub.tokens.get(p.mint);
      const fresh = t?.priceUsd != null && t.priceAt != null && now - t.priceAt <= PRICE_MAX_AGE_SEC;
      if (fresh && (t.priceUsd !== p.lastPriceUsd || t.priceAt !== p.lastPriceAt)) {
        const peak = Math.max(p.peakPriceUsd ?? 0, t.priceUsd!);
        await db
          .update(schema.agentPositions)
          .set({ lastPriceUsd: t.priceUsd, lastPriceAt: t.priceAt, peakPriceUsd: peak })
          .where(and(eq(schema.agentPositions.agentId, a.id), eq(schema.agentPositions.mint, p.mint), eq(schema.agentPositions.openedAt, p.openedAt)));
        p.lastPriceUsd = t.priceUsd;
        p.lastPriceAt = t.priceAt;
        p.peakPriceUsd = peak;
      }
      if (!canTrade) continue;
      const plan = JSON.parse(p.exitPlanJson) as ExitPlan;
      const closeAll = a.closeAllRequestedAt != null;
      const action = closeAll
        ? { fraction: 1, tag: `closeall${a.closeAllRequestedAt}`, reason: "close-all requested by owner" }
        : evaluateExit(plan, p, { priceUsd: p.lastPriceUsd, at: p.lastPriceAt }, now);
      if (!action) continue;
      const qty = BigInt(p.qtyRaw);
      const sell = action.fraction >= 0.999 ? qty : (qty * BigInt(Math.round(action.fraction * 10_000))) / 10_000n;
      const res = await executeSell(a, p, {
        qtyRaw: sell,
        reason: action.reason,
        tag: action.tag,
        slippageBps: action.tag === "dead" || action.tag === "sl" ? Math.max(s.risk.slippageBps, 2_000) : s.risk.slippageBps,
        priorityFeeLamports: s.risk.priorityFeeLamports,
        mark: this.mark(t),
        advanceTp: action.tag.startsWith("tp"),
        setInitialsOut: action.tag === "io",
      });
      if (!res?.ran) continue;
      const o = res.order;
      if (o.status === "filled") this.counters.sells++;
      await this.recordDecision(a, p.mint, "sell", `${action.reason} → ${o.status === "filled" ? `sold, received ${sol(o.lamports ?? 0)}` : `order failed: ${o.error ?? "?"}`}`, sellFeatures(p, t, now), null);
      this.log(`${a.id} SELL ${p.symbol ?? p.mint.slice(0, 6)} ${action.reason}: ${o.status}${o.status === "filled" ? ` ${sol(o.lamports ?? 0)}` : ` (${o.error})`}`);
    }
    if (a.closeAllRequestedAt != null && canTrade) {
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)` })
        .from(schema.agentPositions)
        .where(and(eq(schema.agentPositions.agentId, a.id), eq(schema.agentPositions.status, "open")));
      if (Number(n) === 0) await db.update(schema.agents).set({ closeAllRequestedAt: null }).where(eq(schema.agents.id, a.id));
    }
  }

  // ---------------------------------------------------------------- entries

  private async hunt(a: AgentRow, s: StrategySpec, positions: PositionRow[]): Promise<void> {
    if (positions.length >= s.sizing.maxOpenPositions) return;
    const now = nowSec();
    const db = getDb();
    const [{ n: tradesLastHour }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.agentOrders)
      .where(and(eq(schema.agentOrders.agentId, a.id), eq(schema.agentOrders.side, "buy"), gte(schema.agentOrders.createdAt, now - 3600)));
    if (Number(tradesLastHour) >= s.risk.maxTradesPerHour) return;
    const reserve = a.kind === "user" ? LIVE_FEE_RESERVE_LAMPORTS : (this.hooks?.reserveLamports(a) ?? LIVE_FEE_RESERVE_LAMPORTS);
    const free = a.mode === "paper" ? a.paperCashLamports : Math.max(0, (a.chainLamports ?? 0) - reserve);
    if (Math.min(free * s.sizing.baseFraction, s.sizing.maxPositionLamports) < s.sizing.minTradeLamports) return;

    const held = new Set(positions.map((p) => p.mint));
    const memo = this.memo.get(a.id) ?? new Map<string, Memo>();
    this.memo.set(a.id, memo);
    for (const [m, v] of memo) if (now - Math.max(v.evalAt, v.recordedAt) > 2 * FAR_MISS_REPEAT_SEC) memo.delete(m);
    const visibleSwarm = await this.visibleSwarmBrains(a);
    let safetyBudget = SAFETY_CHECKS_PER_TICK;

    for (const t of this.hub.candidates()) {
      if (held.has(t.mint)) continue;
      const m = memo.get(t.mint);
      const reeval = t.phase === "curve" ? REEVAL_CURVE_SEC : REEVAL_POOL_SEC;
      if (m && now - m.evalAt < reeval) continue;
      const entry = { evalAt: now, recordedAt: m?.recordedAt ?? 0, recordedKey: m?.recordedKey ?? "" };
      memo.set(t.mint, entry);
      this.counters.evaluated++;

      const swarm = visibleSwarm === "all" ? t.swarmBrains.length : t.swarmBrains.filter((b) => visibleSwarm.has(b)).length;
      let f = buildFeatures(t, now, s.entry, swarm);
      const market = verdict("market", marketChecks(s.entry, f, momentumChange(t, s.entry.momentum.lookbackSec || 300)));
      if (!market.pass) {
        if (market.misses.length === 1) {
          this.hub.watchFlow(t.mint); // near miss: keep its flow numbers fresh
          await this.nearMiss(a, entry, f, describeVerdict(market));
        } else await this.farMiss(a, entry, f, market);
        continue;
      }
      const recent = await db
        .select({ openedAt: schema.agentPositions.openedAt })
        .from(schema.agentPositions)
        .where(and(eq(schema.agentPositions.agentId, a.id), eq(schema.agentPositions.mint, t.mint), gte(schema.agentPositions.openedAt, now - REENTRY_COOLDOWN_SEC)))
        .limit(1);
      if (recent.length) continue; // re-entry cooldown
      if (safetyBudget-- <= 0) {
        entry.evalAt = 0; // evaluate again next tick
        continue;
      }
      const safety = await this.hub.ensureSafety(t.mint);
      f = buildFeatures(t, now, s.entry, swarm);
      const safe = verdict("safety", safetyChecks(s.entry, f));
      if (!safe.pass) {
        await this.nearMiss(a, entry, f, describeVerdict(safe));
        continue;
      }
      const rulesLine = `${describeVerdict(market)}; ${safe.checks.map((c) => c.detail).join("; ")}`;
      const council = a.kind === "user" ? null : ((await this.hooks?.council(a, t, f)) ?? null);
      if (council?.veto) {
        if (!(entry.recordedKey === "council-veto" && now - entry.recordedAt < NEAR_MISS_REPEAT_SEC)) {
          await this.recordDecision(a, t.mint, "skip", `council veto (rules passed): ${council.veto}`, f, null, council);
          entry.recordedAt = now;
          entry.recordedKey = "council-veto";
          this.counters.nearMisses++;
        }
        continue;
      }
      let confidence = 0.5;
      let llmModel: string | null = null;
      let llmText: string | null = null;
      let note = "";
      if (a.useLlm) {
        const playbook = await this.playbook(a.brainId);
        const j = await judgeEntry(a.id, council?.judgeNote ? `${playbook ?? "(no playbook yet)"}\n\n${council.judgeNote}` : playbook, s, f, rulesLine);
        if (j.ok) {
          this.counters.llmCalls++;
          llmModel = j.verdict.model;
          llmText = j.verdict.why;
          confidence = j.verdict.confidence;
          if (j.verdict.decision === "skip") {
            await this.recordDecision(a, t.mint, "skip", `LLM judge skip (rules passed): ${rulesLine}`, f, { model: llmModel, text: llmText }, council);
            entry.recordedAt = now;
            entry.recordedKey = "llm-skip";
            this.counters.nearMisses++;
            continue;
          }
        } else note = ` [${j.note}]`;
      }

      if (council) confidence = Math.min(1, Math.max(0, confidence + council.confidence));
      const fraction = s.sizing.style === "fixed" ? s.sizing.baseFraction : s.sizing.baseFraction + (s.sizing.maxFraction - s.sizing.baseFraction) * confidence;
      const lamports = Math.floor(Math.min(free * fraction, s.sizing.maxPositionLamports));
      if (lamports < s.sizing.minTradeLamports) return;
      const decisionId = await this.recordDecision(
        a,
        t.mint,
        "buy",
        `${rulesLine}; size ${sol(lamports)} (${Math.round(fraction * 100)}% of free SOL)${note}`,
        f,
        llmModel ? { model: llmModel, text: llmText } : null,
        council,
      );
      entry.recordedAt = now;
      entry.recordedKey = "buy";
      const res = await executeBuy(a, {
        mint: t.mint,
        symbol: t.symbol,
        decimals: safety?.decimals ?? 6,
        lamports,
        decisionId,
        slippageBps: s.risk.slippageBps,
        priorityFeeLamports: s.risk.priorityFeeLamports,
        exitPlan: s.exit,
        mark: this.mark(t),
        key: `buy:${t.mint}:${decisionId}`,
      });
      if (res?.order.status === "filled") this.counters.buys++;
      this.log(
        `${a.id} BUY ${t.symbol ?? t.mint.slice(0, 6)} ${sol(lamports)} at MC ${f.mcUsd != null ? `$${Math.round(f.mcUsd)}` : "?"}: ${res?.order.status ?? "duplicate"}${res?.order.error ? ` (${res.order.error})` : ""}${llmText ? ` — LLM: ${llmText}` : ""}`,
      );
      return; // one entry per agent per tick
    }
  }

  private async nearMiss(a: AgentRow, entry: Memo, f: CandidateFeatures, reason: string): Promise<void> {
    if (a.kind === "shadow") return; // shadow agents only score styles: their fills are what matters
    const key = reason.replace(/[\d.$%+−-]+/g, "#");
    const now = nowSec();
    if (entry.recordedKey === key && now - entry.recordedAt < NEAR_MISS_REPEAT_SEC) return;
    await this.recordDecision(a, f.mint, "skip", `near miss — ${reason}`, f, null);
    entry.recordedAt = now;
    entry.recordedKey = key;
    this.counters.nearMisses++;
  }

  private async farMiss(a: AgentRow, entry: Memo, f: CandidateFeatures, v: EntryVerdict): Promise<void> {
    if (a.kind === "shadow") return;
    const now = nowSec();
    const c = (this.farCounter.get(a.id) ?? 0) + 1;
    this.farCounter.set(a.id, c);
    if (c % FAR_MISS_SAMPLE !== 0 || now - entry.recordedAt < FAR_MISS_REPEAT_SEC) return;
    await this.recordDecision(a, f.mint, "skip", `${describeVerdict(v)} (sampled 1 in ${FAR_MISS_SAMPLE} far misses)`, f, null);
    entry.recordedAt = now;
    entry.recordedKey = "far";
  }

  private async recordDecision(
    a: AgentRow,
    mint: string,
    action: "buy" | "sell" | "skip",
    reason: string,
    f: CandidateFeatures,
    llm: { model: string; text: string | null } | null,
    council: Council | null = null,
  ): Promise<number> {
    const context: DecisionContext | null = a.kind === "user" ? null : { styleBrainId: a.brainId, chips: council?.chips ?? [], gated: council?.gated ?? false };
    const [row] = await withBusyRetry(
      () =>
        getDb()
          .insert(schema.agentDecisions)
          .values({
            agentId: a.id,
            mint,
            action,
            reason: reason.slice(0, 1_000),
            featuresJson: JSON.stringify(f),
            llmModel: llm?.model ?? null,
            llmText: llm?.text ?? null,
            contextJson: context ? JSON.stringify(context) : null,
          })
          .returning({ id: schema.agentDecisions.id }),
      { label: "agent decision" },
    );
    this.counters.decisions++;
    return row.id;
  }

  private async playbook(brainId: string): Promise<string | null> {
    const c = this.playbooks.get(brainId);
    if (c && nowSec() - c.at < 600) return c.md;
    const r = await getDb().select({ md: schema.brains.playbookMd }).from(schema.brains).where(eq(schema.brains.id, brainId));
    const md = r[0]?.md ?? null;
    this.playbooks.set(brainId, { at: nowSec(), md });
    return md;
  }

  /**
   * Swarms count for an agent only when its owner could see them live (seat on a member brain, or admin). Platform
   * agents see every swarm; their public tape holds swarm-informed rows back like the public swarm feed.
   */
  private async visibleSwarmBrains(a: AgentRow): Promise<"all" | Set<string>> {
    if (a.kind !== "user" || env().ADMIN_WALLETS.includes(a.owner)) return "all";
    const rows = await getDb()
      .select({ brainId: schema.seats.brainId })
      .from(schema.seats)
      .where(and(eq(schema.seats.owner, a.owner), gte(schema.seats.expiresAt, nowSec())));
    return new Set([...rows.map((r) => r.brainId), a.brainId]);
  }

  // ---------------------------------------------------------------- marks, guardian, funds, access

  private async markAll(): Promise<void> {
    const now = nowSec();
    const solUsd = this.hub.solUsd();
    if (solUsd == null) return;
    const db = getDb();
    for (const a of await this.loadAgents()) {
      try {
        const positions = await db
          .select()
          .from(schema.agentPositions)
          .where(and(eq(schema.agentPositions.agentId, a.id), eq(schema.agentPositions.status, "open")));
        let value = 0;
        for (const p of positions) {
          if (p.lastPriceUsd == null || p.lastPriceAt == null || now - p.lastPriceAt >= DEAD_AFTER_SEC) continue; // dead / unpriced = 0
          value += Math.round(((Number(p.qtyRaw) / 10 ** p.decimals) * p.lastPriceUsd * 1e9) / solUsd);
        }
        const cash = a.mode === "paper" ? a.paperCashLamports : (a.chainLamports ?? 0);
        const equity = cash + value;
        const day = new Date(now * 1000).toISOString().slice(0, 10);
        const set: Partial<typeof schema.agents.$inferInsert> = { equityLamports: equity, markedAt: now };
        if (a.dayKey !== day || a.dayStartEquityLamports == null) {
          set.dayKey = day;
          set.dayStartEquityLamports = equity;
        } else if (a.status === "running") {
          const s = JSON.parse(a.strategyJson) as StrategySpec;
          const flows = a.mode === "live" ? await this.flowsSince(a.id, Date.parse(`${day}T00:00:00Z`) / 1000) : 0;
          const loss = a.dayStartEquityLamports + flows - equity;
          if (loss >= s.risk.dailyLossLimitLamports) {
            set.status = "halted";
            set.haltedReason = `Daily loss ${sol(loss)} reached the ${sol(s.risk.dailyLossLimitLamports)} limit (${day} UTC). Exits keep running; resume to re-arm.`;
            this.log(`${a.id} HALTED: ${set.haltedReason}`);
          }
        }
        await withBusyRetry(() => db.update(schema.agents).set(set).where(eq(schema.agents.id, a.id)), { label: "agent mark" });
        const bucket = Math.floor(now / 300) * 300;
        await db.insert(schema.agentEquity).values({ agentId: a.id, t: bucket, equityLamports: equity }).onConflictDoUpdate({
          target: [schema.agentEquity.agentId, schema.agentEquity.t],
          set: { equityLamports: equity },
        });
        if (now - (this.lastAccess.get(a.id) ?? 0) >= ACCESS_MS / 1000) await this.checkAccess(a);
      } catch (err) {
        this.counters.errors++;
        this.log(`${a.id} mark failed: ${errMsg(err)}`);
      }
    }
  }

  /** External SOL flows (deposits and fee claims in, withdrawals out) since `since`: not trading PnL. */
  private async flowsSince(agentId: string, since: number): Promise<number> {
    const r = await getDb()
      .select({
        net: sql<number>`coalesce(sum(case when ${schema.agentLedger.kind} in ('deposit', 'fee_claim') then ${schema.agentLedger.amountLamports} when ${schema.agentLedger.kind} = 'withdraw' then -${schema.agentLedger.amountLamports} else 0 end), 0)`,
      })
      .from(schema.agentLedger)
      .where(and(eq(schema.agentLedger.agentId, agentId), gte(schema.agentLedger.createdAt, since)));
    return Number(r[0]?.net ?? 0);
  }

  private async checkAccess(a: AgentRow): Promise<void> {
    this.lastAccess.set(a.id, nowSec());
    if (a.status !== "running" || a.kind !== "user") return; // platform agents need no seat
    const access = await hasBrainAccess(a.owner, a.brainId);
    if (access.ok) return;
    await getDb()
      .update(schema.agents)
      .set({ status: "halted", haltedReason: `Owner no longer has access to this brain (${access.reason}). Renew the seat to resume.`, updatedAt: nowSec() })
      .where(eq(schema.agents.id, a.id));
    this.log(`${a.id} HALTED: owner lost access (${access.reason})`);
  }

  private async pollFunds(): Promise<void> {
    const agents = await this.loadAgents();
    if (!agents.length) return;
    const balances = await getLamports(agents.map((a) => a.walletPubkey));
    for (const a of agents) {
      const bal = balances.get(a.walletPubkey) ?? 0;
      if (bal === a.chainLamports) continue;
      try {
        if (bal > (a.chainLamports ?? 0)) await scanDeposits(a, this.log, a.kind === "user" ? maxDepositLamports() : null);
        await getDb().update(schema.agents).set({ chainLamports: bal }).where(eq(schema.agents.id, a.id));
      } catch (err) {
        this.log(`${a.id} funds poll failed: ${errMsg(err)}`);
      }
    }
  }
}

function sellFeatures(p: PositionRow, t: TokenState | undefined, now: number): CandidateFeatures {
  return {
    mint: p.mint,
    symbol: p.symbol ?? t?.symbol ?? null,
    name: t?.name ?? null,
    launchpad: t?.launchpad ?? null,
    phase: t?.phase ?? "unknown",
    ageSec: t?.createdAt != null ? now - t.createdAt : null,
    mcUsd: t?.mcUsd ?? null,
    priceUsd: p.lastPriceUsd,
    liquidityUsd: t?.liquidityUsd ?? null,
    change5mPct: t?.window.changePct(300) ?? null,
    change1hPct: t?.window.changePct(3600) ?? null,
    buys5m: t?.buys5m ?? null,
    sells5m: t?.sells5m ?? null,
    rugScore: t?.safety?.rugScore ?? null,
    mintRevoked: t?.safety?.mintRevoked ?? null,
    freezeRevoked: t?.safety?.freezeRevoked ?? null,
    topHoldersPct: t?.safety?.topHoldersPct ?? null,
    swarmMembers: 0,
    source: "position",
    netInflowSol: null,
    curveProgressPct: t?.curveProgressPct ?? null,
    priceAgeSec: p.lastPriceAt != null ? now - p.lastPriceAt : null,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : String(err);
}
