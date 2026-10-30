import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Not available in your region", robots: { index: false } };

export default function BlockedPage() {
  return (
    <Container className="max-w-2xl py-24 text-center">
      <p className="eyebrow mb-4">Restricted region</p>
      <h1 className="font-display text-4xl text-ink sm:text-5xl">Wallet Behavior Graph isn&apos;t available where you are</h1>
      <p className="mt-6 text-sm leading-relaxed text-ink-2">
        Because of local rules on crypto-asset promotions and international sanctions, the service is not offered in the United
        Kingdom or in comprehensively sanctioned jurisdictions. Please don&apos;t try to work around this restriction.
      </p>
      <p className="mt-8 flex justify-center gap-4 text-sm">
        <Link href="/terms" className="text-ink-2 underline hover:text-accent">
          Terms
        </Link>
        <Link href="/privacy" className="text-ink-2 underline hover:text-accent">
          Privacy
        </Link>
      </p>
    </Container>
  );
}
