import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { BrainAgents } from "@/components/brain/BrainAgents";
import { BrainPicks } from "@/components/brain/BrainPicks";
import { BrainTabs, type TabDef } from "@/components/brain/BrainTabs";
import { BrainTitle } from "@/components/brain/BrainTitle";
import { DirectoryListings, RunnerRecord } from "@/components/brain/DirectoryRecord";
import { IdentityLinks } from "@/components/brain/IdentityLinks";
import { ClaimPanel } from "@/components/brain/ClaimPanel";
import { CoachChat } from "@/components/brain/CoachChat";
import { LiveFeed } from "@/components/brain/LiveFeed";
import { Playbook } from "@/components/brain/Playbook";
import { SayVsDo } from "@/components/brain/SayVsDo";
import { SeatPanel } from "@/components/brain/SeatPanel";
import { StyleDna } from "@/components/brain/StyleDna";
import { TradeLog } from "@/components/brain/TradeLog";
import { Wiring } from "@/components/brain/Wiring";
import { TokenConnectome } from "@/components/connectome/TokenConnectome";
import { ListingsTable } from "@/components/market/ListingsTable";
import { SalesTable } from "@/components/market/SalesTable";
import { SwarmBadge } from "@/components/swarms/SwarmBadge";
import { BrainAvatar } from "@/components/ui/Avatar";
import { TierBadge } from "@/components/ui/badges";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { solscan } from "@/components/ui/links";
import { Container, EmptyState, ExternalLink, SectionTitle, Skeleton } from "@/components/ui/primitives";
import { fmtDuration, shortAddr, timeAgo } from "@/lib/format";
import { brainTitle, pickFace, showsPublicName } from "@/lib/identity";
import { hasBrainAccess } from "@/server/access";
import { getSession } from "@/server/auth/session";
import {
  getBrainDetail,
  getBrainMeta,
  getRecentAlerts,
  getRevenueSummary,
  PUBLIC_TRADE_DELAY_SEC,
  type BrainDetail,
} from "@/server/queries/brains";
import { getBrainBoardRow } from "@/server/queries/leaderboard";
import type { WindowStats } from "@/server/snapshots/leaderboard";
import { activeSwarmsByBrain } from "@/server/signals/queries";
import { getBrainPicks } from "@/server/picks/queries";

export async function generateMetadata({ params }: PageProps<"/brains/[id]">): Promise<Metadata> {
  const meta = await getBrainMeta((await params).id);
  if (!meta) return { title: "Brain not found" };
  return {
    title: meta.title === meta.codename ? meta.title : `${meta.title} · ${meta.codename}`,
    description: `Trading-style profile of the Solana wallet behind ${meta.title}. Unaffiliated educational analysis of public on-chain activity.`,
  };
}

export default function BrainPage({ params }: PageProps<"/brains/[id]">) {
  return (
    <Suspense fallback={<BrainSkeleton />}>
      <BrainView params={params} />
    </Suspense>
  );
}

function BrainSkeleton() {
  return (
    <Container className="pt-12">
      <div role="status" aria-label="Loading brain" className="space-y-6">
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-4 w-96 max-w-full" />
        <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
          <Skeleton className="h-[520px] rounded-[14px]" />
          <Skeleton className="h-[380px] rounded-[14px]" />
        </div>
      </div>
    </Container>
  );
}

async function BrainView({ params }: Pick<PageProps<"/brains/[id]">, "params">) {
  const { id } = await params;
  const [brain, session] = await Promise.all([getBrainDetail(id), getSession()]);
  if (!brain) notFound();
  const viewer = session?.wallet ?? null;
  const access = await hasBrainAccess(viewer, brain.id);
  const isOwnerWallet = viewer === brain.wallet;
  const [initialAlerts, revenue, swarms, boardRow, picks] = await Promise.all([
    access.ok ? getRecentAlerts(brain.id) : Promise.resolve([]),
    isOwnerWallet && brain.status === "claimed" ? getRevenueSummary(brain.id) : Promise.resolve(null),
    activeSwarmsByBrain(viewer),
    getBrainBoardRow(brain.id),
    getBrainPicks(brain.id, viewer),
  ]);
  const swarm = swarms.get(brain.id) ?? null;
  const ours = boardRow?.stats ?? null;
  const title = brainTitle(brain);
  const publicName = showsPublicName(brain);
  const backfilling = brain.backfillStatus === "pending" || brain.backfillStatus === "running";

  const face = pickFace(brain);
  const overview = <Overview brain={brain} full={access.ok} ours={ours} />;
  const tokenTab: TabDef = { id: "tokens", label: "Token connectome", panel: <TokenConnectome brainId={brain.id} title={title} /> };
  const picksTab: TabDef[] = picks
    ? [
        {
          id: "picks",
          label: "Picks",
          badge:
            picks.stats.open > 0 ? (
              <span className="num rounded-full bg-accent/15 px-1.5 text-[10px] text-accent" title={`${picks.stats.open} open on paper`}>
                {picks.stats.open}
              </span>
            ) : undefined,
          panel: <BrainPicks brainId={brain.id} initial={picks} serverNow={brain.now} />,
        },
      ]
    : [];
  const tabs: TabDef[] = access.ok
    ? [
        { id: "overview", label: "Overview", panel: overview },
        ...picksTab,
        {
          id: "live",
          label: "Live",
          badge: <span className="live-dot size-1.5 rounded-full bg-up" aria-hidden="true" />,
          panel: <LiveFeed brainId={brain.id} initial={initialAlerts} alertDelaySec={brain.alertDelaySec} serverNow={brain.now} brain={face} />,
        },
        { id: "coach", label: "Coach", panel: <CoachChat brainId={brain.id} title={title} brain={face} /> },
        tokenTab,
      ]
    : [{ id: "overview", label: "Overview", panel: overview }, ...picksTab, tokenTab];

  return (
    <>
      {backfilling && <AutoRefresh everyMs={8000} />}
      <div className="border-b border-line bg-gradient-to-b from-white/[0.02] to-transparent">
        <Container className="pb-8 pt-10 sm:pt-14">
          {brain.status === "unclaimed" && (
            <p className="mb-6 inline-flex items-center gap-2 rounded-full border border-line-2 bg-panel px-3 py-1 text-xs text-ink-2">
              <span className="size-1.5 rounded-full bg-warn" aria-hidden="true" />
              Unaffiliated analysis of a public wallet — not endorsed by any person attributed to it.
            </p>
          )}
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="flex min-w-0 flex-col gap-5 sm:flex-row sm:items-center">
              <BrainAvatar brain={pickFace(brain)} size={96} priority />
              <div className="min-w-0">
                <BrainTitle brain={brain} as="h1" size="lg" />
                {(publicName || brain.status === "claimed") && (
                  <div className="mt-3">
                    <IdentityLinks xHandle={brain.xHandle} telegram={brain.telegram} followers={brain.followers} sources={brain.sources} />
                  </div>
                )}
                {swarm && (
                  <div className="mt-3">
                    <SwarmBadge swarm={swarm} now={brain.now} />
                  </div>
                )}
                {brain.bio && <p className="mt-3 max-w-2xl text-sm text-ink-2">{brain.bio}</p>}
                <p className="num mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-mute">
                  <ExternalLink href={solscan("account", brain.wallet)} className="text-ink-2">
                    {shortAddr(brain.wallet, 6)}
                  </ExternalLink>
                  <span>{brain.tradeCount.toLocaleString("en-US")} trades indexed</span>
                  <span
                    className={brain.tracking === "live" ? "text-up" : undefined}
                    title={brain.tracking === "live" ? "Trades arrive in real time via webhook" : "History reconciled periodically"}
                  >
                    {brain.tracking === "live" ? "● live tracking" : `standard tracking${brain.lastReconciledAt ? ` · synced ${timeAgo(brain.lastReconciledAt, brain.now)}` : ""}`}
                  </span>
                  {brain.profileUpdatedAt && <span>profile updated {timeAgo(brain.profileUpdatedAt, brain.now)}</span>}
                  <Link href={`/disputes?brain=${encodeURIComponent(brain.id)}`} className="hover:text-accent">
                    report an error
                  </Link>
                </p>
              </div>
            </div>
            <div className="flex items-center gap-5">
              <div className="lg:text-right">
                <p className="eyebrow">Track score</p>
                <p className={`num mt-1 text-4xl font-medium ${brain.trackScore != null ? "text-accent" : "text-faint"}`}>
                  {brain.trackScore != null ? brain.trackScore.toFixed(0) : "—"}
                </p>
              </div>
              <div className="text-center">
                <p className="eyebrow mb-1">Tier</p>
                <TierBadge tier={brain.tier} size="lg" />
              </div>
            </div>
          </div>

          {brain.revenueHeld && (
            <div role="note" className="mt-6 rounded-xl border border-warn/30 bg-warn/[0.05] px-4 py-3 text-sm">
              <p className="font-medium text-warn">Owner revenue on hold pending review</p>
              <p className="mt-1 text-xs text-ink-2">
                {brain.revenueHeldReason ?? "An alerted position was largely sold shortly after the alert published."} This is an
                automatic check on the owner&apos;s trading after alerts; it is not a finding of wrongdoing.
              </p>
            </div>
          )}
          {brain.backfillStatus !== "done" && (
            <div
              role="status"
              className={`mt-6 rounded-xl border px-4 py-3 text-sm ${brain.backfillStatus === "error" ? "border-down/30 bg-down/[0.05]" : "border-line-2 bg-panel"}`}
            >
              {brain.backfillStatus === "error" ? (
                <>
                  <p className="font-medium text-down">History backfill failed</p>
                  {brain.backfillError && <p className="num mt-1 text-xs text-ink-2">{brain.backfillError}</p>}
                </>
              ) : (
                <p className="flex items-center gap-2 text-ink-2">
                  <span className="live-dot size-1.5 rounded-full bg-accent" aria-hidden="true" />
                  {brain.backfillStatus === "pending" ? "Queued for history backfill" : "Backfilling wallet history"} —{" "}
                  {brain.tradeCount.toLocaleString("en-US")} trades so far. This page refreshes automatically.
                </p>
              )}
            </div>
          )}
        </Container>
      </div>

      <Container className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <BrainTabs tabs={tabs} />
        </div>
        <div className="order-first space-y-4 lg:sticky lg:top-20 lg:order-none lg:self-start">
          <SeatPanel brain={brain} access={access} />
          {isOwnerWallet && (
            <ClaimPanel brainId={brain.id} status={brain.status} xLinked={brain.xLinked} revenue={revenue} />
          )}
          <Disclaimer />
        </div>
      </Container>
    </>
  );
}

function Overview({
  brain,
  full,
  ours,
}: {
  brain: BrainDetail;
  full: boolean;
  ours: Record<"1d" | "7d" | "30d", WindowStats> | null;
}) {
  const delayLabel = fmtDuration(PUBLIC_TRADE_DELAY_SEC);
  const showDirectory = brain.status === "claimed" || showsPublicName(brain);
  return (
    <div className="space-y-14">
      {brain.profile ? (
        <StyleDna profile={brain.profile} />
      ) : (
        <EmptyState title="Profile not computed yet">
          The style profile is computed once the wallet&apos;s trade history has been backfilled.
        </EmptyState>
      )}

      {showDirectory && <DirectoryListings stats={brain.externalStats} sources={brain.sources} ours={ours} />}

      {showDirectory && <RunnerRecord study={brain.externalStats.study} />}

      <Playbook markdown={brain.playbookMd} full={full} stale={brain.playbookStale} />

      <Suspense fallback={<Skeleton className="h-48 rounded-[14px]" />}>
        <BrainAgents brainId={brain.id} brainName={brainTitle(brain)} canCreate={full} hasProfile={brain.profile != null} />
      </Suspense>

      <Suspense fallback={<Skeleton className="h-64 rounded-[14px]" />}>
        <Wiring brainId={brain.id} />
      </Suspense>

      {brain.xLinked && <SayVsDo events={brain.shillEvidence} summary={brain.profile?.promoteThenSell ?? null} />}

      <section aria-labelledby="trades" className="space-y-4">
        <SectionTitle id="trades" eyebrow={full ? `Public log · live trades are in the Live tab` : `Delayed ${delayLabel} · seat holders see trades live`}>
          Trade log
        </SectionTitle>
        <TradeLog trades={brain.publicTrades} now={brain.now} delayLabel={delayLabel} />
      </section>

      <section aria-labelledby="listings" className="scroll-mt-24 space-y-4">
        <SectionTitle
          id="listings"
          eyebrow="Seats for this brain"
          aside={
            <Link href="/market" className="text-sm text-ink-2 hover:text-accent">
              Market →
            </Link>
          }
        >
          Listings
        </SectionTitle>
        {brain.listings.length === 0 ? (
          <EmptyState title="No seats listed">Holders can list their seat from My seats.</EmptyState>
        ) : (
          <ListingsTable listings={brain.listings} now={brain.now} codename={brain.codename} />
        )}
        {brain.sales.length > 0 && (
          <div className="pt-2">
            <h3 className="eyebrow mb-3">Recent sales</h3>
            <SalesTable sales={brain.sales} now={brain.now} showBrain={false} />
          </div>
        )}
      </section>
    </div>
  );
}
