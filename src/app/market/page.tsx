import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ListingsTable } from "@/components/market/ListingsTable";
import { SalesTable } from "@/components/market/SalesTable";
import { TierBadge } from "@/components/ui/badges";
import { Container, EmptyState, PageHeader, SectionTitle, TableSkeleton } from "@/components/ui/primitives";
import { BrainAvatar } from "@/components/ui/Avatar";
import { fmtSol, lamportsToSol } from "@/lib/format";
import { brainTitle, pickFace } from "@/lib/identity";
import { getMarket } from "@/server/queries/market";

export const metadata: Metadata = { title: "Market" };

export default function MarketPage() {
  return (
    <Container>
      <PageHeader
        eyebrow="Marketplace"
        title="Seat market"
        lede="Pass on a seat you no longer use, or pick one up when a brain is fully minted. Listings are escrowless: the seat stays in the seller's wallet until it sells, and the creator royalty is enforced on every sale."
      />
      <div className="mb-10 grid gap-3 md:grid-cols-2">
        <div className="card p-4 text-xs leading-relaxed text-ink-2">
          <p className="mb-1 font-medium text-ink">Remaining term transfers with the seat</p>
          A seat grants access until its term ends, whoever holds it. Check “term left” before buying; renewing extends it for
          the brain&apos;s renewal price.
        </div>
        <div className="card p-4 text-xs leading-relaxed text-ink-2">
          <p className="mb-1 font-medium text-ink">Listing on Tensor</p>
          Seats are standard Metaplex Core assets and can be listed on Tensor too (royalties honoured). Escrowed listings move the
          seat out of your wallet, so access pauses while it is listed there.
        </div>
      </div>
      <Suspense
        fallback={
          <div className="space-y-10">
            <TableSkeleton rows={6} label="Loading listings" />
            <TableSkeleton rows={4} label="Loading sales" />
          </div>
        }
      >
        <MarketBody />
      </Suspense>
    </Container>
  );
}

async function MarketBody() {
  const m = await getMarket();
  return (
    <div className="space-y-14">
      <section aria-labelledby="active">
        <SectionTitle id="active" eyebrow={`${m.listings.length} active`}>
          Active listings
        </SectionTitle>
        {m.listings.length === 0 ? (
          <EmptyState title="No active listings" action={<Link href="/me" className="btn btn-ghost btn-sm">List a seat you hold</Link>}>
            When holders list seats they appear here, cheapest first.
          </EmptyState>
        ) : (
          <ListingsTable
            now={m.now}
            listings={m.listings.map((l) => ({ ...l, brain: { ...pickFace(l.brain), id: l.brain.id, tier: l.brain.tier } }))}
          />
        )}
      </section>

      {m.lowest.length > 0 && (
        <section aria-labelledby="lowest">
          <SectionTitle id="lowest" eyebrow="Per brain">
            Lowest listing
          </SectionTitle>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {m.lowest.map((l) => (
              <li key={l.brainId} className="card card-hover relative flex items-center justify-between gap-4 p-4">
                <div className="flex min-w-0 items-center gap-3">
                  <BrainAvatar brain={pickFace(l)} size={40} />
                  <div className="min-w-0">
                    <Link href={`/brains/${l.brainId}#listings`} className="flex items-center gap-2 truncate text-sm font-medium text-ink after:absolute after:inset-0 hover:text-accent">
                      <span className="truncate">{brainTitle(l)}</span>
                      <TierBadge tier={l.tier} size="sm" />
                    </Link>
                    <p className="num text-[11px] text-mute">
                      {l.activeListings} listed · {l.seatsLeft > 0 ? `${l.seatsLeft} unminted at ${fmtSol(lamportsToSol(l.mintPriceLamports), 3)}` : "fully minted"}
                    </p>
                  </div>
                </div>
                <p className="num shrink-0 text-sm text-ink">{fmtSol(lamportsToSol(l.lowestLamports), 3)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="sales">
        <SectionTitle id="sales" eyebrow="Completed">
          Recent sales
        </SectionTitle>
        {m.sales.length === 0 ? (
          <EmptyState title="No sales yet">Completed sales are listed with their on-chain signature.</EmptyState>
        ) : (
          <SalesTable sales={m.sales} now={m.now} />
        )}
      </section>
    </div>
  );
}
