"use client";

import Link from "next/link";
import { useState } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { TierBadge } from "@/components/ui/badges";
import { fmtDuration, fmtPct, fmtUsd } from "@/lib/format";
import type { CascadeDTO, NeuronDTO, PathDTO, RegionDTO, SynapseDTO } from "@/server/connectome/types";
import { fmtLag, rankColor, regionCssColor, sampleSymbols } from "./lib";
import { NeuronName } from "./NeuronName";

export function RegionChip({ region }: { region: RegionDTO | undefined }) {
  if (!region) return null;
  return (
    <span className="chip max-w-full">
      <span className="size-2 shrink-0 rounded-full" style={{ background: regionCssColor(region.id, region.size) }} aria-hidden="true" />
      <span className="truncate">{region.name}</span>
    </span>
  );
}

export interface NeuronCardProps {
  neuron: NeuronDTO;
  region: RegionDTO | undefined;
  inputs: SynapseDTO[];
  outputs: SynapseDTO[];
  neurons: Map<string, NeuronDTO>;
  regions: Map<number, RegionDTO>;
  cascade: { status: "idle" | "loading" | "error"; data: CascadeDTO | null; error?: string };
  path: { status: "idle" | "loading" | "error"; data: PathDTO | null; error?: string };
  onTraceCascade: () => void;
  onClearCascade: () => void;
  onPath: (to: string) => void;
  onClearPath: () => void;
  onPick: (id: string) => void;
  onClose: () => void;
}

/** Codex-style "cell info": identity, metrics, input/output partner tables, cascade + path tools. */
export function NeuronCard(p: NeuronCardProps) {
  const { neuron: n } = p;
  const [pathTo, setPathTo] = useState("");
  const others = [...p.neurons.values()].filter((x) => x.id !== n.id).sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar src={n.avatarUrl} name={n.label} tier={n.tier} size={48} />
          <div className="min-w-0">
            <p className="eyebrow mb-1">Neuron</p>
            <h2 className="truncate text-lg font-semibold tracking-tight text-ink">{n.label}</h2>
            {n.attribution ? (
              <p className="mt-0.5 text-xs text-ink-2">{n.attribution}</p>
            ) : n.claimed ? (
              <p className="mt-0.5 text-xs text-up">
                Claimed by the wallet owner
                {n.label !== n.codename && <span className="num text-mute"> · codename {n.codename}</span>}
              </p>
            ) : null}
          </div>
        </div>
        <button type="button" onClick={p.onClose} className="btn btn-ghost btn-sm shrink-0 px-2" aria-label="Close neuron card">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <TierBadge tier={n.tier} size="sm" />
        <span className="chip">{n.archetype}</span>
        <RegionChip region={p.region} />
      </div>

      <dl className="grid grid-cols-3 gap-3 border-y border-line py-3">
        <Metric label="PageRank" value={n.pagerank.toFixed(2)} hint="Influence in the follow graph (0–1)" />
        <Metric label="Lead share" value={fmtPct(n.leadShare)} hint="Share of co-entries where this wallet entered first" />
        <Metric label="Partners" value={n.partners.toString()} />
        <Metric label="Entries" value={n.entries.toLocaleString("en-US")} hint="First buys in the window" />
        <Metric label="In / out" value={`${n.inWeight.toFixed(1)} / ${n.outWeight.toFixed(1)}`} hint="Total synapse weight" />
        <Metric label="Realized 90d" value={fmtUsd(n.realizedUsd)} tone={n.realizedUsd == null ? undefined : n.realizedUsd >= 0 ? "text-up" : "text-down"} />
      </dl>

      <div className="flex flex-wrap gap-2">
        {p.cascade.data ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={p.onClearCascade}>
            Clear cascade
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" onClick={p.onTraceCascade} disabled={p.cascade.status === "loading"}>
            {p.cascade.status === "loading" ? "Tracing…" : "Trace cascade"}
          </button>
        )}
        <Link href={`/brains/${n.id}`} className="btn btn-ghost btn-sm">
          Brain page →
        </Link>
      </div>
      {p.cascade.status === "error" && <p className="text-xs text-down">{p.cascade.error}</p>}
      {p.cascade.data && <CascadeList cascade={p.cascade.data} neurons={p.neurons} onPick={p.onPick} />}

      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (pathTo) p.onPath(pathTo);
        }}
      >
        <label htmlFor="path-to" className="eyebrow block">
          Path to…
        </label>
        <div className="flex gap-2">
          <select id="path-to" className="field h-8 text-xs" value={pathTo} onChange={(e) => setPathTo(e.target.value)}>
            <option value="">Choose a neuron</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-ghost btn-sm" disabled={!pathTo || p.path.status === "loading"}>
            {p.path.status === "loading" ? "…" : "Find"}
          </button>
        </div>
        {p.path.status === "error" && <p className="text-xs text-down">{p.path.error}</p>}
        {p.path.data && <PathResult path={p.path.data} neurons={p.neurons} onClear={p.onClearPath} onPick={p.onPick} />}
      </form>

      <PartnerTable
        title="Enters after"
        blurb={`${n.label}'s first buy typically came after these wallets'.`}
        rows={p.inputs}
        side="pre"
        total={n.inWeight}
        neurons={p.neurons}
        regions={p.regions}
        onPick={p.onPick}
      />
      <PartnerTable
        title="Followed by"
        blurb={`These wallets typically entered after ${n.label}.`}
        rows={p.outputs}
        side="post"
        total={n.outWeight}
        neurons={p.neurons}
        regions={p.regions}
        onPick={p.onPick}
      />
      <p className="text-[11px] leading-relaxed text-mute">
        Historical co-movement among tracked wallets — timing, not causation. Samples exclude the last hour.
      </p>
    </div>
  );
}

function Metric({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="min-w-0" title={hint}>
      <dt className="eyebrow truncate text-[10px]">{label}</dt>
      <dd className={`num mt-0.5 truncate text-sm ${tone ?? "text-ink"}`}>{value}</dd>
    </div>
  );
}

function PartnerTable({
  title,
  blurb,
  rows,
  side,
  total,
  neurons,
  regions,
  onPick,
}: {
  title: string;
  blurb: string;
  rows: SynapseDTO[];
  side: "pre" | "post";
  total: number;
  neurons: Map<string, NeuronDTO>;
  regions: Map<number, RegionDTO>;
  onPick: (id: string) => void;
}) {
  return (
    <section>
      <h3 className="eyebrow">{title}</h3>
      <p className="mb-2 mt-1 text-xs text-mute">{blurb}</p>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line-2 px-3 py-3 text-xs text-mute">No synapses at this threshold.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="tbl text-xs [&_td]:px-2 [&_td]:py-1.5 [&_th]:px-2 [&_th]:py-1.5">
            <thead>
              <tr>
                <th scope="col">Partner</th>
                <th scope="col" className="text-right">
                  Share
                </th>
                <th scope="col" className="text-right">
                  Lag
                </th>
                <th scope="col">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const id = s[side];
                const partner = neurons.get(id);
                const region = partner ? regions.get(partner.region) : undefined;
                const share = total > 0 ? s.weight / total : null;
                return (
                  <tr key={id}>
                    <td className="max-w-40">
                      <button type="button" onClick={() => onPick(id)} className="flex max-w-full text-left text-ink hover:text-accent">
                        {partner ? (
                          <NeuronName
                            neuron={partner}
                            size={20}
                            regionColor={region ? regionCssColor(region.id, region.size) : undefined}
                          />
                        ) : (
                          <span className="num truncate">{id.slice(0, 8)}</span>
                        )}
                      </button>
                      <span className="sr-only">
                        weight {s.weight.toFixed(2)}, {s.events} shared tokens
                      </span>
                    </td>
                    <td className="num text-right">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="h-1 w-8 overflow-hidden rounded-full bg-white/[0.06]" aria-hidden="true">
                          <span className="block h-full bg-accent/70" style={{ width: `${Math.round((share ?? 0) * 100)}%` }} />
                        </span>
                        {fmtPct(share)}
                      </span>
                    </td>
                    <td className="num text-right text-ink-2">{fmtLag(s.medianLagSec)}</td>
                    <td className="num max-w-24 truncate text-mute" title={`${s.events} shared tokens`}>
                      {sampleSymbols(s)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function CascadeList({ cascade, neurons, onPick }: { cascade: CascadeDTO; neurons: Map<string, NeuronDTO>; onPick: (id: string) => void }) {
  const maxDepth = Math.max(1, ...cascade.steps.map((s) => s.depth));
  const layers = Array.from({ length: maxDepth }, (_, i) => cascade.steps.filter((s) => s.depth === i + 1));
  if (!cascade.steps.length) {
    return <p className="text-xs text-mute">No neuron crosses the activation threshold from here.</p>;
  }
  return (
    <section aria-label="Signal cascade" className="space-y-3 rounded-lg border border-line bg-white/[0.015] p-3">
      <p className="text-xs text-ink-2">
        Who tends to enter after <span className="text-ink">{neurons.get(cascade.source)?.label}</span>, layer by layer. Lags are typical
        cumulative delays.
      </p>
      {layers.map((layer, i) =>
        layer.length ? (
          <div key={i}>
            <p className="eyebrow mb-1.5 flex items-center gap-2">
              <span className="size-2 rounded-full" style={{ background: rankColor(i + 2, maxDepth + 1) }} aria-hidden="true" />
              Layer {i + 1}
            </p>
            <ul className="space-y-1">
              {layer.map((s) => {
                const m = neurons.get(s.id);
                return (
                  <li key={s.id} className="flex items-center justify-between gap-2 text-xs">
                    <button type="button" onClick={() => onPick(s.id)} className="flex min-w-0 text-left text-ink hover:text-accent">
                      {m ? <NeuronName neuron={m} size={20} codename={false} /> : <span className="num truncate">{s.id.slice(0, 8)}</span>}
                    </button>
                    <span className="num shrink-0 text-mute">
                      {fmtLag(s.cumulativeLagSec)} · {fmtPct(s.strength)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null,
      )}
    </section>
  );
}

function PathResult({ path, neurons, onClear, onPick }: { path: PathDTO; neurons: Map<string, NeuronDTO>; onClear: () => void; onPick: (id: string) => void }) {
  const name = (id: string) => neurons.get(id)?.label ?? id.slice(0, 8);
  return (
    <div className="space-y-2 rounded-lg border border-line bg-white/[0.015] p-3 text-xs">
      {!path.hops ? (
        <p className="text-mute">
          No directed route from {name(path.from)} to {name(path.to)} at the current wiring.
        </p>
      ) : (
        <>
          <ol className="space-y-1">
            <li className="text-ink">{name(path.from)}</li>
            {path.hops.map((h) => (
              <li key={`${h.pre}-${h.post}`} className="flex items-center justify-between gap-2">
                <button type="button" onClick={() => onPick(h.post)} className="truncate text-left text-ink hover:text-accent">
                  ↳ {name(h.post)}
                </button>
                <span className="num shrink-0 text-mute">{fmtLag(h.medianLagSec)}</span>
              </li>
            ))}
          </ol>
          <p className="text-mute">
            Typical arrival ≈ <span className="num text-ink-2">{fmtDuration(path.hops.reduce((t, h) => t + h.medianLagSec, 0))}</span> over{" "}
            {path.hops.length} hop{path.hops.length === 1 ? "" : "s"} (strongest chain by input share).
          </p>
        </>
      )}
      <button type="button" onClick={onClear} className="text-mute underline decoration-line-2 hover:text-ink">
        Clear path
      </button>
    </div>
  );
}
