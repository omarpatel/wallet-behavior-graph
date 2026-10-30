/** Graph construction + layout for the brain connectome. Browser-only (imported by the sigma canvas). */
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import FA2Layout from "graphology-layout-forceatlas2/worker";
import type { ConnectomeDTO } from "@/server/connectome/types";
import { CURVATURE, edgeKey, neuronSize, regionColor, seedPosition, synapseOpacity } from "./lib";

/** Reciprocal pairs whose weights differ by less than this (|w_ab − w_ba| / (w_ab + w_ba)) render as shared signal. */
export const RECIPROCAL_ASYMMETRY = 0.2;
export const SHARED_COLOR = "#9aa3ad";

export interface NeuronAttrs {
  x: number;
  y: number;
  size: number;
  color: string;
  label: string;
  /** Same-origin cached pfp route (`brainAvatar()` + size; CORS-clean for WebGL); absent → plain region-coloured dot. */
  image?: string;
  region: number;
  seedX: number;
  seedY: number;
  /** No synapses: pinned during ForceAtlas2 and ringed around the wired graph afterwards. */
  fixed?: boolean;
}

export interface SynapseAttrs {
  weight: number;
  /** Weight used for thresholding (pair max for reciprocal pairs). */
  filterWeight: number;
  size: number;
  color: string;
  opacity: number;
  head: "arrow" | "none";
  reciprocal: boolean;
  /** The other direction of a reciprocal pair: kept for layout, never drawn. */
  twin: boolean;
  /** Bend of the curved path (0 = straight, used for shared-signal pairs). */
  curvature: number;
}

export function buildNeuronGraph(data: ConnectomeDTO, palette: string[], nowSec: number, sizeScale = 1): Graph<NeuronAttrs, SynapseAttrs> {
  const g = new Graph<NeuronAttrs, SynapseAttrs>({ type: "directed", multi: false, allowSelfLoops: false });
  const regionSize = new Map(data.regions.map((r) => [r.id, r.size]));
  const multi = data.regions.filter((r) => r.size > 1);
  const slot = new Map(multi.map((r, i) => [r.id, i]));
  const solitary = data.neurons.filter((n) => !slot.has(n.region)).map((n) => n.id);

  for (const n of data.neurons) {
    const size = regionSize.get(n.region) ?? 1;
    const idx = slot.get(n.region);
    // Region members seed around their region's centroid; solitary neurons spread evenly on an outer ring.
    const k = solitary.indexOf(n.id);
    const seed =
      idx != null
        ? seedPosition(n, idx, multi.length)
        : { x: Math.cos((2 * Math.PI * k) / solitary.length) * 260, y: Math.sin((2 * Math.PI * k) / solitary.length) * 260 };
    const image = n.avatarUrl ? `${n.avatarUrl}&s=64` : null;
    g.addNode(n.id, {
      ...seed,
      seedX: seed.x,
      seedY: seed.y,
      size: neuronSize(n, sizeScale),
      color: regionColor(palette, n.region, size),
      label: n.label,
      ...(image ? { image } : {}),
      region: n.region,
    });
  }

  const weights = new Map(data.synapses.map((s) => [edgeKey(s.pre, s.post), s.weight]));
  const maxW = Math.max(1e-9, ...data.synapses.map((s) => s.weight));
  for (const s of data.synapses) {
    if (!g.hasNode(s.pre) || !g.hasNode(s.post)) continue;
    const back = weights.get(edgeKey(s.post, s.pre)) ?? 0;
    const reciprocal = back > 0 && Math.abs(s.weight - back) / (s.weight + back) < RECIPROCAL_ASYMMETRY;
    // A reciprocal pair draws as one undirected edge carrying the pair's combined weight.
    const drawnW = reciprocal ? s.weight + back : s.weight;
    g.addDirectedEdgeWithKey(edgeKey(s.pre, s.post), s.pre, s.post, {
      weight: s.weight,
      filterWeight: reciprocal ? Math.max(s.weight, back) : s.weight,
      size: (0.6 + 4 * Math.sqrt(Math.min(1, drawnW / maxW))) * sizeScale,
      color: reciprocal ? SHARED_COLOR : g.getNodeAttribute(s.pre, "color"),
      opacity: synapseOpacity(s.lastEventAt, nowSec),
      head: reciprocal ? "none" : "arrow",
      reciprocal,
      twin: reciprocal && s.pre > s.post,
      curvature: reciprocal ? 0 : CURVATURE,
    });
  }
  // Unwired neurons don't take part in the force layout (FA2 skips `fixed` nodes); they get a ring afterwards.
  g.forEachNode((id) => g.setNodeAttribute(id, "fixed", g.degree(id) === 0));
  return g;
}

export function resetToSeeds(g: Graph<NeuronAttrs, SynapseAttrs>) {
  g.updateEachNodeAttributes((_, a) => ({ ...a, x: a.seedX, y: a.seedY }));
}

/** Place unwired neurons evenly on a ring just outside the wired component(s). */
export function ringUnwired(g: Graph<NeuronAttrs, SynapseAttrs>) {
  const wired = g.filterNodes((_, a) => !a.fixed);
  const unwired = g.filterNodes((_, a) => a.fixed).sort();
  if (!unwired.length) return;
  let cx = 0;
  let cy = 0;
  for (const id of wired) {
    cx += g.getNodeAttribute(id, "x") / wired.length;
    cy += g.getNodeAttribute(id, "y") / wired.length;
  }
  const reach = Math.max(80, ...wired.map((id) => Math.hypot(g.getNodeAttribute(id, "x") - cx, g.getNodeAttribute(id, "y") - cy)));
  const r = reach * 1.2 + 40;
  unwired.forEach((id, i) => {
    const a = (2 * Math.PI * i) / unwired.length - Math.PI / 2;
    g.mergeNodeAttributes(id, { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  });
}

function fa2Settings(g: Graph) {
  return {
    ...forceAtlas2.inferSettings(g),
    gravity: 0.8,
    scalingRatio: 20,
    slowDown: 4,
    edgeWeightInfluence: 0.5,
    barnesHutOptimize: false,
    // Node sizes are screen px vs ~±300 graph units: close enough for FA2's anti-overlap.
    adjustSizes: true,
    linLogMode: false,
  };
}

/** Deterministic synchronous layout (mini views, reduced motion). */
export function layoutSync(g: Graph<NeuronAttrs, SynapseAttrs>, iterations = 400) {
  forceAtlas2.assign(g, { iterations, settings: fa2Settings(g), getEdgeWeight: "weight" });
  ringUnwired(g);
}

/** Animated ForceAtlas2 in a web worker for `ms`, then stopped. Returns a cancel function. */
export function layoutAnimated(g: Graph<NeuronAttrs, SynapseAttrs>, ms: number, onDone: () => void): () => void {
  const fa2 = new FA2Layout(g, { settings: fa2Settings(g), getEdgeWeight: "weight" });
  fa2.start();
  const timer = setTimeout(() => {
    fa2.kill();
    ringUnwired(g);
    onDone();
  }, ms);
  return () => {
    clearTimeout(timer);
    fa2.kill();
  };
}
