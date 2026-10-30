"use client";

/** Sigma view of one brain's token connectome: soma in the centre, tokens around it, capital rotations as arrows. */
import Graph from "graphology";
import { useEffect, useRef, useState } from "react";
import { fmtUsd } from "@/lib/format";
import type { TokenGraphDTO } from "@/server/connectome/types";
import { ACCENT, BUY_COLOR, DIM_NODE, SELL_COLOR } from "./lib";
import { Stage } from "./stage";

type Token = TokenGraphDTO["tokens"][number];
const SOMA = "__soma__";
const FLAT = "#7d858f";
const SPOKE = "#343c46";
const ROTATION = "#7cc4ff";
const OPEN_RING = "#ffb648";
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export default function TokenGraphCanvas({ data, somaLabel, reducedMotion }: { data: TokenGraphDTO; somaLabel: string; reducedMotion: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ token: Token; x: number; y: number } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const tokens = [...data.tokens].sort((a, b) => b.buyUsd - a.buyUsd);
    const byMint = new Map(tokens.map((t) => [t.mint, t]));
    const maxBuy = Math.max(1, ...tokens.map((t) => t.buyUsd));
    const maxRot = Math.max(1, ...data.rotations.map((r) => r.count));

    const g = new Graph({ type: "directed", multi: false, allowSelfLoops: false });
    g.addNode(SOMA, { x: 0, y: 0, size: 16, color: ACCENT, label: somaLabel });
    tokens.forEach((t, i) => {
      // Phyllotaxis: biggest positions closest to the soma, evenly spread.
      const r = 60 + 26 * Math.sqrt(i + 1);
      const a = i * GOLDEN_ANGLE;
      g.addNode(t.mint, {
        x: Math.cos(a) * r,
        y: Math.sin(a) * r,
        size: 3 + 13 * Math.sqrt(t.buyUsd / maxBuy),
        color: t.realizedUsd > 0 ? BUY_COLOR : t.realizedUsd < 0 ? SELL_COLOR : FLAT,
        label: t.symbol ? `$${t.symbol}` : `${t.mint.slice(0, 4)}…`,
      });
      g.addEdge(SOMA, t.mint, { size: 0.5, color: SPOKE, opacity: 0.7, head: "none", curvature: 0, kind: "spoke" });
    });
    for (const r of data.rotations) {
      if (!byMint.has(r.from) || !byMint.has(r.to) || r.from === r.to || g.hasEdge(r.from, r.to)) continue;
      g.addEdge(r.from, r.to, { size: 0.8 + 2.4 * Math.sqrt(r.count / maxRot), color: ROTATION, opacity: 0.75, head: "arrow", curvature: 0.22, kind: "rotation" });
    }

    let stage: Stage | null = null;
    let hovered: string | null = null;
    const init = () => {
      if (stage || host.offsetWidth === 0 || host.offsetHeight === 0) return;
      try {
        stage = new Stage(host, g, {
          interactive: true,
          reducedMotion,
          nodeReducer: (key, _data, attrs) => {
            if (key === SOMA) return { labelVisibility: "visible", labelSize: 13 };
            // Labels point toward the soma, so the outer ring's labels stay inside the card on narrow screens.
            const labelPosition = (attrs.x as number) > 0 ? ("left" as const) : ("right" as const);
            if (!hovered) return { labelPosition };
            if (key === hovered) return { labelPosition, labelVisibility: "visible", depth: "topNodes" };
            return g.areNeighbors(hovered, key) ? { labelPosition, labelVisibility: "visible" } : { labelPosition, color: DIM_NODE, labelVisibility: "hidden" };
          },
          edgeReducer: (key) => {
            if (!hovered) return {};
            const touches = g.source(key) === hovered || g.target(key) === hovered;
            return touches ? { opacity: 1, depth: "topEdges" } : { opacity: 0.05 };
          },
        });
      } catch {
        setFailed(true);
        return;
      }
      const s = stage;
      for (const t of tokens) if (t.open) s.setRing(t.mint, OPEN_RING);
      s.sigma.on("enterNode", ({ node }) => {
        hovered = node;
        const t = byMint.get(node);
        const v = s.nodeViewport(node);
        setTip(t && v ? { token: t, x: v.x, y: v.y - v.r } : null);
        s.sigma.refresh({ skipIndexation: true });
      });
      s.sigma.on("leaveNode", () => {
        hovered = null;
        setTip(null);
        s.sigma.refresh({ skipIndexation: true });
      });
      s.sigma.getCamera().on("updated", () => setTip(null));
    };
    const ro = new ResizeObserver(init);
    ro.observe(host);
    init();
    return () => {
      ro.disconnect();
      stage?.kill();
    };
  }, [data, somaLabel, reducedMotion]);

  if (failed) {
    return <p className="p-6 text-center text-sm text-mute">The token map needs WebGL, which isn&apos;t available in this browser.</p>;
  }
  return (
    <div className="absolute inset-0">
      <div ref={hostRef} className="absolute inset-0" role="img" aria-label={`Token connectome: ${data.tokens.length} tokens, ${data.rotations.length} capital rotations`} />
      {tip && (
        <div
          className="pointer-events-none absolute z-10 w-max max-w-60 -translate-x-1/2 -translate-y-full rounded-lg border border-line-2 bg-panel/95 px-3 py-2 text-xs shadow-2xl"
          style={{ left: tip.x, top: tip.y - 10 }}
        >
          <p className="font-medium text-ink">{tip.token.symbol ? `$${tip.token.symbol}` : tip.token.mint.slice(0, 8)}</p>
          <dl className="num mt-1 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-ink-2">
            <dt className="text-mute">Bought</dt>
            <dd>{fmtUsd(tip.token.buyUsd)}</dd>
            <dt className="text-mute">Realized</dt>
            <dd className={tip.token.realizedUsd > 0 ? "text-up" : tip.token.realizedUsd < 0 ? "text-down" : ""}>{fmtUsd(tip.token.realizedUsd)}</dd>
            <dt className="text-mute">Trades</dt>
            <dd>{tip.token.trades}</dd>
            {tip.token.launchpad && (
              <>
                <dt className="text-mute">Launchpad</dt>
                <dd>{tip.token.launchpad}</dd>
              </>
            )}
          </dl>
          {tip.token.open && <p className="mt-1 text-warn">Position still open</p>}
        </div>
      )}
    </div>
  );
}
