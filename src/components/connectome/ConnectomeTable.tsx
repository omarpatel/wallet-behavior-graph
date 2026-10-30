"use client";

import { useState } from "react";
import { fmtPct } from "@/lib/format";
import type { NeuronDTO, RegionDTO, SynapseDTO } from "@/server/connectome/types";
import { fmtLag, regionCssColor, relTime, sampleSymbols } from "./lib";
import { NeuronName } from "./NeuronName";

type Dir = "asc" | "desc";
interface Col<T> {
  key: string;
  label: string;
  value: (row: T) => number | string;
  render?: (row: T) => React.ReactNode;
  numeric?: boolean;
}

function SortTable<T>({ caption, rows, cols, rowKey, initial }: { caption: string; rows: T[]; cols: Col<T>[]; rowKey: (r: T) => string; initial: string }) {
  const [sort, setSort] = useState<{ key: string; dir: Dir }>({ key: initial, dir: "desc" });
  const col = cols.find((c) => c.key === sort.key) ?? cols[0];
  const sorted = [...rows].sort((a, b) => {
    const x = col.value(a);
    const y = col.value(b);
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return sort.dir === "asc" ? c : -c;
  });
  return (
    <div className="card overflow-x-auto">
      <table className="tbl">
        <caption className="sr-only">{caption} — column headers are sort buttons</caption>
        <thead>
          <tr>
            {cols.map((c) => {
              const active = c.key === sort.key;
              return (
                <th key={c.key} scope="col" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={c.numeric ? "text-right" : ""}>
                  <button
                    type="button"
                    className={`inline-flex items-center gap-1 uppercase hover:text-ink ${active ? "text-ink" : ""}`}
                    onClick={() => setSort({ key: c.key, dir: active && sort.dir === "desc" ? "asc" : "desc" })}
                  >
                    {c.label}
                    <span aria-hidden="true" className="text-[9px]">
                      {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={rowKey(r)}>
              {cols.map((c) => (
                <td key={c.key} className={c.numeric ? "num text-right" : ""}>
                  {c.render ? c.render(r) : c.value(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Accessible / mobile fallback for the canvas: sortable neuron and synapse tables. */
export function ConnectomeTable({
  neurons,
  synapses,
  regions,
  nowSec,
  onPick,
}: {
  neurons: NeuronDTO[];
  synapses: SynapseDTO[];
  regions: Map<number, RegionDTO>;
  nowSec: number;
  onPick: (id: string) => void;
}) {
  const byId = new Map(neurons.map((n) => [n.id, n]));
  const name = (id: string) => byId.get(id)?.label ?? id.slice(0, 8);
  const pick = (id: string, primary = false) => {
    const n = byId.get(id);
    return (
      <button type="button" onClick={() => onPick(id)} className="flex max-w-56 text-left text-ink hover:text-accent">
        {n ? <NeuronName neuron={n} size={primary ? 28 : 20} codename={primary} /> : <span className="num">{id.slice(0, 8)}</span>}
      </button>
    );
  };

  const neuronCols: Col<NeuronDTO>[] = [
    { key: "label", label: "Neuron", value: (n) => n.label, render: (n) => pick(n.id, true) },
    {
      key: "region",
      label: "Region",
      value: (n) => regions.get(n.region)?.name ?? "",
      render: (n) => {
        const r = regions.get(n.region);
        return (
          <span className="inline-flex items-center gap-1.5 text-ink-2">
            <span className="size-2 rounded-full" style={{ background: regionCssColor(n.region, r?.size ?? 1) }} aria-hidden="true" />
            {r?.name}
          </span>
        );
      },
    },
    { key: "tier", label: "Tier", value: (n) => n.tier },
    { key: "pagerank", label: "PageRank", value: (n) => n.pagerank, render: (n) => n.pagerank.toFixed(2), numeric: true },
    { key: "lead", label: "Lead share", value: (n) => n.leadShare ?? -1, render: (n) => fmtPct(n.leadShare), numeric: true },
    { key: "in", label: "In weight", value: (n) => n.inWeight, render: (n) => n.inWeight.toFixed(1), numeric: true },
    { key: "out", label: "Out weight", value: (n) => n.outWeight, render: (n) => n.outWeight.toFixed(1), numeric: true },
    { key: "partners", label: "Partners", value: (n) => n.partners, numeric: true },
    { key: "entries", label: "Entries", value: (n) => n.entries, numeric: true },
  ];
  const synapseCols: Col<SynapseDTO>[] = [
    { key: "pre", label: "Entered first", value: (s) => name(s.pre), render: (s) => pick(s.pre) },
    { key: "post", label: "Followed by", value: (s) => name(s.post), render: (s) => pick(s.post) },
    { key: "weight", label: "Weight", value: (s) => s.weight, render: (s) => s.weight.toFixed(2), numeric: true },
    { key: "events", label: "Shared tokens", value: (s) => s.events, numeric: true },
    { key: "lag", label: "Median lag", value: (s) => s.medianLagSec, render: (s) => fmtLag(s.medianLagSec), numeric: true },
    { key: "last", label: "Last", value: (s) => s.lastEventAt, render: (s) => relTime(s.lastEventAt, nowSec), numeric: true },
    { key: "sample", label: "Sample", value: (s) => sampleSymbols(s), render: (s) => <span className="num text-mute">{sampleSymbols(s)}</span> },
  ];

  return (
    <div className="space-y-8">
      <section aria-labelledby="tbl-neurons">
        <h2 id="tbl-neurons" className="eyebrow mb-3">
          Neurons ({neurons.length})
        </h2>
        <SortTable caption="Neurons" rows={neurons} cols={neuronCols} rowKey={(n) => n.id} initial="pagerank" />
      </section>
      <section aria-labelledby="tbl-synapses">
        <h2 id="tbl-synapses" className="eyebrow mb-3">
          Synapses ({synapses.length})
        </h2>
        <SortTable caption="Synapses" rows={synapses} cols={synapseCols} rowKey={(s) => `${s.pre}-${s.post}`} initial="weight" />
      </section>
    </div>
  );
}
