import type { Metadata } from "next";
import { Suspense } from "react";
import { DisputeForm } from "@/components/forms/DisputeForm";
import { Container, PageHeader, Skeleton } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Disputes, corrections & opt-out" };

export default function DisputesPage({ searchParams }: PageProps<"/disputes">) {
  return (
    <Container className="max-w-3xl">
      <PageHeader
        eyebrow="Right of reply"
        title="Disputes, corrections & opt-out"
        lede="Think a label, number or attribution is wrong? Own a profiled wallet and want to object to the processing? Tell us here. Every request is reviewed by a person."
      />
      <Suspense fallback={<Skeleton className="h-[440px] rounded-[14px]" />}>
        <FormWithBrain searchParams={searchParams} />
      </Suspense>
      <div className="mt-8 space-y-2 text-xs leading-relaxed text-mute">
        <p>
          Labels are produced by deterministic rules from public on-chain data; each shows the numbers that triggered it (see the
          methodology). Corrections fix data or attribution errors; they do not remove accurate on-chain facts.
        </p>
        <p>
          Wallet owners can claim their brain by signing in with the wallet, which replaces any third-party attribution with
          self-verified identity.
        </p>
      </div>
    </Container>
  );
}

async function FormWithBrain({ searchParams }: Pick<PageProps<"/disputes">, "searchParams">) {
  const sp = await searchParams;
  const brain = typeof sp.brain === "string" ? sp.brain.slice(0, 80) : undefined;
  return <DisputeForm brainId={brain} />;
}
