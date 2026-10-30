/**
 * MarketHub: the agents' live view of the memecoin market, built only from real mainnet feeds.
 *
 *  - discovery: PumpPortal websocket (new pump.fun/bonk tokens, migrations), Jupiter Tokens v2 lists (recent,
 *    toptrending/toptraded), Wallet Behavior Graph swarms (DB), plus every token an agent holds (pinned)
 *  - curve prices + flow: pump.fun bonding-curve accounts read on-chain in batches (getMultipleAccounts, Helius RPC)
 *  - pool prices + flow: DexScreener tokens/v1 (price, liquidity, MC, 5m buys/sells, 5m/1h change)
 *  - SOL/USD: Binance public ticker
 *
 * Each token keeps a RollingWindow of price (and curve reserve) samples; derived momentum/inflow is null until the
 * window covers the lookback (unknown is never zero). Sweeps run only while some consumer is interested: the agents
 * runner and the Brain Picks engine each declare their interest (setInterest), and the hub serves the union.
 */
import { and, gt } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { fetchJson, jsonRpc, RateLimiter } from "@/server/ingest/http";
import { SWARM_ACTIVE_SEC } from "@/server/signals/types";
import { jupTokenList, type JupListToken } from "../jupiter";
import { curvePriceSol, curveProgress, curveSupply, decodeBondingCurve } from "./curve";
import { fetchDexSnapshots } from "./dexscreener";
import { PumpPortalFeed } from "./pumpportal";
import { bondingCurvePda, checkSafety, type SafetyInfo } from "./safety";
import { RollingWindow } from "./window";

export interface TokenState {
  mint: string;
  symbol: string | null;
  name: string | null;
  launchpad: string | null;
  phase: "curve" | "graduated" | "unknown";
  createdAt: number | null;
  firstSeenAt: number;
  sources: Set<string>;
  /** First feed that surfaced the token (for the tape). */
  source: string;
  bondingCurve: string | null;
  curveProgressPct: number | null;
  pairAddress: string | null;
  supply: number | null; // whole tokens
  priceUsd: number | null;
  priceAt: number | null;
  mcUsd: number | null;
  liquidityUsd: number | null;
  buys5m: number | null;
  sells5m: number | null;
  providerChange5m: number | null;
  providerChange1h: number | null;
  statsAt: number | null;
  window: RollingWindow;
  safety: SafetyInfo | null;
  /** Jupiter audit flags (cheap first pass; on-chain check replaces them). */
  jupAudit: { mintRevoked: boolean | null; freezeRevoked: boolean | null; topHoldersPct: number | null } | null;
  /** brainIds in an active swarm on this mint. */
  swarmBrains: string[];
  lastInterestAt: number;
}

export interface HubInterest {
  /** Some consumer hunts pump.fun curve tokens; with the oldest age (s) any of them would still enter. */
  curve: boolean;
  maxCurveAgeSec: number;
  /** Some consumer hunts pool-traded tokens. */
  pools: boolean;
  /** Mints agents hold: always priced, and not offered by candidates() (unless includePinned). */
  pinned: string[];
  /** Mints tracked on paper (open Brain Picks): always priced, still offered as candidates. */
  tracked?: string[];
}

const nowSec = () => Math.floor(Date.now() / 1000);
const CURVE_SWEEP_MS = 4_000;
const DEX_SWEEP_MS = 10_000;
const LIST_EVERY_MS = 20_000;
const SWARM_EVERY_MS = 15_000;
const SOLUSD_EVERY_MS = 20_000;
const MAX_CURVES = 240;
const MAX_POOLS = 150;
/** Curve tokens with no reserve change for this long (and older than 2 min) are dropped. */
const CURVE_IDLE_SEC = 180;
const POOL_INTEREST_TTL_SEC = 20 * 60;
const LISTS = ["recent", "toptrending/5m", "toptraded/5m", "toptrending/1h"];

export class MarketHub {
  readonly tokens = new Map<string, TokenState>();
  readonly pumpportal: PumpPortalFeed;
  /** Union of every consumer's interest. */
  private interest: HubInterest & { tracked: string[] } = { curve: false, maxCurveAgeSec: 0, pools: false, pinned: [], tracked: [] };
  private interests = new Map<string, HubInterest>();
  /** pinned ∪ tracked: priced first, never evicted. */
  private keep = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private busy = new Set<string>();
  private listIdx = 0;
  private sol: { usd: number; at: number } | null = null;
  private readonly rpcLimiter = new RateLimiter(8, 1_000);
  readonly counters = {
    curveSweeps: 0,
    curveAccounts: 0,
    rpcCalls: 0,
    dexSweeps: 0,
    dexTokens: 0,
    listPolls: 0,
    swarmPolls: 0,
    errors: {} as Record<string, number>,
    lastError: {} as Record<string, string>,
  };

  constructor(
    private readonly rpcUrl: string,
    pumpPortalUrl: string,
    private readonly log: (msg: string) => void,
  ) {
    this.pumpportal = new PumpPortalFeed(pumpPortalUrl, {
      log,
      onCreate: (c) => {
        if (!this.interest.curve || c.pool !== "pump") return; // only pump.fun curves can be swept on-chain
        const t = this.upsert(c.mint, "pumpportal:new");
        t.symbol ??= c.symbol;
        t.name ??= c.name;
        t.launchpad = "pump.fun";
        t.phase = "curve";
        t.createdAt ??= c.at;
        t.bondingCurve = c.bondingCurveKey ?? bondingCurvePda(c.mint);
        this.trimCurves();
      },
      onMigration: (m) => {
        const t = this.tokens.get(m.mint) ?? (this.interest.pools ? this.upsert(m.mint, "pumpportal:migration") : null);
        if (!t) return;
        t.sources.add("pumpportal:migration");
        t.phase = "graduated";
        t.bondingCurve = null;
        t.launchpad ??= "pump.fun";
        t.lastInterestAt = nowSec();
      },
    });
  }

  start(): void {
    this.pumpportal.start();
    const every = (name: string, ms: number, fn: () => Promise<void>) => {
      const run = async () => {
        if (this.busy.has(name)) return;
        this.busy.add(name);
        try {
          await fn();
        } catch (err) {
          this.counters.errors[name] = (this.counters.errors[name] ?? 0) + 1;
          this.counters.lastError[name] = err instanceof Error ? err.message.slice(0, 200) : String(err);
        } finally {
          this.busy.delete(name);
        }
      };
      void run();
      this.timers.push(setInterval(run, ms));
    };
    every("solusd", SOLUSD_EVERY_MS, () => this.refreshSolUsd());
    every("curves", CURVE_SWEEP_MS, () => this.sweepCurves());
    every("pools", DEX_SWEEP_MS, () => this.sweepPools());
    every("lists", LIST_EVERY_MS, () => this.pollLists());
    every("swarms", SWARM_EVERY_MS, () => this.pollSwarms());
  }

  stop(): void {
    this.pumpportal.stop();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Declare (replace) one consumer's interest, e.g. "agents" or "picks". */
  setInterest(consumer: string, i: HubInterest): void {
    this.interests.set(consumer, i);
    const all = [...this.interests.values()];
    const curves = all.filter((x) => x.curve);
    this.interest = {
      curve: curves.length > 0,
      maxCurveAgeSec: Math.max(0, ...curves.map((x) => x.maxCurveAgeSec)),
      pools: all.some((x) => x.pools),
      pinned: [...new Set(all.flatMap((x) => x.pinned))],
      tracked: [...new Set(all.flatMap((x) => x.tracked ?? []))],
    };
    this.keep = new Set([...this.interest.pinned, ...this.interest.tracked]);
    const now = nowSec();
    for (const m of this.keep) {
      const t = this.tokens.get(m) ?? this.upsert(m, "position");
      t.lastInterestAt = now;
      if (t.phase === "unknown" && t.bondingCurve == null && m.endsWith("pump")) t.bondingCurve = bondingCurvePda(m);
    }
  }

  solUsd(): number | null {
    return this.sol && nowSec() - this.sol.at < 600 ? this.sol.usd : null;
  }

  /** Pool tokens get DexScreener flow counts only while someone is looking at them. */
  watchFlow(mint: string): void {
    const t = this.tokens.get(mint);
    if (t) t.lastInterestAt = nowSec();
  }

  /** Tokens with a price no older than `maxAgeSec` (agent-held mints excluded unless includePinned). */
  candidates(maxAgeSec = 30, opts: { includePinned?: boolean } = {}): TokenState[] {
    const now = nowSec();
    const pinned = new Set(opts.includePinned ? [] : this.interest.pinned);
    return [...this.tokens.values()].filter((t) => t.priceAt != null && now - t.priceAt <= maxAgeSec && !pinned.has(t.mint));
  }

  /** On-chain mint/freeze, top holders, RugCheck; cached 10 min per mint. */
  async ensureSafety(mint: string): Promise<SafetyInfo | null> {
    const t = this.tokens.get(mint);
    if (!t) return null;
    if (t.safety && nowSec() - t.safety.checkedAt < 600) return t.safety;
    const exclude = [t.bondingCurve, t.pairAddress].filter((x): x is string => !!x);
    if (t.mint.endsWith("pump")) exclude.push(bondingCurvePda(t.mint));
    t.safety = await checkSafety(this.rpcUrl, this.rpcLimiter, mint, exclude);
    this.counters.rpcCalls += 3;
    return t.safety;
  }

  /** Feed connection stats for logs / acceptance. */
  stats() {
    const now = nowSec();
    let curves = 0;
    let pools = 0;
    let fresh = 0;
    for (const t of this.tokens.values()) {
      if (t.phase === "curve") curves++;
      else pools++;
      if (t.priceAt != null && now - t.priceAt <= 30) fresh++;
    }
    const pp = this.pumpportal.stats;
    return {
      pumpportal: {
        connected: pp.connected,
        upSec: pp.connectedSince ? now - pp.connectedSince : 0,
        connects: pp.connects,
        reconnects: pp.reconnects,
        messages: pp.messages,
        creates: pp.creates,
        migrations: pp.migrations,
      },
      tokens: this.tokens.size,
      curves,
      pools,
      freshPrices: fresh,
      solUsd: this.sol?.usd ?? null,
      ...this.counters,
    };
  }

  // ---------------------------------------------------------------- internals

  private upsert(mint: string, source: string): TokenState {
    let t = this.tokens.get(mint);
    if (!t) {
      const now = nowSec();
      t = {
        mint,
        symbol: null,
        name: null,
        launchpad: null,
        phase: "unknown",
        createdAt: null,
        firstSeenAt: now,
        sources: new Set([source]),
        source,
        bondingCurve: null,
        curveProgressPct: null,
        pairAddress: null,
        supply: null,
        priceUsd: null,
        priceAt: null,
        mcUsd: null,
        liquidityUsd: null,
        buys5m: null,
        sells5m: null,
        providerChange5m: null,
        providerChange1h: null,
        statsAt: null,
        window: new RollingWindow(),
        safety: null,
        jupAudit: null,
        swarmBrains: [],
        lastInterestAt: now,
      };
      this.tokens.set(mint, t);
    } else t.sources.add(source);
    return t;
  }

  private async refreshSolUsd(): Promise<void> {
    const r = await fetchJson<{ price: string }>("https://data-api.binance.vision/api/v3/ticker/price?symbol=SOLUSDT", { retries: 2, timeoutMs: 8_000 });
    const usd = Number(r.price);
    if (Number.isFinite(usd) && usd > 0) this.sol = { usd, at: nowSec() };
  }

  private trimCurves(): void {
    const curves = [...this.tokens.values()].filter((t) => t.phase === "curve" && !this.keep.has(t.mint));
    if (curves.length <= MAX_CURVES) return;
    curves.sort((a, b) => a.firstSeenAt - b.firstSeenAt);
    for (const t of curves.slice(0, curves.length - MAX_CURVES)) this.tokens.delete(t.mint);
  }

  private evict(now: number): void {
    for (const t of this.tokens.values()) {
      if (this.keep.has(t.mint)) continue;
      if (t.phase === "curve") {
        const age = now - (t.createdAt ?? t.firstSeenAt);
        const idle = t.window.idleSec(now);
        if (!this.interest.curve || age > this.interest.maxCurveAgeSec + 60 || (age > 120 && idle != null && idle > CURVE_IDLE_SEC)) this.tokens.delete(t.mint);
      } else if (now - t.lastInterestAt > POOL_INTEREST_TTL_SEC || !this.interest.pools) {
        if (t.swarmBrains.length === 0) this.tokens.delete(t.mint);
      }
    }
  }

  private async sweepCurves(): Promise<void> {
    const now = nowSec();
    this.evict(now);
    const pinned = this.keep;
    const list = [...this.tokens.values()].filter((t) => t.bondingCurve && (t.phase === "curve" || t.phase === "unknown"));
    if (!list.length) return;
    const sol = this.solUsd();
    // pinned first, then youngest
    list.sort((a, b) => Number(pinned.has(b.mint)) - Number(pinned.has(a.mint)) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
    for (let i = 0; i < Math.min(list.length, MAX_CURVES); i += 100) {
      const batch = list.slice(i, i + 100);
      const res = await jsonRpc<{ value: ({ data: [string, string] } | null)[] }>(
        this.rpcUrl,
        "getMultipleAccounts",
        [batch.map((t) => t.bondingCurve), { encoding: "base64", commitment: "processed" }],
        this.rpcLimiter,
      );
      this.counters.rpcCalls++;
      const at = nowSec();
      batch.forEach((t, j) => {
        const acc = res.value[j];
        if (!acc) {
          // no curve account: not a pump.fun token (or never was) — price it from pools
          t.bondingCurve = null;
          if (t.phase === "unknown") t.phase = "graduated";
          return;
        }
        const c = decodeBondingCurve(Buffer.from(acc.data[0], "base64"));
        if (!c) return;
        this.counters.curveAccounts++;
        t.launchpad ??= "pump.fun";
        if (c.complete) {
          t.phase = "graduated";
          t.bondingCurve = null;
          t.curveProgressPct = 100;
          return;
        }
        t.phase = "curve";
        const priceSol = curvePriceSol(c);
        if (priceSol == null || sol == null) return;
        t.supply = curveSupply(c);
        t.priceUsd = priceSol * sol;
        t.priceAt = at;
        t.mcUsd = t.priceUsd * t.supply;
        // depth of a constant-product curve = its virtual SOL reserve (what a sell trades against)
        t.liquidityUsd = (Number(c.virtualSolReserves) / 1e9) * sol;
        t.curveProgressPct = curveProgress(c) * 100;
        t.window.push({ t: at, priceUsd: t.priceUsd, reserveLamports: Number(c.realSolReserves) });
      });
    }
    this.counters.curveSweeps++;
  }

  private async sweepPools(): Promise<void> {
    const now = nowSec();
    const pinned = this.keep;
    // pool tokens with recent interest, plus curve tokens someone is evaluating (for 5m buy/sell counts)
    const list = [...this.tokens.values()]
      .filter((t) => pinned.has(t.mint) || (now - t.lastInterestAt <= POOL_INTEREST_TTL_SEC && (t.phase !== "curve" || now - t.lastInterestAt <= 60)))
      .sort((a, b) => Number(pinned.has(b.mint)) - Number(pinned.has(a.mint)) || b.lastInterestAt - a.lastInterestAt)
      .slice(0, MAX_POOLS);
    if (!list.length) return;
    const snaps = await fetchDexSnapshots(list.map((t) => t.mint));
    const at = nowSec();
    for (const t of list) {
      const s = snaps.get(t.mint);
      if (!s) continue;
      t.symbol ??= s.symbol;
      t.name ??= s.name;
      t.pairAddress = s.pairAddress;
      t.buys5m = s.buys5m;
      t.sells5m = s.sells5m;
      t.providerChange5m = s.change5mPct;
      t.providerChange1h = s.change1hPct;
      t.statsAt = at;
      if (s.dexId === "pumpfun") {
        t.launchpad ??= "pump.fun";
        if (t.createdAt == null && s.pairCreatedAt) t.createdAt = s.pairCreatedAt;
        continue; // curve prices come from the chain
      }
      if (t.phase === "curve") continue;
      t.phase = "graduated";
      if (t.createdAt == null && s.pairCreatedAt) t.createdAt = s.pairCreatedAt;
      if (s.priceUsd != null) {
        t.priceUsd = s.priceUsd;
        t.priceAt = at;
        t.mcUsd = s.mcUsd;
        t.liquidityUsd = s.liquidityUsd;
        t.window.push({ t: at, priceUsd: s.priceUsd, reserveLamports: null });
      }
    }
    this.counters.dexSweeps++;
    this.counters.dexTokens += snaps.size;
  }

  private async pollLists(): Promise<void> {
    if (!this.interest.pools && !this.interest.curve) return;
    const path = LISTS[this.listIdx++ % LISTS.length];
    const list = await jupTokenList(path, 50);
    this.counters.listPolls++;
    const at = nowSec();
    for (const j of list) this.ingestJup(j, `jupiter:${path}`, at);
  }

  private ingestJup(j: JupListToken, source: string, at: number): void {
    const curve = j.launchpad === "pump.fun" && !j.graduatedPool;
    if (curve && !this.interest.curve) return;
    if (!curve && !this.interest.pools) return;
    const t = this.upsert(j.id, source);
    t.symbol ??= j.symbol ?? null;
    t.name ??= j.name ?? null;
    t.launchpad ??= j.launchpad ?? null;
    const created = Date.parse(j.firstPool?.createdAt ?? j.createdAt ?? "");
    if (t.createdAt == null && Number.isFinite(created)) t.createdAt = Math.floor(created / 1000);
    t.jupAudit = {
      mintRevoked: j.audit?.mintAuthorityDisabled ?? null,
      freezeRevoked: j.audit?.freezeAuthorityDisabled ?? null,
      topHoldersPct: j.audit?.topHoldersPercentage ?? null,
    };
    t.lastInterestAt = at;
    if (curve) {
      t.phase = "curve";
      t.bondingCurve ??= bondingCurvePda(j.id);
      return; // priced on-chain
    }
    t.phase = "graduated";
    t.bondingCurve = null;
    if (j.graduatedPool) t.pairAddress ??= j.graduatedPool;
    t.buys5m = j.stats5m?.numBuys ?? t.buys5m;
    t.sells5m = j.stats5m?.numSells ?? t.sells5m;
    t.providerChange5m = j.stats5m?.priceChange ?? t.providerChange5m;
    t.providerChange1h = j.stats1h?.priceChange ?? t.providerChange1h;
    t.statsAt = at;
    if (j.usdPrice) {
      t.priceUsd = j.usdPrice;
      t.priceAt = at;
      t.mcUsd = j.mcap ?? j.fdv ?? t.mcUsd;
      t.liquidityUsd = j.liquidity ?? t.liquidityUsd;
      t.window.push({ t: at, priceUsd: j.usdPrice, reserveLamports: null });
    }
  }

  private async pollSwarms(): Promise<void> {
    const now = nowSec();
    const rows = await getDb()
      .select({ mint: schema.swarms.mint, membersJson: schema.swarms.membersJson })
      .from(schema.swarms)
      .where(and(gt(schema.swarms.lastJoinAt, now - SWARM_ACTIVE_SEC)));
    this.counters.swarmPolls++;
    const active = new Map<string, string[]>();
    for (const r of rows) {
      let brains: string[] = [];
      try {
        brains = (JSON.parse(r.membersJson) as { brainId: string }[]).map((m) => m.brainId);
      } catch {}
      active.set(r.mint, [...new Set([...(active.get(r.mint) ?? []), ...brains])]);
    }
    for (const t of this.tokens.values()) if (!active.has(t.mint)) t.swarmBrains = [];
    if (!this.interest.pools && !this.interest.curve) return;
    for (const [mint, brains] of active) {
      const t = this.upsert(mint, "swarm");
      t.swarmBrains = brains;
      t.lastInterestAt = now;
      if (t.phase === "unknown" && mint.endsWith("pump")) t.bondingCurve ??= bondingCurvePda(mint);
    }
  }
}
