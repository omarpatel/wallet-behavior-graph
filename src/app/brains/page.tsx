import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BrainCard } from "@/components/brain/BrainCard";
import { BrainFilters } from "@/components/brain/BrainFilters";
import { CardsSkeleton, Container, EmptyState, PageHeader, Skeleton } from "@/components/ui/primitives";
import { BRAIN_SORTS, listArchetypes, listBrains, parseBrainFilters } from "@/server/queries/brains";

export const metadata: Metadata = { title: "Explore brains" };

export default function BrainsPage({ searchParams }: PageProps<"/brains">) {
  return (
    <Container>
      <PageHeader
        eyebrow="Explore"
        title="Brains"
        lede="Each brain is the trading style of one public Solana wallet, decomposed into deterministic, numbered labels. Wallets listed with a public label in the configured directory appear under that label with the source shown; every other wallet carries a neutral codename."
        actions={
          <Link href="/create" className="btn btn-ghost">
            Add a wallet
          </Link>
        }
      />
      <Suspense fallback={<Skeleton className="h-[58px] rounded-[14px]" />}>
        <Filters searchParams={searchParams} />
      </Suspense>
      <div className="mt-6">
        <Suspense fallback={<CardsSkeleton count={9} label="Loading brains" />}>
          <Results searchParams={searchParams} />
        </Suspense>
      </div>
    </Container>
  );
}

async function Filters({ searchParams }: Pick<PageProps<"/brains">, "searchParams">) {
  const [f, archetypes] = await Promise.all([searchParams.then(parseBrainFilters), listArchetypes()]);
  return (
    <BrainFilters
      key={JSON.stringify(f)}
      values={{ ...f }}
      options={{ archetypes, sorts: BRAIN_SORTS }}
    />
  );
}

async function Results({ searchParams }: Pick<PageProps<"/brains">, "searchParams">) {
  const f = parseBrainFilters(await searchParams);
  const brains = await listBrains(f);
  const filtered = !!(f.q || f.tier || f.archetype || f.claimed || f.openSeats);
  if (brains.length === 0) {
    return filtered ? (
      <EmptyState title="No brains match these filters" action={<Link href="/brains" className="btn btn-ghost btn-sm">Clear filters</Link>}>
        Try a broader search, or add the wallet you&apos;re looking for.
      </EmptyState>
    ) : (
      <EmptyState title="No brains yet" action={<Link href="/create" className="btn btn-primary btn-sm">Add a wallet</Link>}>
        Brains appear once a wallet&apos;s history has been backfilled.
      </EmptyState>
    );
  }
  return (
    <>
      <p className="num mb-3 text-xs text-mute" role="status">
        {brains.length} brain{brains.length === 1 ? "" : "s"}
      </p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {brains.map((b) => (
          <BrainCard key={b.id} brain={b} />
        ))}
      </div>
    </>
  );
}
