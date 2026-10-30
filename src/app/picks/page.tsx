import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { archetypeLabel } from "@/components/agents/lib";
import { PickStatsGrid, SignedPct } from "@/components/picks/PickParts";
import { BrainAvatar } from "@/components/ui/Avatar";
import { Container, EmptyState, PageHeader, Skeleton, TableSkeleton } from "@/components/ui/primitives";
import { fmtDuration, fmtPct, timeAgo } from "@/lib/format";
import { brainTitle } from "@/lib/identity";
import { getPickLeaderboard } from "@/server/picks/queries";
import type { PickLeaderboardDTO, PickLeaderboardRow } from "@/server/picks/types";

export const metadata: Metadata = {
  title: "Brain Picks",
  description:
    "Brains ranked by the paper outcome of their picks: tokens that matched each wallet's style, tracked by the style's exit plan. Not financial advice.",
};

type PickWindow = PickLeaderboardDTO["window"];
const WINDOWS: Record<PickWindow, string> = { "7d": "7 days", "30d": "30 days", all: "all time" };

type SP = { searchParams: Promise<Record<string, string | string[] | undefined>> };

async function windowOf(searchParams: SP["searchParams"]): Promise<PickWindow> {
  const v = (await searchParams).window;
  const w = Array.isArray(v) ? v[0] : v;
  return w && w in WINDOWS ? (w as PickWindow) : "30d";
}

export default function PicksPage({ searchParams }: SP) {
  return (
    <Container>
      <PageHeader
        eyebrow="Brain Picks"
        title="Brain Picks"
        lede="For every brain with a seat holder or an agent, the runner publishes tokens that match that wallet's style — found by the same rules its agents use — and tracks each one on paper by the style's exit plan. This board ranks brains by that paper outcome. Picks never place orders."
        actions={
          <Link href="/methodology#picks" className="btn btn-ghost btn-sm">
            How picks work
          </Link>
        }
      />
      <Suspense fallback={<Skeleton className="h-[44px] w-64 rounded-[12px]" />}>
        <WindowSwitch searchParams={searchParams} />
      </Suspense>
      <div className="mt-6 space-y-8 pb-16">
        <Suspense fallback={<TableSkeleton rows={8} label="Loading Brain Picks leaderboard" />}>
          <Board searchParams={searchParams} />
        </Suspense>
        <p className="text-xs text-mute">
          Only picks older than 1 hour count here, the same delay the public sees picks with; seat holders see them in real
          time on each brain&apos;s Picks tab. Outcomes are paper: the style&apos;s exit plan simulated on live prices, without
          fees or slippage. Not financial advice; past paper outcomes don&apos;t predict future results.
        </p>
      </div>
    </Container>
  );
}

async function WindowSwitch({ searchParams }: SP) {
  const current = await windowOf(searchParams);
  return (
    <nav aria-label="Time window" className="inline-flex rounded-[10px] border border-line-2 bg-bg-2 p-0.5">
      {(Object.keys(WINDOWS) as PickWindow[]).map((w) => (
        <Link
          key={w}
          href={w === "30d" ? "/picks" : `/picks?window=${w}`}
          aria-current={current === w ? "page" : undefined}
          scroll={false}
          className={`inline-flex h-8 items-center rounded-lg px-3 text-[13px] font-medium transition-colors ${
            current === w ? "bg-white/[0.08] text-ink shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]" : "text-mute hover:text-ink"
          }`}
        >
          {w === "all" ? "All" : w.toUpperCase()}
        </Link>
      ))}
    </nav>
  );
}

async function Board({ searchParams }: SP) {
  const win = await windowOf(searchParams);
  await connection();
  const lb = await getPickLeaderboard(win);
  const ranked = lb.rows.filter((r) => r.rank != null);
  const warming = lb.rows.filter((r) => r.rank == null);

  return (
    <>
      <div className="card p-5">
        <h2 className="eyebrow mb-4">
          All brains · {WINDOWS[lb.window]} · paper outcomes · picks older than {fmtDuration(lb.delaySec)}
        </h2>
        <PickStatsGrid stats={lb.total} />
      </div>

      <section aria-labelledby="ranked" className="space-y-3">
        <h2 id="ranked" className="text-lg font-semibold tracking-tight text-ink">
          Ranked by average paper outcome per closed pick
        </h2>
        {ranked.length === 0 ? (
          <EmptyState title="No brain is ranked yet">
            A brain is ranked once it has {lb.minClosed} closed picks older than {fmtDuration(lb.delaySec)} in this window.
          </EmptyState>
        ) : (
          <PickTable rows={ranked} now={lb.computedAt} caption={`Brain Picks leaderboard, ${WINDOWS[lb.window]}`} />
        )}
      </section>

      {warming.length > 0 && (
        <section aria-labelledby="warming" className="space-y-3">
          <div>
            <h2 id="warming" className="text-lg font-semibold tracking-tight text-ink">
              Warming up
            </h2>
            <p className="text-xs text-mute">Fewer than {lb.minClosed} closed picks in this window — not ranked yet.</p>
          </div>
          <PickTable rows={warming} now={lb.computedAt} caption={`Brains with fewer than ${lb.minClosed} closed picks`} />
        </section>
      )}
    </>
  );
}

function PickTable({ rows, now, caption }: { rows: PickLeaderboardRow[]; now: number; caption: string }) {
  return (
    <div className="card overflow-x-auto">
      <table className="tbl min-w-[860px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th className="w-10">#</th>
            <th>Brain</th>
            <th className="text-right">Closed</th>
            <th className="text-right">Win rate</th>
            <th className="text-right">Median</th>
            <th className="text-right">Avg</th>
            <th className="text-right">Best</th>
            <th className="text-right">Worst</th>
            <th className="text-right">Last pick</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const s = r.stats;
            const medal = r.rank === 1 ? "text-accent" : r.rank === 2 ? "text-ink" : r.rank === 3 ? "text-warn" : "text-mute";
            return (
              <tr key={r.brain.brainId}>
                <td>
                  <span className={`num text-sm font-semibold ${medal}`}>{r.rank ?? "—"}</span>
                </td>
                <td>
                  <div className="flex min-w-0 items-center gap-3">
                    <BrainAvatar brain={r.brain} size={32} />
                    <div className="min-w-0">
                      <Link href={`/brains/${r.brain.brainId}`} className="block truncate font-medium text-ink hover:text-accent">
                        {brainTitle(r.brain)}
                      </Link>
                      <p className="truncate text-[11px] text-mute">{r.archetype ? archetypeLabel(r.archetype) : "style pending"}</p>
                    </div>
                  </div>
                </td>
                <td className="num text-right">
                  {s.closed.toLocaleString("en-US")}
                  {s.open > 0 && <span className="block text-[11px] text-mute">{s.open} open</span>}
                </td>
                <td className="num text-right">{fmtPct(s.winRate)}</td>
                <td className="text-right">
                  <SignedPct pct={s.medianOutcomePct} />
                </td>
                <td className="text-right">
                  <SignedPct pct={s.avgOutcomePct} className="font-medium" />
                </td>
                <td className="text-right">
                  <SignedPct pct={s.bestOutcomePct} />
                </td>
                <td className="text-right">
                  <SignedPct pct={s.worstOutcomePct} />
                </td>
                <td className="num text-right text-xs text-mute">{s.lastPickAt ? timeAgo(s.lastPickAt, now) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
