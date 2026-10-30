import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BrainLink } from "@/components/brain/BrainLink";
import { SeatActions } from "@/components/me/SeatActions";
import { BrainAvatar } from "@/components/ui/Avatar";
import { TierBadge, StatusPill } from "@/components/ui/badges";
import { solscan } from "@/components/ui/links";
import { Container, EmptyState, ExternalLink, PageHeader, SectionTitle, Stat, TableSkeleton } from "@/components/ui/primitives";
import { ConnectButton } from "@/components/wallet";
import { fmtDuration, fmtSol, lamportsToSol, shortAddr, timeAgo } from "@/lib/format";
import { brainTitle, pickFace } from "@/lib/identity";
import { getSession } from "@/server/auth/session";
import { getKolDashboard, getMyListings, getMySeats, type OwnerBrainSummary } from "@/server/queries/me";

export const metadata: Metadata = { title: "My seats" };

export default function MePage() {
  return (
    <Container>
      <PageHeader eyebrow="Account" title="My seats" lede="Seats you hold, your listings and — if this wallet is a brain's wallet — its revenue." />
      <Suspense fallback={<TableSkeleton rows={4} label="Loading your seats" />}>
        <MeBody />
      </Suspense>
    </Container>
  );
}

async function MeBody() {
  const session = await getSession();
  if (!session) {
    return (
      <div className="card flex flex-col items-center gap-4 px-6 py-14 text-center">
        <p className="text-base font-medium text-ink">Sign in with your wallet</p>
        <p className="max-w-md text-sm text-mute">
          Connect a Solana wallet and sign the one-time message (no transaction, no fee) to see your seats, listings and brain
          revenue.
        </p>
        <ConnectButton />
      </div>
    );
  }
  const [{ seats, now }, listings, kol] = await Promise.all([
    getMySeats(session.wallet),
    getMyListings(session.wallet),
    getKolDashboard(session.wallet),
  ]);

  return (
    <div className="space-y-14">
      <p className="num -mt-4 text-xs text-mute">
        Signed in as{" "}
        <ExternalLink href={solscan("account", session.wallet)} className="text-ink-2">
          {shortAddr(session.wallet, 6)}
        </ExternalLink>
        {session.isAdmin && (
          <>
            {" · "}
            <Link href="/admin" className="text-accent">
              admin
            </Link>
          </>
        )}
        {" · "}
        <Link href="/agents" className="text-ink-2 hover:text-accent">
          my agents
        </Link>
      </p>

      <section aria-labelledby="seats">
        <SectionTitle id="seats" eyebrow={`${seats.length} held`}>
          Seats
        </SectionTitle>
        {seats.length === 0 ? (
          <EmptyState title="You don't hold any seats" action={<Link href="/brains" className="btn btn-primary btn-sm">Explore brains</Link>}>
            Mint a seat on a brain&apos;s page or buy one on the market.
          </EmptyState>
        ) : (
          <div className="card overflow-x-auto">
            <table className="tbl">
              <caption className="sr-only">Seats you hold</caption>
              <thead>
                <tr>
                  <th scope="col">Brain</th>
                  <th scope="col">Seat</th>
                  <th scope="col">Term left</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="text-right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {seats.map((s) => {
                  const left = s.expiresAt - now;
                  return (
                    <tr key={s.asset}>
                      <td>
                        <span className="flex items-center gap-2">
                          <TierBadge tier={s.tier} size="sm" />
                          <BrainLink id={s.brainId} brain={s} />
                        </span>
                      </td>
                      <td className="num text-ink-2">
                        <ExternalLink href={solscan("token", s.asset, "seats")}>
                          #{s.number}/{s.seatSupply}
                        </ExternalLink>
                      </td>
                      <td className={`num ${left > 3 * 86_400 ? "text-ink-2" : left > 0 ? "text-warn" : "text-down"}`}>
                        {left > 0 ? fmtDuration(left) : `expired ${fmtDuration(-left)} ago`}
                      </td>
                      <td>
                        {s.listing ? (
                          <StatusPill tone="accent">{s.listing.status === "active" ? "listed" : "listing pending"}</StatusPill>
                        ) : left > 0 ? (
                          <StatusPill tone="up">active</StatusPill>
                        ) : (
                          <StatusPill tone="down">expired</StatusPill>
                        )}
                      </td>
                      <td className="text-right">
                        <SeatActions
                          asset={s.asset}
                          label={`${brainTitle(s)} seat #${s.number}`}
                          renewalLamports={s.renewalPriceLamports}
                          termDays={s.termDays}
                          listing={s.listing}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="listings">
        <SectionTitle id="listings" eyebrow="As seller">
          My listings
        </SectionTitle>
        {listings.length === 0 ? (
          <EmptyState title="No listings">List a seat from the table above.</EmptyState>
        ) : (
          <div className="card overflow-x-auto">
            <table className="tbl">
              <caption className="sr-only">Your listings</caption>
              <thead>
                <tr>
                  <th scope="col">Brain</th>
                  <th scope="col">Seat</th>
                  <th scope="col" className="text-right">
                    Price
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">Updated</th>
                  <th scope="col">
                    <span className="sr-only">Transaction</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {listings.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <BrainLink id={l.brainId} brain={l.brain} />
                    </td>
                    <td className="num text-ink-2">#{l.seatNumber}</td>
                    <td className="num text-right text-ink">{fmtSol(lamportsToSol(l.priceLamports), 3)}</td>
                    <td>
                      <StatusPill tone={l.status === "sold" ? "up" : l.status === "active" ? "accent" : "mute"}>{l.status}</StatusPill>
                    </td>
                    <td className="num text-mute">{timeAgo(l.updatedAt, now)}</td>
                    <td className="text-right">
                      {l.saleSignature && (
                        <ExternalLink href={solscan("tx", l.saleSignature, "seats")} className="text-xs text-mute">
                          tx
                        </ExternalLink>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {kol.length > 0 && (
        <section aria-labelledby="kol" className="space-y-4">
          <SectionTitle id="kol" eyebrow="This wallet is a brain wallet">
            Brain revenue
          </SectionTitle>
          {kol.map((k) => (
            <KolCard key={k.id} k={k} now={now} />
          ))}
        </section>
      )}
    </div>
  );
}

function KolCard({ k, now }: { k: OwnerBrainSummary; now: number }) {
  const sum = (f: (t: OwnerBrainSummary["totals"]["primary"]) => number) =>
    f(k.totals.primary) + f(k.totals.renewal) + f(k.totals.royalty);
  const sentPayouts = k.payouts.filter((p) => p.status === "sent").reduce((s, p) => s + p.amountLamports, 0);
  const rows = [
    ["Primary mints", k.totals.primary],
    ["Renewals", k.totals.renewal],
    ["Royalties", k.totals.royalty],
  ] as const;

  return (
    <article className="card space-y-5 p-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <BrainAvatar brain={pickFace(k)} size={48} />
          <div>
            <Link href={`/brains/${k.id}`} className="text-base font-semibold text-ink hover:text-accent">
              {brainTitle(k)}
            </Link>
            <p className="text-xs text-mute">
              {k.status === "claimed" ? `Claimed ${k.claimedAt ? timeAgo(k.claimedAt, now) : ""}` : "Unclaimed — claim it on the brain page"}
              {k.status === "claimed" && (k.xLinked ? " · X linked" : " · X not linked")}
            </p>
          </div>
        </div>
        {k.revenueHeld ? <StatusPill tone="warn">revenue held</StatusPill> : <StatusPill tone="up">revenue active</StatusPill>}
      </header>

      {k.revenueHeld && (
        <p role="note" className="rounded-lg border border-warn/30 bg-warn/[0.05] px-3 py-2 text-xs text-warn">
          {k.revenueHeldReason ?? "Revenue is held pending review."} Payouts are paused until an admin clears the hold.
        </p>
      )}

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Paid at sale" value={fmtSol(lamportsToSol(sum((t) => t.kolInlineLamports)), 4)} />
        <Stat label="Accrued" value={fmtSol(lamportsToSol(sum((t) => t.kolAccruedLamports)), 4)} hint="paid via payouts" />
        <Stat label="Paid out" value={fmtSol(lamportsToSol(sentPayouts), 4)} />
        <Stat label="Alert delay" value={k.alertDelaySec > 0 ? fmtDuration(k.alertDelaySec) : "none"} hint="set by admin" />
      </dl>

      <div className="overflow-x-auto">
        <table className="tbl">
          <caption className="sr-only">Revenue by source</caption>
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col" className="text-right">
                Events
              </th>
              <th scope="col" className="text-right">
                Gross
              </th>
              <th scope="col" className="text-right">
                Your share · inline
              </th>
              <th scope="col" className="text-right">
                Your share · accrued
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([name, t]) => (
              <tr key={name}>
                <td className="text-ink-2">{name}</td>
                <td className="num text-right text-ink-2">{t.count}</td>
                <td className="num text-right text-ink-2">{fmtSol(lamportsToSol(t.grossLamports), 4)}</td>
                <td className="num text-right text-ink">{fmtSol(lamportsToSol(t.kolInlineLamports), 4)}</td>
                <td className="num text-right text-ink">{fmtSol(lamportsToSol(t.kolAccruedLamports), 4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-mute">
        Share: {k.kolShareBps / 100}% of primary and renewal revenue, 50% of royalties. Payout wallet:{" "}
        <span className="num">{k.kolPayoutWallet ? shortAddr(k.kolPayoutWallet) : "brain wallet"}</span>.
      </p>

      {k.payouts.length > 0 && (
        <div>
          <h3 className="eyebrow mb-2">Payouts</h3>
          <ul className="divide-y divide-line text-xs">
            {k.payouts.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="num text-ink">{fmtSol(lamportsToSol(p.amountLamports), 4)}</span>
                <span className="num text-mute">{timeAgo(p.createdAt, now)}</span>
                <StatusPill tone={p.status === "sent" ? "up" : p.status === "failed" ? "down" : "mute"}>{p.status}</StatusPill>
                {p.signature ? (
                  <ExternalLink href={solscan("tx", p.signature, "seats")} className="text-mute">
                    tx
                  </ExternalLink>
                ) : p.error ? (
                  <span className="text-down">{p.error}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}
