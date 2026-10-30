import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { SquadCard } from "@/components/squads/SquadCard";
import { CardsSkeleton, Container, EmptyState, PageHeader, SectionTitle } from "@/components/ui/primitives";
import { listSquads } from "@/server/queries/squads";

export const metadata: Metadata = {
  title: "Squads",
  description: "Auto-built groups of tracked wallets — monthly top five, sharp shooters, early apes, diamond hands and connectome circles — with a combined trade tape.",
};

export default function SquadsPage() {
  return (
    <Container>
      <PageHeader
        eyebrow="Squads"
        title="Wallet squads"
        lede="Groups of tracked wallets built from a transparent rule — who banked the most this month, who wins most once luck is discounted, who gets in first, who holds, and who trades in sequence. Each squad has a combined trade tape to watch."
      />
      <Suspense fallback={<CardsSkeleton count={6} label="Loading squads" />}>
        <SquadList />
      </Suspense>
    </Container>
  );
}

async function SquadList() {
  const snap = await listSquads();
  if (!snap) {
    return <EmptyState title="Computing squads…">Squads are built from the leaderboard and the connectome. Check back in a minute.</EmptyState>;
  }
  const { squads, sparkStart } = snap;
  if (squads.length === 0) {
    return (
      <EmptyState title="No squads yet" action={<Link href="/leaderboard" className="btn btn-ghost btn-sm">See the leaderboard</Link>}>
        Squads form once enough wallets have profiles and indexed trades for their rules to select at least two members.
      </EmptyState>
    );
  }
  const curated = squads.filter((s) => s.kind !== "circle");
  const circles = squads.filter((s) => s.kind === "circle");
  return (
    <div className="space-y-14">
      <section aria-labelledby="curated">
        <SectionTitle id="curated" eyebrow="Rule-based">
          By trait
        </SectionTitle>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {curated.map((s) => (
            <SquadCard key={s.slug} squad={s} sparkStart={sparkStart} />
          ))}
        </div>
      </section>
      {circles.length > 0 && (
        <section aria-labelledby="circles">
          <SectionTitle
            id="circles"
            eyebrow="From the connectome"
            aside={
              <Link href="/connectome" className="text-sm text-ink-2 hover:text-accent">
                Connectome →
              </Link>
            }
          >
            Circles that trade in sequence
          </SectionTitle>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {circles.map((s) => (
              <SquadCard key={s.slug} squad={s} sparkStart={sparkStart} />
            ))}
          </div>
        </section>
      )}
      <p className="max-w-3xl text-xs leading-relaxed text-mute">
        Squads are views over public wallets, not products: nothing is pooled, there is nothing to buy into, and membership changes as the rules
        re-evaluate. Figures are realized PnL from our own trade index. Not investment advice.
      </p>
    </div>
  );
}
