"use client";

/**
 * Sigma-rendered brain connectome (neurons = brains, synapses = directed co-entry relations). Pure view: the parent
 * owns selection, filters and orchestration (cascade, replay, live firing) and drives effects through the handle.
 * Loaded with `next/dynamic({ ssr: false })` — WebGL + DOM only.
 */
import type Graph from "graphology";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ConnectomeDTO } from "@/server/connectome/types";
import { ACCENT, DIM_NODE, edgeKey, readPalette, rankColor, SELL_COLOR } from "./lib";
import { buildNeuronGraph, layoutAnimated, layoutSync, resetToSeeds, type NeuronAttrs, type SynapseAttrs } from "./neuron-graph";
import { Stage, type Annotation } from "./stage";

const IN_COLOR = "#7cc4ff";
const OUT_COLOR = ACCENT;

/** Overrides the hover/selection focus: a highlighted route, or rank-coloured participants (cascade, replay). */
export type Spotlight =
  | { kind: "path"; nodes: string[]; edges: string[] }
  | { kind: "ranks"; ranks: Record<string, number>; maxRank: number; edges: string[]; exited?: Record<string, true> };

export interface CanvasHandle {
  pulse(node: string, color: string, strength?: number, delayMs?: number): void;
  travel(from: string, to: string, color: string, delayMs?: number, durMs?: number): void;
  annotate(node: string, a: Annotation | null): void;
  clearAnnotations(): void;
  clearEffects(): void;
  flyTo(node: string, ratio?: number): void;
  zoom(factor: number): void;
  resetCamera(): void;
}

export interface ConnectomeCanvasProps {
  data: ConnectomeDTO;
  variant: "explorer" | "mini";
  reducedMotion: boolean;
  minWeight?: number;
  hiddenRegions?: ReadonlySet<number>;
  showLabels?: boolean;
  selected?: string | null;
  spotlight?: Spotlight | null;
  /** Bump to re-run the layout from the seeded positions. */
  layoutSeq?: number;
  onSelect?: (id: string | null) => void;
  onReady?: (handle: CanvasHandle) => void;
  onLayoutDone?: () => void;
  renderTooltip?: (id: string) => ReactNode;
  ariaLabel: string;
}

interface ViewState {
  minWeight: number;
  hiddenRegions: ReadonlySet<number>;
  showLabels: boolean;
  selected: string | null;
  hovered: string | null;
  spotlight: Spotlight | null;
}

const NO_REGIONS: ReadonlySet<number> = new Set();

export default function ConnectomeCanvas(props: ConnectomeCanvasProps) {
  const { data, variant, reducedMotion, layoutSeq = 0, ariaLabel } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Stage | null>(null);
  const graphRef = useRef<Graph<NeuronAttrs, SynapseAttrs> | null>(null);
  const cbRef = useRef(props);
  useEffect(() => {
    cbRef.current = props;
  });
  const viewRef = useRef<ViewState>({
    minWeight: props.minWeight ?? 0,
    hiddenRegions: props.hiddenRegions ?? NO_REGIONS,
    showLabels: !!props.showLabels,
    selected: props.selected ?? null,
    hovered: null,
    spotlight: props.spotlight ?? null,
  });
  const [tip, setTip] = useState<{ id: string; x: number; y: number } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  // Build graph + renderer once per dataset.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let stage: Stage | null = null;
    let cancelLayout: (() => void) | null = null;
    let disposed = false;

    const init = () => {
      if (disposed || stage || host.offsetWidth === 0 || host.offsetHeight === 0) return;
      const graph = buildNeuronGraph(data, readPalette(), Math.floor(Date.now() / 1000), variant === "mini" ? 0.75 : 1);
      graphRef.current = graph;
      if (variant === "mini" || reducedMotion) layoutSync(graph);
      try {
        stage = new Stage(host, graph, {
          interactive: variant === "explorer",
          reducedMotion,
          hoverLabelsOnly: variant === "mini",
          nodeReducer: (key, _data, attrs) => nodeView(key, attrs as NeuronAttrs, viewRef.current, graph),
          edgeReducer: (key, _data, attrs) => edgeView(key, attrs as SynapseAttrs, viewRef.current, graph),
        });
      } catch (e) {
        setFailed(e instanceof Error ? e.message : "WebGL unavailable");
        return;
      }
      stageRef.current = stage;
      const s = stage;
      s.sigma.on("enterNode", ({ node }) => {
        viewRef.current.hovered = node;
        const v = s.nodeViewport(node);
        if (v) setTip({ id: node, x: v.x, y: v.y - v.r });
        s.sigma.refresh({ skipIndexation: true });
      });
      s.sigma.on("leaveNode", () => {
        viewRef.current.hovered = null;
        setTip(null);
        s.sigma.refresh({ skipIndexation: true });
      });
      s.sigma.getCamera().on("updated", () => setTip(null));
      if (variant === "explorer") {
        s.sigma.on("clickNode", ({ node }) => cbRef.current.onSelect?.(node));
        s.sigma.on("clickStage", () => cbRef.current.onSelect?.(null));
      }
      cbRef.current.onReady?.({
        pulse: (n, c, st, d) => s.pulse(n, c, st, d),
        travel: (f, t, c, d, dur) => s.travel(f, t, c, d, dur),
        annotate: (n, a) => s.setAnnotation(n, a),
        clearAnnotations: () => s.clearAnnotations(),
        clearEffects: () => s.clearEffects(),
        flyTo: (n, r) => s.flyTo(n, r),
        zoom: (f) => s.zoom(f),
        resetCamera: () => s.resetCamera(),
      });
      // Explorer: once the layout settles, frame the wired neurons (Stage trims stragglers), not the solitary ring.
      const settled = () => {
        if (variant === "explorer") s.fitTo(graph.filterNodes((_, a) => !a.fixed));
        cbRef.current.onLayoutDone?.();
      };
      if (variant === "explorer" && !reducedMotion) {
        cancelLayout = layoutAnimated(graph, 2000, () => {
          cancelLayout = null;
          settled();
        });
      } else {
        settled();
      }
    };

    // Hidden tabs / collapsed containers have no size yet: wait for one.
    const ro = new ResizeObserver(init);
    ro.observe(host);
    init();
    return () => {
      disposed = true;
      ro.disconnect();
      cancelLayout?.();
      stage?.kill();
      stageRef.current = null;
      graphRef.current = null;
    };
  }, [data, variant, reducedMotion]);

  // Re-run layout on request.
  useEffect(() => {
    const graph = graphRef.current;
    const stage = stageRef.current;
    if (!layoutSeq || !graph || !stage) return;
    resetToSeeds(graph);
    const settled = () => {
      if (variant === "explorer") stage.fitTo(graph.filterNodes((_, a) => !a.fixed));
      cbRef.current.onLayoutDone?.();
    };
    if (reducedMotion || variant === "mini") {
      layoutSync(graph);
      settled();
      return;
    }
    return layoutAnimated(graph, 2000, settled);
  }, [layoutSeq, reducedMotion, variant]);

  // Push view props into the reducers.
  useEffect(() => {
    const v = viewRef.current;
    v.minWeight = props.minWeight ?? 0;
    v.hiddenRegions = props.hiddenRegions ?? NO_REGIONS;
    v.showLabels = !!props.showLabels;
    v.selected = props.selected ?? null;
    v.spotlight = props.spotlight ?? null;
    const stage = stageRef.current;
    if (!stage) return;
    stage.sigma.refresh({ skipIndexation: true });
  }, [props.minWeight, props.hiddenRegions, props.showLabels, props.selected, props.spotlight]);

  // Selection ring.
  const selected = props.selected ?? null;
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !selected) return;
    stage.setRing(selected, "#eceef0");
    return () => stage.setRing(selected, null);
  }, [selected]);

  if (failed) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-mute" role="note">
        The interactive map needs WebGL ({failed}). Use the table view instead.
      </div>
    );
  }

  return (
    <div className="absolute inset-0">
      <div ref={hostRef} role="img" aria-label={ariaLabel} className="absolute inset-0" />
      {tip && props.renderTooltip && (
        <div
          className="pointer-events-none absolute z-10 w-max max-w-64 -translate-x-1/2 -translate-y-full rounded-lg border border-line-2 bg-panel/95 px-3 py-2 text-xs shadow-2xl backdrop-blur"
          style={{ left: tip.x, top: tip.y - 10 }}
        >
          {props.renderTooltip(tip.id)}
        </div>
      )}
    </div>
  );
}

/** Dimmed neurons drop their pfp so the spotlight still reads (the dot falls back to the dim fill colour). */
const DIMMED = { color: DIM_NODE, image: "", labelVisibility: "hidden", zIndex: 0 } as const;
const LIT = { labelVisibility: "visible", depth: "topNodes", zIndex: 2 } as const;

function nodeView(key: string, a: NeuronAttrs, v: ViewState, g: Graph<NeuronAttrs, SynapseAttrs>) {
  if (v.hiddenRegions.has(a.region)) return { visibility: "hidden" } as const;
  const sp = v.spotlight;
  if (sp?.kind === "path") return sp.nodes.includes(key) ? LIT : DIMMED;
  if (sp?.kind === "ranks") {
    const r = sp.ranks[key];
    if (r == null) return DIMMED;
    return { ...LIT, color: sp.exited?.[key] ? SELL_COLOR : rankColor(r, sp.maxRank) };
  }
  const focus = v.hovered ?? v.selected;
  if (focus) {
    if (key === focus) return LIT;
    const linked = g.someEdge(focus, key, (e, ea) => edgeShown(e, ea, v, g)) || g.someEdge(key, focus, (e, ea) => edgeShown(e, ea, v, g));
    return linked ? { ...LIT, zIndex: 1 } : DIMMED;
  }
  // Unwired neurons sit on an outer ring; forcing their labels draws a wall of text. They label on hover only.
  if (g.degree(key) === 0) return { labelVisibility: "hidden" } as const;
  // Forced labels collide on phone-width canvases; there sigma's density-based labels take over.
  return v.showLabels && window.innerWidth >= 768 ? ({ labelVisibility: "visible" } as const) : {};
}

function edgeShown(key: string, a: SynapseAttrs, v: ViewState, g: Graph<NeuronAttrs, SynapseAttrs>): boolean {
  if (a.filterWeight < v.minWeight) return false;
  return !v.hiddenRegions.has(g.getNodeAttribute(g.source(key), "region")) && !v.hiddenRegions.has(g.getNodeAttribute(g.target(key), "region"));
}

function edgeView(key: string, a: SynapseAttrs, v: ViewState, g: Graph<NeuronAttrs, SynapseAttrs>) {
  if (a.twin || !edgeShown(key, a, v, g)) return { visibility: "hidden" } as const;
  const sp = v.spotlight;
  const src = g.source(key);
  const dst = g.target(key);
  const reverse = edgeKey(dst, src);
  if (sp) {
    const on = sp.edges.includes(key) || (a.reciprocal && sp.edges.includes(reverse));
    if (!on) return { opacity: 0.035 };
    const color = sp.kind === "path" ? ACCENT : sp.exited?.[dst] ? SELL_COLOR : rankColor(sp.ranks[dst] ?? 1, sp.maxRank);
    return { color, opacity: 0.95, size: a.size + 1, depth: "topEdges" };
  }
  const focus = v.hovered ?? v.selected;
  if (focus) {
    if (src !== focus && dst !== focus) return { opacity: 0.035 };
    const color = a.reciprocal ? a.color : src === focus ? OUT_COLOR : IN_COLOR;
    return { color, opacity: 0.9, depth: "topEdges" };
  }
  return {};
}
