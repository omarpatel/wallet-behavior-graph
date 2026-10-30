/**
 * One record per wallet from every directory row.
 *
 * Per-field precedence (identity, avatar, stats): directory > study. Telegram and followers come from the directory.
 */
import { isValidPubkey } from "@/server/brains";
import type { DirectoryScoreRecord, DirectorySource, DirectorySourceId, ExternalStats, SourceStats, StudyRecord } from "./types";

/** Leaderboard stats as a source reports them (+ last activity, used for recency only). */
export interface RowStats extends Omit<SourceStats, "asOf"> {
  lastActiveTs: number | null;
}

/** One wallet as one directory lists it. */
export interface SourceRow {
  source: DirectorySourceId;
  address: string;
  name: string | null;
  handle: string | null;
  url: string | null;
  avatarUrl: string | null;
  followers: number | null;
  telegram: string | null;
  rank: number | null;
  stats: RowStats | null;
  tags: string[];
  study: StudyRecord | null;
  /** The source lists this wallet as brain-eligible, vs. enrichment only. */
  kol: boolean;
  fetchedAt: number;
}

export interface MergedWallet {
  address: string;
  name: string | null;
  handle: string | null;
  avatarUrl: string | null;
  followers: number | null;
  telegram: string | null;
  sources: DirectorySource[];
  externalStats: ExternalStats;
  /** Listed as a KOL by at least one source → becomes a brain. */
  kol: boolean;
  /** Only the study lists it (community_attributed). */
  studyOnly: boolean;
  /** Best evidence URL: the directory's profile page. */
  provenanceUrl: string | null;
  score: DirectoryScoreRecord;
}

const SOURCE_ORDER: readonly DirectorySourceId[] = ["directory", "study"];
const PLATFORM_KOL: readonly DirectorySourceId[] = ["directory"];

const DAY = 86_400;

const byOrder = (order: readonly DirectorySourceId[]) => (a: SourceRow, b: SourceRow) => {
  const ia = order.indexOf(a.source);
  const ib = order.indexOf(b.source);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
};

function firstOf<T>(rows: SourceRow[], pick: (r: SourceRow) => T | null | undefined): T | null {
  for (const r of rows) {
    const v = pick(r);
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

// ---------- field cleaners (shared by the snapshot loaders and live refreshers) ----------

/** Display name: trimmed, ≤ 64 chars, must contain a letter or digit (some lists have names made only of combining marks). */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/\s+/g, " ").trim().slice(0, 64);
  return /[\p{L}\p{N}]/u.test(s.replace(/\p{M}/gu, "")) ? s : null;
}

/** X handle from "@h", "h", "https://x.com/h", "https://twitter.com/h/…" (or a JSON-quoted URL). */
export function cleanHandle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/^"+|"+$/g, "");
  const m = s.match(/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i) ?? s.match(/^@?([A-Za-z0-9_]{1,15})$/);
  return m ? m[1] : null;
}

export function cleanUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Telegram link as https://t.me/<name>. */
export function cleanTelegram(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(\+?[A-Za-z0-9_]{3,64})\/?$/i) ?? raw.trim().match(/^@([A-Za-z0-9_]{5,32})$/);
  return m ? `https://t.me/${m[1]}` : null;
}

export function num(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export const emptyStats = (): RowStats => ({
  pnl1dUsd: null,
  pnl7dUsd: null,
  pnl30dUsd: null,
  winRate7d: null,
  winRate30d: null,
  trades7d: null,
  trades30d: null,
  avgHoldSecs: null,
  lastActiveTs: null,
});

// ---------- directoryScore ----------

/** Trades/day over the longest window with a count. */
export function tradesPerDay(s: RowStats): number | null {
  if (s.trades30d !== null && s.trades30d > 0) return s.trades30d / 30;
  if (s.trades7d !== null) return s.trades7d / 7;
  if (s.trades30d !== null) return 0;
  return null;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const usd = (n: number) =>
  `${n < 0 ? "−" : "+"}$${Math.abs(n) >= 1000 ? `${(Math.abs(n) / 1000).toFixed(Math.abs(n) >= 100_000 ? 0 : 1)}k` : Math.round(Math.abs(n))}`;
const WR_PRIOR = { n: 20, p: 0.45 };

/**
 * directoryScore 0–100: how well a wallet can be followed from its public leaderboard stats.
 *
 * score = 100 × quality × gate
 * - fidelity f ∈ [0, 1] = the worse of trades/day (1.0 for 0.5–8/day, log-linear to 0 at 100/day; 0.6 + 0.8·tpd below
 *   0.5/day) and average hold (0 at ≤ 30 s, 1.0 at ≥ 4 h, log scale). gate = 0.25 + 0.75 f; unknown f → 0.7.
 * - quality = weighted mean of the known parts: profit 40% (30d PnL else 7d; ≤ $0 → 0, log10(1 + pnl/1000)/log10(201),
 *   i.e. $200k → 1), consistency 20% (share of reported 1d/7d/30d windows in profit), win rate 25% (shrunk toward 45%
 *   by 20 pseudo-trades, then 30% → 0 … 70% → 1), recency 15% (last trade ≤ 2 d 1.0, ≤ 7 d 0.7, 0 trades in 7 d 0.2,
 *   unknown 0.5). Recency only counts when another quality part exists.
 * Null when neither fidelity nor any quality signal is known.
 */
export function directoryScore(s: RowStats, now: number): { value: number | null; notes: string[] } {
  const notes: { weight: number; text: string }[] = [];
  const sorted = () => notes.sort((a, b) => b.weight - a.weight).map((n) => n.text);
  const tpd = tradesPerDay(s);
  const fidelity: number[] = [];
  if (tpd !== null) {
    fidelity.push(tpd > 8 ? clamp01(1 - Math.log10(tpd / 8) / Math.log10(100 / 8)) : tpd >= 0.5 ? 1 : 0.6 + 0.8 * tpd);
    const per = tpd >= 10 ? Math.round(tpd).toString() : tpd.toFixed(1);
    if (tpd > 50) notes.push({ weight: 10, text: `~${per} trades/day — high-frequency` });
    else if (tpd > 8) notes.push({ weight: 5, text: `~${per} trades/day — busy` });
    else if (tpd > 0) notes.push({ weight: 4, text: `~${per} trades/day` });
  }
  if (s.avgHoldSecs !== null && s.avgHoldSecs > 0) {
    const h = s.avgHoldSecs;
    fidelity.push(clamp01(Math.log10(h / 30) / Math.log10((4 * 3600) / 30)));
    const text = h < 120 ? `${Math.round(h)}s` : h < 7200 ? `${Math.round(h / 60)}m` : h < 2 * DAY ? `${(h / 3600).toFixed(1)}h` : `${(h / DAY).toFixed(1)}d`;
    notes.push({ weight: h < 60 ? 9 : 3, text: `avg hold ${text}${h < 60 ? " — scalper" : ""}` });
  }
  const f = fidelity.length ? Math.min(...fidelity) : null;

  const parts: { w: number; v: number }[] = [];
  const pnl = s.pnl30dUsd ?? s.pnl7dUsd;
  if (pnl !== null) {
    parts.push({ w: 0.4, v: pnl <= 0 ? 0 : clamp01(Math.log10(1 + pnl / 1000) / Math.log10(201)) });
    notes.push({ weight: pnl > 0 ? 6 : 7, text: `${usd(pnl)} PnL (${s.pnl30dUsd !== null ? "30d" : "7d"})` });
  }
  const windows = [s.pnl1dUsd, s.pnl7dUsd, s.pnl30dUsd].filter((x): x is number => x !== null);
  if (windows.length >= 2) {
    const up = windows.filter((x) => x > 0).length;
    parts.push({ w: 0.2, v: up / windows.length });
    if (up === windows.length) notes.push({ weight: 2, text: `profitable on all ${windows.length} windows` });
  }
  const wr = s.winRate30d ?? s.winRate7d;
  if (wr !== null) {
    const n = (s.winRate30d !== null ? s.trades30d : s.trades7d) ?? 0;
    const shrunk = (wr * n + WR_PRIOR.p * WR_PRIOR.n) / (n + WR_PRIOR.n);
    parts.push({ w: 0.25, v: clamp01((shrunk - 0.3) / 0.4) });
    notes.push({ weight: 1, text: `${Math.round(wr * 100)}% win rate` });
  }
  if (!parts.length && f === null) return { value: null, notes: sorted() };
  if (parts.length) {
    const inactive = s.trades7d === 0;
    const age = s.lastActiveTs === null ? null : now - s.lastActiveTs;
    parts.push({ w: 0.15, v: age !== null && age <= 2 * DAY ? 1 : age !== null && age <= 7 * DAY ? 0.7 : inactive ? 0.2 : 0.5 });
    if (inactive) notes.push({ weight: 8, text: "no trades in the last 7 days" });
  }
  const quality = parts.length ? parts.reduce((a, p) => a + p.w * p.v, 0) / parts.reduce((a, p) => a + p.w, 0) : 0.5;
  const gate = f === null ? 0.7 : 0.25 + 0.75 * f;
  return { value: Math.round(100 * quality * gate), notes: sorted() };
}

function mergeStats(rows: SourceRow[]): RowStats {
  const out = emptyStats();
  const withStats = rows.filter((r) => r.stats).sort(byOrder(SOURCE_ORDER));
  for (const k of Object.keys(out) as (keyof RowStats)[]) {
    out[k] =
      k === "lastActiveTs"
        ? withStats.reduce<number | null>((m, r) => (r.stats!.lastActiveTs !== null && r.stats!.lastActiveTs > (m ?? 0) ? r.stats!.lastActiveTs : m), null)
        : firstOf(withStats, (r) => r.stats![k]);
  }
  return out;
}

// ---------- merge ----------

/** Groups rows by wallet (invalid base58/32-byte addresses dropped; one row per source, first wins) and merges them. */
export function mergeDirectory(all: SourceRow[], now: number): MergedWallet[] {
  const byAddr = new Map<string, SourceRow[]>();
  for (const r of all) {
    if (!isValidPubkey(r.address)) continue;
    const list = byAddr.get(r.address);
    if (!list) byAddr.set(r.address, [r]);
    else if (!list.some((x) => x.source === r.source)) list.push(r);
  }
  const out: MergedWallet[] = [];
  for (const [address, rows] of byAddr) {
    const identity = [...rows].sort(byOrder(SOURCE_ORDER));
    const stats = mergeStats(rows);
    const { value, notes } = directoryScore(stats, now);
    const tpd = tradesPerDay(stats);
    const tags = new Set(rows.flatMap((r) => r.tags));
    if (rows.some((r) => r.kol)) tags.add("kol");
    if ((tpd !== null && tpd > 50) || (stats.avgHoldSecs !== null && stats.avgHoldSecs < 60)) tags.add("hft");
    if (tpd !== null && tpd > 0 && tpd <= 3 && !tags.has("hft")) tags.add("low-frequency");
    if (stats.trades7d === 0) tags.add("inactive");

    const externalStats: ExternalStats = {};
    for (const r of rows) {
      if (r.study) externalStats.study = r.study;
      if (r.stats && r.source === "directory") {
        const { lastActiveTs: _ignored, ...s } = r.stats;
        if (Object.values(s).some((v) => v !== null)) externalStats.listing = { ...s, asOf: r.fetchedAt };
      }
    }
    externalStats.directory = { value, notes, tags: [...tags].sort(), asOf: now };

    const kolSources = rows.filter((r) => r.kol).map((r) => r.source);
    const urlOf = (s: DirectorySourceId) => rows.find((r) => r.source === s)?.url ?? null;
    out.push({
      address,
      name: firstOf(identity, (r) => r.name),
      handle: firstOf(identity, (r) => r.handle),
      avatarUrl: firstOf(identity, (r) => r.avatarUrl),
      followers: rows.find((r) => r.source === "directory" && r.followers && r.followers > 0)?.followers ?? null,
      telegram: firstOf(identity, (r) => r.telegram),
      sources: identity.map((r) => ({
        source: r.source,
        name: r.name,
        handle: r.handle,
        url: r.url,
        avatarUrl: r.avatarUrl,
        rank: r.rank,
        fetchedAt: r.fetchedAt,
      })),
      externalStats,
      kol: kolSources.length > 0,
      studyOnly: kolSources.length > 0 && !kolSources.some((s) => PLATFORM_KOL.includes(s)),
      provenanceUrl: kolSources.includes("directory") ? urlOf("directory") : null,
      score: externalStats.directory,
    });
  }
  return out;
}
