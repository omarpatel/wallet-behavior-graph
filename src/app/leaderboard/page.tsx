import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { Sparkline } from "@/components/charts/Sparkline";
import { BrainAvatar } from "@/components/ui/Avatar";
import { TierBadge } from "@/components/ui/badges";
import { Container, EmptyState, ExternalLink, PageHeader, Skeleton, TableSkeleton } from "@/components/ui/primitives";
import { fmtDuration, fmtPct, fmtSol, fmtUsd, timeAgo } from "@/lib/format";
import { brainTitle, pickFace, showsPublicName } from "@/lib/identity";
import {
  getLeaderboard,
  getSourceLeaderboard,
  LB_SORTS,
  rankLeaderboard,
  sourcePnl,
  type LbSort,
} from "@/server/queries/leaderboard";
import { LB_WINDOWS, type LbWindow, type LeaderBrain } from "@/server/snapshots/leaderboard";

export const metadata: Metadata = {
  title: "Leaderboard",
  description: "Tracked wallets ranked by realized PnL from trades indexed on-chain by Wallet Behavior Graph, with each directory's own figures alongside.",
};

type View = "ours" | "source";
interface Params {
  w: LbWindow;
  view: View;
  sort: LbSort;
  q: string;
  page: number;
}

/** Rows per page: the full board (~800 rows with sparklines and avatars) was ~5 MB of HTML. */
const PAGE_SIZE = 100;

function parseParams(sp: Record<string, string | string[] | undefined>): Params {
  const one = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
  };
  const w = one("w");
  const sort = one("sort");
  const page = Number.parseInt(one("page"), 10);
  return {
    w: w in LB_WINDOWS ? (w as LbWindow) : "1d",
    view: one("view") === "source" ? "source" : "ours",
    sort: sort in LB_SORTS ? (sort as LbSort) : "pnl",
    q: one("q").slice(0, 64),
    page: Number.isFinite(page) && page > 1 ? page : 1,
  };
}

/** Link to the board with `patch` applied; any change other than `page` starts again at page 1. */
function href(p: Params, patch: Partial<Params>): string {
  const n = { ...p, page: 1, ...patch };
  const qs = new URLSearchParams();
  if (n.w !== "1d") qs.set("w", n.w);
  if (n.view !== "ours") qs.set("view", n.view);
  if (n.sort !== "pnl") qs.set("sort", n.sort);
  if (n.q) qs.set("q", n.q);
  if (n.page > 1) qs.set("page", String(n.page));
  const s = qs.toString();
  return s ? `/leaderboard?${s}` : "/leaderboard";
}

function Pager({ p, total }: { p: Params; total: number }) {
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages <= 1) return null;
  const page = Math.min(p.page, pages);
  return (
    <nav aria-label="Leaderboard pages" className="flex items-center justify-between gap-3 text-sm">
      <span className="num text-mute">
        {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total.toLocaleString("en-US")}
      </span>
      <span className="flex gap-2">
        {page > 1 && (
          <Link href={href(p, { page: page - 1 })} className="btn btn-ghost btn-sm" scroll={false}>
            ← Previous
          </Link>
        )}
        {page < pages && (
          <Link href={href(p, { page: page + 1 })} className="btn btn-ghost btn-sm" scroll={false}>
            Next →
          </Link>
        )}
      </span>
    </nav>
  );
}

function pageOf<T>(rows: T[], p: Params): T[] {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(p.page, pages);
  return rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
}

function matches(b: LeaderBrain, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase().replace(/^@/, "");
  return [brainTitle(b), b.codename, b.xHandle ?? "", b.wallet, b.id].some((s) => s.toLowerCase().includes(needle));
}

type SP = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default function LeaderboardPage({ searchParams }: SP) {
  return (
    <Container>
      <PageHeader
        eyebrow="Leaderboard"
        title="Who actually banked it"
        lede="Tracked wallets ranked by realized PnL from the trades we index on-chain ourselves (average-cost basis, fees included). Flip to source view for the directory's own published figures."
      />
      <Suspense fallback={<Skeleton className="h-[52px] rounded-[14px]" />}>
        <Controls searchParams={searchParams} />
      </Suspense>
      <div className="mt-6">
        <Suspense fallback={<TableSkeleton rows={10} label="Loading leaderboard" />}>
          <Board searchParams={searchParams} />
        </Suspense>
      </div>
    </Container>
  );
}

async function Controls({ searchParams }: SP) {
  const p = parseParams(await searchParams);
  const seg = (active: boolean) =>
    `inline-flex h-8 items-center rounded-lg px-3 text-[13px] font-medium transition-colors ${
      active ? "bg-white/[0.08] text-ink shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]" : "text-mute hover:text-ink"
    }`;
  return (
    <div className="card flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="Time window" className="inline-flex rounded-[10px] border border-line-2 bg-bg-2 p-0.5">
          {(Object.keys(LB_WINDOWS) as LbWindow[]).map((w) => (
            <Link key={w} href={href(p, { w })} aria-current={p.w === w ? "page" : undefined} className={seg(p.w === w)} scroll={false}>
              {w.toUpperCase()}
            </Link>
          ))}
        </nav>
        <nav aria-label="Figures" className="inline-flex rounded-[10px] border border-line-2 bg-bg-2 p-0.5">
          <Link href={href(p, { view: "ours" })} aria-current={p.view === "ours" ? "page" : undefined} className={seg(p.view === "ours")} scroll={false}>
            Our trades
          </Link>
          <Link
            href={href(p, { view: "source", sort: "pnl" })}
            aria-current={p.view === "source" ? "page" : undefined}
            className={seg(p.view === "source")}
            scroll={false}
          >
            Source view · Directory
          </Link>
        </nav>
      </div>
      <Form action="/leaderboard" replace scroll={false} role="search" aria-label="Search the leaderboard" className="relative sm:w-72">
        {p.w !== "1d" && <input type="hidden" name="w" value={p.w} />}
        {p.view !== "ours" && <input type="hidden" name="view" value={p.view} />}
        {p.sort !== "pnl" && <input type="hidden" name="sort" value={p.sort} />}
        <label>
          <span className="sr-only">Search by name, X handle, codename or wallet</span>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mute">
            <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="m11 11 3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input key={p.q} name="q" type="search" defaultValue={p.q} placeholder="Name, @handle, wallet…" className="field h-9 pl-9 text-[13px]" autoComplete="off" />
        </label>
      </Form>
    </div>
  );
}

async function Board({ searchParams }: SP) {
  const p = parseParams(await searchParams);
  return p.view === "source" ? <SourceBoard p={p} /> : <OurBoard p={p} />;
}

function Trader({ b, rank }: { b: LeaderBrain; rank?: number }) {
  const publicName = showsPublicName(b);
  return (
    <div className="flex min-w-0 items-center gap-3">
      <BrainAvatar brain={pickFace(b)} size={rank != null && rank <= 3 ? 40 : 32} />
      <div className="min-w-0">
        <Link href={`/brains/${b.id}`} className="block truncate font-medium text-ink hover:text-accent">
          {brainTitle(b)}
        </Link>
        <p className="num truncate text-[11px] text-mute">
          {publicName && b.xHandle && b.displayName ? `@${b.xHandle} · ` : ""}
          {publicName ? b.codename : `${b.wallet.slice(0, 4)}…${b.wallet.slice(-4)}`}
          {b.tracking === "live" && (
            <span className="ml-1.5 inline-flex items-center gap-1 text-up" title="Real-time tracked (webhook)">
              <span className="size-1 rounded-full bg-up" aria-hidden="true" />
              live
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

function RankCell({ rank }: { rank: number }) {
  const medal = rank === 1 ? "text-accent" : rank === 2 ? "text-ink" : rank === 3 ? "text-warn" : "text-mute";
  return <span className={`num text-sm font-semibold ${medal}`}>{rank}</span>;
}

function SortHeader({ p, sort, children, className = "" }: { p: Params; sort: LbSort; children: React.ReactNode; className?: string }) {
  const active = p.sort === sort;
  return (
    <th className={className} aria-sort={active ? "descending" : "none"}>
      <Link href={href(p, { sort })} scroll={false} className={`inline-flex items-center gap-1 ${active ? "text-ink" : "hover:text-ink"}`}>
        {children}
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" className={active ? "opacity-100" : "opacity-30"}>
          <path d="M1 2.5 4 5.5 7 2.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </Link>
    </th>
  );
}

async function OurBoard({ p }: { p: Params }) {
  await connection();
  const lb = await getLeaderboard();
  if (!lb) {
    return <EmptyState title="Computing the leaderboard…">The first ranking is being computed from indexed trades. Check back in a minute.</EmptyState>;
  }
  const ranked = rankLeaderboard(lb.rows, p.w, p.sort);
  const rankOf = new Map(ranked.map((r, i) => [r.id, i + 1]));
  const rows = ranked.filter((r) => matches(r, p.q));
  const windowLabel = p.w === "1d" ? "24 hours" : p.w === "7d" ? "7 days" : "30 days";

  if (lb.tracked === 0) {
    return <EmptyState title="No wallets tracked yet">Wallets appear here once their on-chain history has been indexed.</EmptyState>;
  }
  if (ranked.length === 0) {
    return (
      <EmptyState title={`No indexed trades in the last ${windowLabel}`}>
        None of the {lb.tracked.toLocaleString("en-US")} tracked wallets has an indexed trade in this window yet. Try a longer window.
      </EmptyState>
    );
  }

  const podium = !p.q && p.sort === "pnl" ? ranked.slice(0, 3) : [];
  return (
    <div className="space-y-6">
      {podium.length === 3 && (
        <ol className="grid gap-3 sm:grid-cols-3" aria-label="Top three">
          {podium.map((r, i) => {
            const s = r.stats[p.w];
            return (
              <li key={r.id} className={`card card-hover relative overflow-hidden p-5 ${i === 0 ? "sm:order-2 border-accent/30" : i === 1 ? "sm:order-1" : "sm:order-3"}`}>
                <div aria-hidden="true" className={`pointer-events-none absolute -right-6 -top-10 font-display text-[120px] leading-none ${i === 0 ? "text-accent/[0.07]" : "text-white/[0.04]"}`}>
                  {i + 1}
                </div>
                <div className="relative flex items-center gap-4">
                  <BrainAvatar brain={pickFace(r)} size={64} priority />
                  <div className="min-w-0">
                    <p className="eyebrow">#{i + 1} · {p.w.toUpperCase()}</p>
                    <Link href={`/brains/${r.id}`} className="mt-1 block truncate text-lg font-semibold text-ink after:absolute after:inset-0 hover:text-accent">
                      {brainTitle(r)}
                    </Link>
                    <p className="num truncate text-[11px] text-mute">
                      {showsPublicName(r) ? `codename ${r.codename}` : `${r.wallet.slice(0, 4)}…${r.wallet.slice(-4)}`}
                    </p>
                  </div>
                </div>
                <div className="relative mt-5 flex items-end justify-between gap-3">
                  <div>
                    <p className={`num text-2xl font-medium ${s.realizedUsd >= 0 ? "text-up" : "text-down"}`}>{signedUsd(s.realizedUsd)}</p>
                    <p className="num text-xs text-mute">
                      {signedSol(s.realizedSol)} · {s.wins}/{s.losses} W/L
                    </p>
                  </div>
                  <span className="text-ink-2">
                    <Sparkline values={r.daily} start={lb.sparkStart} width={88} height={30} />
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {rows.length === 0 ? (
        <EmptyState title={`No ranked wallet matches “${p.q}”`} action={<Link href={href(p, { q: "" })} className="btn btn-ghost btn-sm">Clear search</Link>}>
          Only wallets with an indexed trade in the last {windowLabel} are ranked.
        </EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="tbl min-w-[720px]">
            <caption className="sr-only">Realized PnL leaderboard, last {windowLabel}</caption>
            <thead>
              <tr>
                <th className="w-10">#</th>
                <th>Trader</th>
                <SortHeader p={p} sort="pnl" className="text-right">
                  Realized
                </SortHeader>
                <SortHeader p={p} sort="wins" className="hidden text-right md:table-cell">
                  W / L
                </SortHeader>
                <SortHeader p={p} sort="winrate" className="text-right">
                  Win rate
                </SortHeader>
                <SortHeader p={p} sort="trades" className="hidden text-right sm:table-cell">
                  Trades
                </SortHeader>
                <th className="hidden text-right lg:table-cell">Med. hold</th>
                <th className="hidden md:table-cell">30d daily</th>
                <th className="text-center">Tier</th>
                <th className="hidden text-right sm:table-cell">Seats</th>
              </tr>
            </thead>
            <tbody>
              {pageOf(rows, p).map((r) => {
                const s = r.stats[p.w];
                const rank = rankOf.get(r.id) ?? 0;
                return (
                  <tr key={r.id}>
                    <td>
                      <RankCell rank={rank} />
                    </td>
                    <td className="max-w-[260px]">
                      <Trader b={r} rank={rank} />
                    </td>
                    <td className="text-right">
                      <p className={`num font-medium ${s.realizedUsd > 0 ? "text-up" : s.realizedUsd < 0 ? "text-down" : "text-ink-2"}`}>{signedUsd(s.realizedUsd)}</p>
                      <p className="num text-[11px] text-mute">{signedSol(s.realizedSol)}</p>
                    </td>
                    <td className="num hidden text-right md:table-cell">
                      <span className="text-up">{s.wins}</span>
                      <span className="text-faint"> / </span>
                      <span className="text-down">{s.losses}</span>
                    </td>
                    <td className="num text-right text-ink-2">{fmtPct(s.winRate)}</td>
                    <td className="num hidden text-right text-ink-2 sm:table-cell">{s.trades.toLocaleString("en-US")}</td>
                    <td className="num hidden text-right text-ink-2 lg:table-cell">{fmtDuration(s.medianHoldSec)}</td>
                    <td className="hidden text-ink-2 md:table-cell">
                      <Sparkline values={r.daily} start={lb.sparkStart} />
                    </td>
                    <td className="text-center">
                      <TierBadge tier={r.tier} size="sm" />
                    </td>
                    <td className="num hidden text-right text-ink-2 sm:table-cell">
                      {r.seatsMinted}/{r.seatSupply}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pager p={p} total={rows.length} />

      <p className="max-w-3xl text-xs leading-relaxed text-mute">
        {ranked.length.toLocaleString("en-US")} of {lb.tracked.toLocaleString("en-US")} tracked wallets traded in the last {windowLabel}. Realized PnL
        counts sells inside the window against the position&apos;s average cost (earlier buys included); wins and losses are per token. The ranking
        is recomputed from indexed trades every few minutes (computed {timeAgo(lb.computedAt)}). Past results say nothing about future results;
        this is not investment advice.
      </p>
    </div>
  );
}

async function SourceBoard({ p }: { p: Params }) {
  const all = await getSourceLeaderboard();
  const ranked = all
    .filter((r) => sourcePnl(r.stats, p.w) != null)
    .sort((a, b) => (sourcePnl(b.stats, p.w) ?? 0) - (sourcePnl(a.stats, p.w) ?? 0));
  const rows = ranked.filter((r) => matches(r, p.q));
  const asOf = ranked.reduce((m, r) => Math.max(m, r.stats.asOf), 0);
  const winRate = (r: (typeof ranked)[number]) => (p.w === "30d" ? r.stats.winRate30d : p.w === "7d" ? r.stats.winRate7d : null);
  const tradesOf = (r: (typeof ranked)[number]) => (p.w === "30d" ? r.stats.trades30d : p.w === "7d" ? r.stats.trades7d : null);

  if (ranked.length === 0) {
    return (
      <EmptyState title="No directory figures imported yet">
        Source view shows the wallet directory&apos;s own published PnL for wallets it lists. None are imported for this window yet.
      </EmptyState>
    );
  }
  return (
    <div className="space-y-4">
      <p role="note" className="rounded-xl border border-info/25 bg-info/[0.04] px-4 py-3 text-xs leading-relaxed text-ink-2">
        <span className="font-medium text-info">Source view.</span> These are the directory&apos;s own figures as published in its snapshot
        {asOf > 0 ? ` (as of ${new Date(asOf * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC)` : ""}. They use the directory&apos;s method and
        are not recomputed here; compare with <Link href={href(p, { view: "ours" })} className="text-ink underline decoration-line-2 hover:text-accent">our trades</Link>.
      </p>
      {rows.length === 0 ? (
        <EmptyState title={`No listed wallet matches “${p.q}”`} action={<Link href={href(p, { q: "" })} className="btn btn-ghost btn-sm">Clear search</Link>} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="tbl min-w-[640px]">
            <caption className="sr-only">Directory published PnL, {p.w}</caption>
            <thead>
              <tr>
                <th className="w-10">#</th>
                <th>Trader</th>
                <th className="text-right">Directory PnL</th>
                <th className="text-right">Win rate</th>
                <th className="hidden text-right sm:table-cell">Trades</th>
                <th className="hidden text-right md:table-cell">Avg hold</th>
                <th className="text-center">Tier</th>
                <th className="hidden text-right sm:table-cell">Profile</th>
              </tr>
            </thead>
            <tbody>
              {pageOf(rows, p).map((r) => {
                const pnl = sourcePnl(r.stats, p.w);
                const rank = ranked.indexOf(r) + 1;
                const t = tradesOf(r);
                return (
                  <tr key={r.id}>
                    <td>
                      <RankCell rank={rank} />
                    </td>
                    <td className="max-w-[260px]">
                      <Trader b={r} rank={rank} />
                    </td>
                    <td className={`num text-right font-medium ${pnl != null && pnl > 0 ? "text-up" : pnl != null && pnl < 0 ? "text-down" : "text-ink-2"}`}>
                      {pnl == null ? "—" : signedUsd(pnl)}
                    </td>
                    <td className="num text-right text-ink-2">{fmtPct(winRate(r))}</td>
                    <td className="num hidden text-right text-ink-2 sm:table-cell">{t == null ? "—" : t.toLocaleString("en-US")}</td>
                    <td className="num hidden text-right text-ink-2 md:table-cell">{fmtDuration(r.stats.avgHoldSecs)}</td>
                    <td className="text-center">
                      <TierBadge tier={r.tier} size="sm" />
                    </td>
                    <td className="hidden text-right text-xs sm:table-cell">
                      {r.url ? (
                        <ExternalLink href={r.url} className="text-ink-2">
                          Listing
                        </ExternalLink>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pager p={p} total={rows.length} />
      {p.w === "1d" && <p className="text-xs text-mute">Directories often publish no daily win rate or trade count; switch to 7D or 30D for those.</p>}
    </div>
  );
}

function signedUsd(v: number): string {
  return v > 0 ? `+${fmtUsd(v)}` : fmtUsd(v);
}

function signedSol(v: number): string {
  return v > 0 ? `+${fmtSol(v, 1)}` : fmtSol(v, 1);
}
