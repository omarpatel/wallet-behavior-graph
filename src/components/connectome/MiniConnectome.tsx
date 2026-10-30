"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import type { ConnectomeDTO, FiringDTO } from "@/server/connectome/types";
import type { CanvasHandle } from "./ConnectomeCanvas";
import { useFiringStream, useReducedMotion } from "./hooks";
import { BUY_COLOR, SELL_COLOR } from "./lib";
import { NeuronName } from "./NeuronName";

const ConnectomeCanvas = dynamic(() => import("./ConnectomeCanvas"), {
  ssr: false,
  loading: () => <div className="skeleton absolute inset-4 rounded-xl" aria-hidden="true" />,
});

/** Landing hero: compact, hover-only connectome that fires with real trades. */
export function MiniConnectome({ data }: { data: ConnectomeDTO }) {
  const reducedMotion = useReducedMotion();
  const canvas = useRef<CanvasHandle | null>(null);
  const neurons = useMemo(() => new Map(data.neurons.map((n) => [n.id, n])), [data]);
  const [last, setLast] = useState<{ f: FiringDTO; label: string } | null>(null);
  const [fired, setFired] = useState(0);

  const onFire = useCallback(
    (f: FiringDTO, live: boolean) => {
      const n = neurons.get(f.brainId);
      if (!n) return;
      setLast({ f, label: n.label });
      if (!live) return;
      setFired((c) => c + 1);
      canvas.current?.pulse(f.brainId, f.side === "buy" ? BUY_COLOR : SELL_COLOR, 0.5 + f.sizeBucket * 0.25);
      if (f.side === "buy") {
        for (const s of data.synapses.filter((x) => x.pre === f.brainId).slice(0, 4)) canvas.current?.travel(s.pre, s.post, BUY_COLOR, 150, 900);
      }
    },
    [data, neurons],
  );
  const status = useFiringStream(onFire);

  return (
    <div className="card relative overflow-hidden shadow-[0_30px_120px_-40px_rgb(124_196_255/0.25)]">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <p className="eyebrow flex items-center gap-2">
          <span className={`size-1.5 rounded-full ${status === "live" ? "live-dot bg-up" : "bg-warn"}`} aria-hidden="true" />
          Live trading connectome
        </p>
        <p className="num text-[11px] text-mute">
          {data.neurons.length} neurons · {data.synapses.length} synapses
        </p>
      </div>
      <div className="relative h-[300px] bg-[radial-gradient(ellipse_at_center,rgb(124_196_255/0.07),transparent_65%)] sm:h-[340px]">
        {data.neurons.length === 0 ? (
          <p className="flex h-full items-center justify-center px-6 text-center text-sm text-mute">The map grows as tracked wallets overlap.</p>
        ) : (
          <ConnectomeCanvas
            data={data}
            variant="mini"
            reducedMotion={reducedMotion}
            onReady={(h) => {
              canvas.current = h;
            }}
            renderTooltip={(id) => {
              const n = neurons.get(id);
              return n ? <NeuronName neuron={n} size={24} className="text-ink" /> : null;
            }}
            ariaLabel={`Connectome preview: ${data.neurons.length} tracked wallets and the ${data.synapses.length} relations between them`}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
        <p className="min-w-0 truncate text-xs text-mute" aria-live="polite">
          {last ? (
            <>
              <span className={last.f.side === "buy" ? "text-up" : "text-down"}>●</span> <span className="text-ink-2">{last.label}</span>{" "}
              {last.f.side === "buy" ? "bought" : "sold"}
              {fired > 0 && <span className="num ml-2 text-faint">{fired} recent firing{fired === 1 ? "" : "s"}</span>}
            </>
          ) : (
            "Neurons are wallets; synapses link wallets that tend to enter after one another."
          )}
        </p>
        <Link href="/connectome" className="btn btn-primary btn-sm">
          Explore the connectome
        </Link>
      </div>
    </div>
  );
}
