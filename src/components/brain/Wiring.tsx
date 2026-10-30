import Link from "next/link";
import { EmptyState, SectionTitle } from "@/components/ui/primitives";
import { fmtPct } from "@/lib/format";
import { fmtLag, regionCssColor, sampleSymbols } from "@/components/connectome/lib";
import { NeuronName } from "@/components/connectome/NeuronName";
import { getNeuronWiring } from "@/server/connectome/queries";
import type { NeuronDTO, RegionDTO, SynapseDTO } from "@/server/connectome/types";

/** Codex-style wiring for one brain: its region, centrality, and strongest input/output partners. */
export async function Wiring({ brainId }: { brainId: string }) {
  const w = await getNeuronWiring(brainId);
  const regions = new Map(w.regions.map((r) => [r.id, r]));
  const open = (
    <Link href={`/connectome?focus=${encodeURIComponent(brainId)}`} className="text-sm text-ink-2 hover:text-accent">
      Open in connectome →
    </Link>
  );

  if (!w.neuron) {
    return (
      <section aria-labelledby="wiring" className="space-y-4">
        <SectionTitle id="wiring" eyebrow="Connectome" aside={open}>
          Wiring
        </SectionTitle>
        <EmptyState title="Not wired yet">
          This wallet has no significant co-entry relations with other tracked wallets in the current window.
        </EmptyState>
      </section>
    );
  }
  const n = w.neuron;

  return (
    <section aria-labelledby="wiring" className="space-y-4">
      <SectionTitle id="wiring" eyebrow="Connectome · historical co-movement among tracked wallets" aside={open}>
        Wiring
      </SectionTitle>
      <div className="card grid grid-cols-2 gap-4 p-5 sm:grid-cols-4">
        <div className="col-span-2 min-w-0 sm:col-span-1">
          <p className="eyebrow">Region</p>
          {w.region ? (
            <p className="mt-1.5 flex items-center gap-2 text-sm text-ink">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: regionCssColor(w.region.id, w.region.size) }} aria-hidden="true" />
              <span className="truncate">{w.region.name}</span>
            </p>
          ) : (
            <p className="mt-1.5 text-sm text-mute">—</p>
          )}
          {w.region && w.region.size > 1 && <p className="mt-0.5 text-[11px] text-mute">{w.region.size} neurons</p>}
        </div>
        <Metric label="PageRank" value={n.pagerank.toFixed(2)} hint="Influence in the follow graph, 0–1" />
        <Metric label="Lead share" value={fmtPct(n.leadShare)} hint="Co-entries where this wallet entered first" />
        <Metric label="Partners" value={n.partners.toString()} hint={`${n.entries.toLocaleString("en-US")} first buys in window`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <PartnerTable
          title="Enters after"
          blurb="Wallets this one typically entered after."
          rows={w.inputs}
          side="pre"
          total={n.inWeight}
          partners={w.partners}
          regions={regions}
        />
        <PartnerTable
          title="Followed by"
          blurb="Wallets that typically entered after this one."
          rows={w.outputs}
          side="post"
          total={n.outWeight}
          partners={w.partners}
          regions={regions}
        />
      </div>
      <p className="text-xs text-mute">
        Timing patterns, not causation: wallets reacting to the same signal look connected when one is simply faster. Token samples exclude the
        last hour.
      </p>
    </section>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="min-w-0">
      <p className="eyebrow">{label}</p>
      <p className="num mt-1 text-lg font-medium text-ink">{value}</p>
      <p className="truncate text-[11px] text-mute">{hint}</p>
    </div>
  );
}

function PartnerTable({
  title,
  blurb,
  rows,
  side,
  total,
  partners,
  regions,
}: {
  title: string;
  blurb: string;
  rows: SynapseDTO[];
  side: "pre" | "post";
  total: number;
  partners: Record<string, NeuronDTO>;
  regions: Map<number, RegionDTO>;
}) {
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-line px-4 py-3">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <p className="text-xs text-mute">{blurb}</p>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-mute">No significant partners.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">Partner</th>
                <th scope="col" className="text-right">
                  Share
                </th>
                <th scope="col" className="text-right">
                  Tokens
                </th>
                <th scope="col" className="text-right">
                  Median lag
                </th>
                <th scope="col">Samples</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const id = s[side];
                const p = partners[id];
                const r = p ? regions.get(p.region) : undefined;
                const share = total > 0 ? s.weight / total : null;
                return (
                  <tr key={id}>
                    <td className="max-w-48">
                      <Link href={`/brains/${id}`} className="flex text-ink hover:text-accent">
                        {p ? (
                          <NeuronName neuron={p} size={28} regionColor={r ? regionCssColor(r.id, r.size) : undefined} />
                        ) : (
                          <span className="num truncate">{id}</span>
                        )}
                      </Link>
                    </td>
                    <td className="num text-right">
                      <span className="inline-flex items-center gap-2">
                        <span className="hidden h-1 w-10 overflow-hidden rounded-full bg-white/[0.06] sm:block" aria-hidden="true">
                          <span className="block h-full bg-accent/70" style={{ width: `${Math.round((share ?? 0) * 100)}%` }} />
                        </span>
                        {fmtPct(share)}
                      </span>
                    </td>
                    <td className="num text-right text-ink-2">{s.events}</td>
                    <td className="num text-right text-ink-2">{fmtLag(s.medianLagSec)}</td>
                    <td className="num max-w-28 truncate text-xs text-mute">{sampleSymbols(s)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
