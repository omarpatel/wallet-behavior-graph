import Link from "next/link";
import { Suspense } from "react";
import { BrainCard } from "@/components/brain/BrainCard";
import { Sparkline } from "@/components/charts/Sparkline";
import { MiniConnectome } from "@/components/connectome/MiniConnectome";
import { FaceMarquee } from "@/components/landing/FaceMarquee";
import { SwarmTicker } from "@/components/swarms/SwarmTicker";
import { BrainAvatar } from "@/components/ui/Avatar";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { CardsSkeleton, Container, EmptyState, SectionTitle, Skeleton, Stat, TableSkeleton } from "@/components/ui/primitives";
import { fmtPct, fmtUsd } from "@/lib/format";
import { brainTitle, pickFace } from "@/lib/identity";
import { getConnectome } from "@/server/connectome/queries";
import { getTopBrains } from "@/server/queries/brains";
import { getHeroFaces, getLandingCounts } from "@/server/queries/landing";
import { getLeaderboard, rankLeaderboard } from "@/server/queries/leaderboard";
import { listSwarms } from "@/server/signals/queries";

const STEPS = [
  {
    n: "01",
    title: "Profile",
    body: "Every swap the wallet made is decoded on-chain and decomposed: entry delay after launch, entry market cap, launchpad mix, hold time, sizing, exits, PnL buckets. Deterministic labels, numbers shown.",
  },
  {
    n: "02",
    title: "Live alerts",
    body: "Each new trade arrives with facts measured against the wallet's own baseline — “4.1× usual size, entered 3× later than usual, liquidity $38k” — plus a short explanation of what it means in this pattern.",
  },
  {
    n: "03",
    title: "Coaching",
    body: "Ask the brain how this wallet sizes into curve plays, when it cuts losers, why it holds 14 seconds. It explains the style; it never tells you what to buy or sell.",
  },
  {
    n: "04",
    title: "Connectome",
    body: "Lead-lag links between wallets are scored with IDF-weighted synapses and permutation tests, then grouped into communities with Louvain, so you can see who tends to move first.",
  },
];

export default function Home() {
  return (
    <>
      <section className="relative overflow-hidden border-b border-line">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgb(255_255_255/0.035)_1px,transparent_1px),linear-gradient(to_bottom,rgb(255_255_255/0.035)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:radial-gradient(ellipse_at_top,black_20%,transparent_70%)]"
        />
        <Container className="relative grid gap-12 pb-16 pt-14 sm:pt-20 lg:grid-cols-[1.15fr_1fr] lg:items-center lg:pb-24">
          <div>
            <p className="eyebrow mb-5 flex items-center gap-2">
              <span className="live-dot size-1.5 rounded-full bg-accent" aria-hidden="true" />
              Public Solana wallets · live on-chain
            </p>
            <h1 className="font-display text-5xl leading-[0.98] tracking-tight text-ink sm:text-6xl lg:text-7xl">
              Trading styles from on-chain history.
              <br />
              <span className="italic text-accent">Who moves first, who follows.</span>
            </h1>
            <p className="mt-6 max-w-xl text-base leading-relaxed text-ink-2 sm:text-lg">
              Each tracked Solana wallet gets a profile: an archetype and flags computed from its trades, with the numbers
              behind every label. A lead-lag graph shows which wallets tend to enter tokens shortly after which others.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/leaderboard" className="btn btn-primary">
                See the leaderboard
              </Link>
              <Link href="/swarms" className="btn btn-ghost">
                Live swarms
              </Link>
              <Link href="/brains" className="btn btn-ghost">
                Explore brains
              </Link>
            </div>
            <Suspense fallback={<Skeleton className="mt-10 h-12 max-w-md" />}>
              <HeroCounts />
            </Suspense>
          </div>
          <Suspense fallback={<Skeleton className="h-[410px] rounded-[14px]" />}>
            <HeroConnectome />
          </Suspense>
        </Container>
        <div className="relative pb-12">
          <Suspense fallback={<Skeleton className="mx-auto h-[92px] max-w-7xl rounded-[14px]" />}>
            <HeroFaces />
          </Suspense>
        </div>
      </section>

      <Container className="mt-12">
        <Suspense fallback={<Skeleton className="h-[150px] rounded-[14px]" />}>
          <LiveSwarms />
        </Suspense>
      </Container>

      <Container className="mt-20">
        <SectionTitle
          eyebrow="Leaderboard · last 24 hours"
          aside={
            <Link href="/leaderboard" className="text-sm text-ink-2 hover:text-accent">
              Full leaderboard →
            </Link>
          }
        >
          Who banked it today
        </SectionTitle>
        <Suspense fallback={<TableSkeleton rows={5} label="Loading today's leaders" />}>
          <TodayLeaders />
        </Suspense>
      </Container>

      <Container className="mt-20">
        <SectionTitle eyebrow="How it works">From public wallet to private analyst</SectionTitle>
        <ol className="grid gap-px overflow-hidden rounded-[14px] border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s) => (
            <li key={s.n} className="bg-bg p-6">
              <p className="num text-xs text-accent">{s.n}</p>
              <h3 className="mt-3 text-base font-semibold text-ink">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-mute">{s.body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-4 max-w-3xl text-sm text-mute">
          Top memecoin wallets often hold for seconds. Brains score <strong className="text-ink-2">copyability</strong>{" "}
          honestly: for many of them the lesson is the discipline, not the entries.
        </p>
      </Container>

      <Container className="mt-20">
        <SectionTitle
          eyebrow="Brains"
          aside={
            <Link href="/brains" className="text-sm text-ink-2 hover:text-accent">
              All brains →
            </Link>
          }
        >
          Top brains by track-record score
        </SectionTitle>
        <Suspense fallback={<CardsSkeleton count={6} label="Loading top brains" />}>
          <TopBrains />
        </Suspense>
      </Container>

      <Container className="mt-20">
        <Disclaimer />
      </Container>
    </>
  );
}

async function HeroCounts() {
  const c = await getLandingCounts();
  return (
    <dl className="mt-10 grid max-w-lg grid-cols-3 gap-6 border-t border-line pt-6">
      <Stat label="Wallets tracked" value={c.brains.toLocaleString("en-US")} hint={c.liveTracked > 0 ? `${c.liveTracked} in real time` : undefined} />
      <Stat
        label="Trades today"
        value={c.tradesToday == null ? "…" : c.tradesToday.toLocaleString("en-US")}
        hint={c.tradesToday == null ? "computing…" : "since 00:00 UTC"}
      />
      <Stat
        label="Active swarms"
        value={
          <Link href="/swarms" className="inline-flex items-center gap-2 hover:text-accent">
            {c.activeSwarms > 0 && <span className="live-dot size-2 rounded-full bg-warn" aria-hidden="true" />}
            {c.activeSwarms}
          </Link>
        }
        tone={c.activeSwarms > 0 ? "accent" : "neutral"}
        hint="last join < 30 min"
      />
    </dl>
  );
}

async function HeroFaces() {
  const faces = await getHeroFaces();
  return <FaceMarquee faces={faces} />;
}

async function LiveSwarms() {
  const data = await listSwarms({ viewerWallet: null, limit: 12 });
  return <SwarmTicker initial={data.swarms} serverNow={data.generatedAt} />;
}

async function TodayLeaders() {
  const lb = await getLeaderboard();
  if (!lb) {
    return <EmptyState title="Computing today's leaders…">The ranking is being computed from indexed trades. Check back in a minute.</EmptyState>;
  }
  const top = rankLeaderboard(lb.rows, "1d", "pnl").slice(0, 5);
  if (top.length === 0) {
    return <EmptyState title="No indexed trades in the last 24 hours yet">Rankings appear as tracked wallets trade.</EmptyState>;
  }
  return (
    <ol className="card divide-y divide-line">
      {top.map((r, i) => {
        const s = r.stats["1d"];
        return (
          <li key={r.id} className="relative flex items-center gap-4 px-4 py-3 transition-colors hover:bg-white/[0.015]">
            <span className={`num w-5 text-sm font-semibold ${i === 0 ? "text-accent" : "text-mute"}`}>{i + 1}</span>
            <BrainAvatar brain={pickFace(r)} size={40} />
            <div className="min-w-0 flex-1">
              <Link href={`/brains/${r.id}`} className="block truncate font-medium text-ink after:absolute after:inset-0 hover:text-accent">
                {brainTitle(r)}
              </Link>
              <p className="num text-[11px] text-mute">
                {s.wins}W / {s.losses}L · win {fmtPct(s.winRate)} · {s.trades} trades
              </p>
            </div>
            <span className="hidden text-ink-2 sm:block">
              <Sparkline values={r.daily.slice(-14)} start={lb.sparkStart + 16 * 86_400} width={84} />
            </span>
            <span className={`num w-24 text-right font-medium ${s.realizedUsd >= 0 ? "text-up" : "text-down"}`}>
              {s.realizedUsd > 0 ? "+" : ""}
              {fmtUsd(s.realizedUsd)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

async function HeroConnectome() {
  const data = await getConnectome();
  // Preview: wired neurons only (unwired ones ring the full map), and no token samples to keep the payload small.
  const wired = new Set(data.synapses.flatMap((s) => [s.pre, s.post]));
  return (
    <MiniConnectome
      data={{ ...data, neurons: data.neurons.filter((n) => wired.has(n.id)), synapses: data.synapses.map((s) => ({ ...s, sample: [] })) }}
    />
  );
}

async function TopBrains() {
  const brains = await getTopBrains(6);
  if (brains.length === 0) {
    return (
      <EmptyState title="No brains listed yet" action={<Link href="/create" className="btn btn-ghost btn-sm">Add a wallet</Link>}>
        Once wallets are backfilled and profiled they are ranked here by track-record score.
      </EmptyState>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {brains.map((b) => (
        <BrainCard key={b.id} brain={b} />
      ))}
    </div>
  );
}
