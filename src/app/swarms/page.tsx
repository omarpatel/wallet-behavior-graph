import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { SwarmsLive } from "@/components/swarms/SwarmsLive";
import { CardsSkeleton, Container, PageHeader, Skeleton } from "@/components/ui/primitives";
import { fmtPct } from "@/lib/format";
import { getSession } from "@/server/auth/session";
import { listSwarms } from "@/server/signals/queries";
import type { SwarmListDTO } from "@/server/signals/types";

export const metadata: Metadata = {
  title: "Swarms",
  description: "Live: several tracked wallets first-buying the same token within minutes, with the outcome measured afterwards.",
};

export default function SwarmsPage() {
  return (
    <Container>
      <PageHeader
        eyebrow="Swarms"
        title="When the wallets pile in"
        lede="A swarm is three or more tracked wallets first-buying the same token within ten minutes. Members and timing are public as they happen; the token itself is shown in real time to seat holders of a member and to everyone an hour later."
      />
      <Suspense
        fallback={
          <div className="space-y-8">
            <Skeleton className="h-24 rounded-[14px]" />
            <CardsSkeleton count={6} label="Loading swarms" />
          </div>
        }
      >
        <SwarmsBody />
      </Suspense>
    </Container>
  );
}

async function SwarmsBody() {
  const session = await getSession();
  const data = await listSwarms({ viewerWallet: session?.wallet ?? null, limit: 80 });
  return (
    <div className="space-y-10">
      <BaseRates data={data} />
      <SwarmsLive initial={data.swarms} serverNow={data.generatedAt} />
    </div>
  );
}

function BaseRates({ data }: { data: SwarmListDTO }) {
  const measured = data.measured.filter((m) => m.swarms > 0);
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="card min-w-0 p-4">
        <p className="eyebrow">Study base rates · external</p>
        <ul className="mt-3 space-y-2">
          {data.study.map((r) => (
            <li key={r.minMembers} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-ink-2">
                ≥{r.minMembers} wallets within {Math.round(r.windowSec / 60)} min
              </span>
              <span className="num text-ink">
                ~{fmtPct(r.runnerShare)} <span className="text-xs text-mute">runners</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] leading-relaxed text-mute">
          {data.study[0]?.source ?? "External study"}; runner = {data.study[0]?.runnerDefinition ?? "reached ≥$100K market cap"}. A description of
          that sample, not a forecast for any swarm here.
        </p>
      </div>
      <div className="card min-w-0 p-4">
        <p className="eyebrow">Measured here · our tracked wallets</p>
        {measured.length === 0 ? (
          <p className="mt-3 text-sm text-mute">Not enough swarms with a complete 24-hour window yet.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Size</th>
                  <th className="text-right">Swarms</th>
                  <th className="text-right" title="Peak after the swarm became detectable ≥ 2× the market cap at detection">
                    2× after detection
                  </th>
                  <th className="text-right" title="Of swarms that started below $100K market cap">
                    Reached $100K
                  </th>
                </tr>
              </thead>
              <tbody>
                {measured.map((m) => (
                  <tr key={m.minMembers}>
                    <td className="num text-ink-2">≥{m.minMembers}</td>
                    <td className="num text-right text-ink-2">{m.swarms}</td>
                    <td className="num text-right text-ink">
                      {fmtPct(m.share2xFromPublish)} <span className="text-[11px] text-mute">of {m.withPublishMc}</span>
                    </td>
                    <td className="num text-right text-ink">
                      {fmtPct(m.share100k)} <span className="text-[11px] text-mute">of {m.startedBelow100k}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-[11px] leading-relaxed text-mute">
          Peaks come from tracked wallets&apos; own trades within 24 h, so they are lower bounds. Method:{" "}
          <Link href="/methodology#swarms" className="text-ink-2 underline decoration-line-2 hover:text-accent">
            methodology
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
