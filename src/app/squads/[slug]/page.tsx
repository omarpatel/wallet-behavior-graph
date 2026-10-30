import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { BrainLink } from "@/components/brain/BrainLink";
import { Sparkline } from "@/components/charts/Sparkline";
import { squadFaces, SquadKindChip } from "@/components/squads/SquadCard";
import { AvatarStack, BrainAvatar } from "@/components/ui/Avatar";
import { TierBadge } from "@/components/ui/badges";
import { dexscreenerToken, solscan } from "@/components/ui/links";
import { Container, EmptyState, ExternalLink, SectionTitle, Skeleton, Stat, TableSkeleton, toneFor } from "@/components/ui/primitives";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { fmtDuration, fmtPct, fmtSol, fmtUsd, timeAgo } from "@/lib/format";
import { brainTitle, pickFace, showsPublicName } from "@/lib/identity";
import { getSession } from "@/server/auth/session";
import { PUBLIC_TRADE_DELAY_SEC } from "@/server/queries/brains";
import { getSquad, getSquadTape, listSquads } from "@/server/queries/squads";
import type { Squad } from "@/server/snapshots/squads";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const s = await getSquad((await params).slug);
  return s ? { title: `${s.squad.name} · Squads`, description: s.squad.blurb } : { title: "Squad not found" };
}

export default function SquadPage({ params }: Props) {
  return (
    <Suspense
      fallback={
        <Container className="space-y-6 pt-12">
          <Skeleton className="h-12 w-80" />
          <Skeleton className="h-24" />
          <TableSkeleton rows={8} label="Loading squad" />
        </Container>
      }
    >
      <SquadView params={params} />
    </Suspense>
  );
}

const signed = (v: number) => (v > 0 ? `+${fmtUsd(v)}` : fmtUsd(v));

async function SquadView({ params }: Props) {
  const { slug } = await params;
  const data = await getSquad(slug);
  if (!data) {
    if (await listSquads()) notFound();
    return (
      <Container className="pt-12">
        <EmptyState title="Computing squads…">Squads are built from the leaderboard and the connectome. Check back in a minute.</EmptyState>
      </Container>
    );
  }
  const { squad, sparkStart, computedAt } = data;
  const c = squad.combined;

  return (
    <>
      <div className="border-b border-line bg-gradient-to-b from-white/[0.02] to-transparent">
        <Container className="pb-8 pt-10 sm:pt-14">
          <Link href="/squads" className="text-xs text-mute hover:text-accent">
            ← All squads
          </Link>
          <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0 max-w-3xl">
              <SquadKindChip kind={squad.kind} />
              <h1 className="mt-3 font-display text-4xl leading-[1.05] tracking-tight text-ink sm:text-5xl">{squad.name}</h1>
              <p className="mt-3 text-[15px] leading-relaxed text-ink-2">{squad.blurb}</p>
              <p className="mt-2 text-xs text-mute">
                <span className="text-ink-2">Rule:</span> {squad.rule}
              </p>
              <div className="mt-5">
                <AvatarStack brains={squadFaces(squad)} size={40} max={12} />
              </div>
            </div>
            <div className="card shrink-0 p-4 lg:w-[360px]">
              <dl className="grid grid-cols-3 gap-4">
                <Stat label="PnL 30d" value={signed(c.realized30dUsd)} tone={toneFor(c.realized30dUsd)} />
                <Stat label="PnL 7d" value={signed(c.realized7dUsd)} tone={toneFor(c.realized7dUsd)} />
                <Stat label="Win 30d" value={fmtPct(c.winRate30d)} hint={`${c.wins30d}W / ${c.losses30d}L`} />
              </dl>
              <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3 text-ink-2">
                <span className="num text-[11px] text-mute">{c.trades30d.toLocaleString("en-US")} trades · 30d daily</span>
                <Sparkline values={c.daily} start={sparkStart} width={150} height={30} label="Combined daily realized PnL" />
              </div>
            </div>
          </div>
        </Container>
      </div>

      <Container className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section aria-labelledby="tape" className="min-w-0 space-y-4">
          <Suspense fallback={<TableSkeleton rows={10} label="Loading tape" />}>
            <Tape squad={squad} />
          </Suspense>
        </section>
        <section aria-labelledby="members" className="space-y-4">
          <SectionTitle id="members" eyebrow={`${squad.members.length} wallets`}>
            Members
          </SectionTitle>
          <ol className="card divide-y divide-line">
            {squad.members.map((m) => {
              const s = m.stats["30d"];
              return (
                <li key={m.id} className="flex items-center gap-3 p-3">
                  <BrainAvatar brain={pickFace(m)} size={40} />
                  <div className="min-w-0 flex-1">
                    <Link href={`/brains/${m.id}`} className="block truncate text-sm font-medium text-ink hover:text-accent">
                      {brainTitle(m)}
                    </Link>
                    <p className="num truncate text-[11px] text-mute">
                      {m.note ?? (showsPublicName(m) ? m.codename : `${m.wallet.slice(0, 4)}…${m.wallet.slice(-4)}`)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className={`num text-sm ${s.realizedUsd > 0 ? "text-up" : s.realizedUsd < 0 ? "text-down" : "text-ink-2"}`}>{signed(s.realizedUsd)}</p>
                    <p className="num text-[11px] text-mute">win {fmtPct(s.winRate)}</p>
                  </div>
                  <TierBadge tier={m.tier} size="sm" />
                </li>
              );
            })}
          </ol>
          <p className="text-[11px] leading-relaxed text-mute">
            Membership re-evaluates as the rule runs (last {timeAgo(computedAt)}). A squad is a view over public wallets: nothing is pooled and there is
            nothing to buy into. Not investment advice.
          </p>
        </section>
      </Container>
    </>
  );
}

async function Tape({ squad }: { squad: Squad }) {
  const session = await getSession();
  const { trades, realtimeIds, now } = await getSquadTape(
    squad.members.map((m) => m.id),
    session?.wallet ?? null,
  );
  const delay = fmtDuration(PUBLIC_TRADE_DELAY_SEC);
  const live = realtimeIds.length > 0;

  return (
    <>
      {live && <AutoRefresh everyMs={10_000} />}
      <SectionTitle
        id="tape"
        eyebrow={live ? `Live for ${realtimeIds.length} member${realtimeIds.length === 1 ? "" : "s"} you hold a seat on · others delayed ${delay}` : `Delayed ${delay} · seat holders see members live`}
        aside={
          live ? (
            <span className="chip border-up/40 text-up">
              <span className="live-dot size-1.5 rounded-full bg-up" aria-hidden="true" />
              live
            </span>
          ) : undefined
        }
      >
        Combined trade tape
      </SectionTitle>
      {!live && (
        <p className="rounded-xl border border-line-2 bg-panel px-4 py-3 text-xs text-ink-2">
          Hold a seat on any member to see that member&apos;s trades here in real time.{" "}
          <Link href={`/brains/${squad.members[0]?.id ?? ""}`} className="text-ink underline decoration-line-2 hover:text-accent">
            Browse members
          </Link>
        </p>
      )}
      {trades.length === 0 ? (
        <EmptyState title="No trades on the tape yet">Trades by members appear here {delay} after they happen.</EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="tbl min-w-[600px]">
            <caption className="sr-only">Combined trades of squad members</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Wallet</th>
                <th scope="col">Side</th>
                <th scope="col">Token</th>
                <th scope="col" className="text-right">
                  Size
                </th>
                <th scope="col" className="hidden text-right sm:table-cell">
                  MC
                </th>
                <th scope="col">
                  <span className="sr-only">Transaction</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id} className={t.realtime ? "bg-up/[0.03]" : undefined}>
                  <td className="num whitespace-nowrap text-mute">
                    {t.realtime && <span className="live-dot mr-1.5 inline-block size-1.5 rounded-full bg-up align-middle" aria-label="real time" />}
                    {timeAgo(t.blockTime, now)}
                  </td>
                  <td className="max-w-[180px]">
                    <BrainLink id={t.brainId} brain={t} size={20} />
                  </td>
                  <td>
                    <span className={`num text-xs font-semibold uppercase ${t.side === "buy" ? "text-up" : "text-down"}`}>{t.side}</span>
                  </td>
                  <td className="max-w-[10rem]">
                    <span className="flex items-center gap-2">
                      <TokenIcon icon={t.icon} symbol={t.symbol ?? t.mint} size={20} />
                      <ExternalLink href={dexscreenerToken(t.mint)} className="truncate text-ink">
                        {t.symbol ?? `${t.mint.slice(0, 4)}…${t.mint.slice(-4)}`}
                      </ExternalLink>
                    </span>
                  </td>
                  <td className="num text-right text-ink-2">
                    {fmtSol(t.solValue, 2)}
                    <span className="block text-[11px] text-mute">{fmtUsd(t.usdValue)}</span>
                  </td>
                  <td className="num hidden text-right text-ink-2 sm:table-cell">{fmtUsd(t.mcUsd)}</td>
                  <td className="text-right">
                    <ExternalLink href={solscan("tx", t.signature)} className="text-xs text-mute">
                      tx
                    </ExternalLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
