import type { Metadata } from "next";
import { CreateBrainForm } from "@/components/forms/CreateBrainForm";
import { Container, PageHeader } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Add a wallet" };

const STEPS = [
  ["Backfill", "Recent wallet history is pulled from Solana RPC and every swap is decoded from balance changes."],
  ["Enrich", "Tokens get launch time, launchpad and market cap; SOL is priced at block time."],
  ["Profile", "Archetype, flags, buckets and track-record score are computed. Thin samples stay unrated."],
  ["Go live", "New trades are picked up continuously and become alerts for seat holders."],
];

export default function CreatePage() {
  return (
    <Container className="max-w-3xl">
      <PageHeader
        eyebrow="Add a wallet"
        title="Build a brain from any wallet"
        lede="Paste any public Solana wallet. We backfill its history, profile its style and open seats for it. If the wallet is yours, claim it afterwards by signing in with it."
      />
      <CreateBrainForm />
      <ol className="mt-10 grid gap-px overflow-hidden rounded-[14px] border border-line bg-line sm:grid-cols-2">
        {STEPS.map(([t, d], i) => (
          <li key={t} className="bg-bg p-5">
            <p className="num text-xs text-accent">0{i + 1}</p>
            <p className="mt-2 text-sm font-medium text-ink">{t}</p>
            <p className="mt-1 text-xs leading-relaxed text-mute">{d}</p>
          </li>
        ))}
      </ol>
      <p className="mt-6 text-xs text-mute">
        Only on-chain data is used. Adding a wallet does not attribute it to any person. Owners can object or request
        removal via the <a href="/disputes" className="underline hover:text-accent">disputes form</a>.
      </p>
    </Container>
  );
}
