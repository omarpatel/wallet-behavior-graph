import type { Metadata } from "next";
import { Suspense } from "react";
import { ConnectomeExplorer } from "@/components/connectome/ConnectomeExplorer";
import { getConnectome } from "@/server/connectome/queries";

export const metadata: Metadata = {
  title: "Connectome",
  description:
    "The trading connectome: tracked Solana wallets as neurons, wallets that tend to enter tokens after one another as synapses, communities as brain regions, live trades as firing. Historical co-movement, not causation.",
};

function one(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s ? s : null;
}

export default function ConnectomePage({ searchParams }: PageProps<"/connectome">) {
  return (
    <Suspense
      fallback={
        <div role="status" className="flex h-[calc(100dvh-4rem)] min-h-[560px] items-center justify-center text-sm text-mute">
          <span className="live-dot mr-2 size-1.5 rounded-full bg-accent" aria-hidden="true" />
          Loading the connectome…
        </div>
      }
    >
      <Explorer searchParams={searchParams} />
    </Suspense>
  );
}

async function Explorer({ searchParams }: Pick<PageProps<"/connectome">, "searchParams">) {
  const [sp, data] = await Promise.all([searchParams, getConnectome()]);
  const mw = one(sp.minWeight);
  return (
    <ConnectomeExplorer
      data={data}
      init={{ focus: one(sp.focus), cascade: one(sp.cascade), replay: one(sp.replay), minWeight: mw != null && Number.isFinite(Number(mw)) ? Number(mw) : null }}
    />
  );
}
