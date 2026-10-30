/**
 * Thin wrapper around a sigma v4 renderer plus a 2D overlay canvas for effects (pulses, spike travel along synapses,
 * rings, annotations). Browser-only: import it from components loaded with `next/dynamic({ ssr: false })`.
 */
import type Graph from "graphology";
import type { Attributes } from "graphology-types";
import { layerImage } from "@sigma/node-image";
import Sigma from "sigma";
import { extremityArrow, layerFill, pathCurved, sdfCircle } from "sigma/rendering";
import type { CameraState, EdgeDisplayData, NodeDisplayData } from "sigma/types";
import { CURVATURE } from "./lib";

/** Node display data plus the declared `image` variable (pfp URL; absent/empty = plain dot). */
export type PfpNodeDisplayData = NodeDisplayData & { image?: string };
type NodeReducer = (key: string, data: PfpNodeDisplayData, attrs: Attributes) => Partial<PfpNodeDisplayData>;
type EdgeReducer = (key: string, data: EdgeDisplayData, attrs: Attributes) => Partial<EdgeDisplayData>;

export interface StageOptions {
  interactive: boolean;
  reducedMotion: boolean;
  /** Labels shown only on hover (mini views) instead of sigma's density-based auto labels. */
  hoverLabelsOnly?: boolean;
  nodeReducer?: NodeReducer;
  edgeReducer?: EdgeReducer;
}

interface Pulse {
  node: string;
  color: string;
  start: number;
  dur: number;
  strength: number;
}
interface Travel {
  from: string;
  to: string;
  color: string;
  start: number;
  dur: number;
}
export interface Annotation {
  text: string;
  color: string;
}

type Vec = { x: number; y: number };

/** Gap between the pfp and the node edge, as a share of the diameter; the region colour shows through it as a ring. */
const PFP_RING = 0.12;

/** Extent of `values` without stragglers: drops those past a fence half the P10–P90 span outside P10/P90. */
function fenced(values: number[]): [number, number] {
  const v = [...values].sort((a, b) => a - b);
  const p10 = v[Math.floor((v.length - 1) * 0.1)];
  const p90 = v[Math.ceil((v.length - 1) * 0.9)];
  const lo = p10 - (p90 - p10) / 2;
  const hi = p90 + (p90 - p10) / 2;
  const kept = v.filter((x) => x >= lo && x <= hi);
  return [kept[0], kept[kept.length - 1]];
}

export class Stage {
  readonly sigma: Sigma;
  private readonly host: HTMLElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly ro: ResizeObserver;
  private readonly reducedMotion: boolean;
  private pulses: Pulse[] = [];
  private travels: Travel[] = [];
  private annotations = new Map<string, Annotation>();
  private rings = new Map<string, string>();
  private raf = 0;
  private dpr = 1;
  private killed = false;
  /** Nodes the home view frames (null = sigma's whole-graph bbox). */
  private fitNodes: string[] | null = null;

  constructor(host: HTMLElement, graph: Graph, opts: StageOptions) {
    this.host = host;
    this.reducedMotion = opts.reducedMotion;
    const font = getComputedStyle(document.body).fontFamily || "ui-sans-serif, system-ui, sans-serif";
    const userNode = opts.nodeReducer;
    const userEdge = opts.edgeReducer;

    this.sigma = new Sigma(graph, host, {
      primitives: {
        // Pfp neurons: the fill layer paints the region colour, the image layer draws the avatar inset by `padding`, so
        // the region colour reads as a ring. Nodes without an `image` get a transparent image layer (plain dot).
        nodes: {
          shapes: [sdfCircle()],
          variables: { image: { type: "string", default: "" } },
          layers: [
            layerFill(),
            layerImage({
              drawingMode: "image",
              padding: PFP_RING,
              textureManagerOptions: { crossOrigin: "anonymous", size: { mode: "force", value: 64 }, objectFit: "cover", debounceTimeout: 120 },
            }),
          ],
        },
        edges: { paths: [pathCurved()], extremities: [extremityArrow({ lengthRatio: 3.2, widthRatio: 2.6 })], defaultHead: "arrow" },
      },
      styles: {
        nodes: {
          x: { attribute: "x" },
          y: { attribute: "y" },
          size: { attribute: "size", defaultValue: 6 },
          color: { attribute: "color", defaultValue: "#7d858f" },
          label: { attribute: "label" },
          labelColor: "#d5dae0",
          labelSize: 12,
          labelFont: font,
          labelVisibility: opts.hoverLabelsOnly
            ? { whenState: "isHovered", then: "visible", else: "hidden" }
            : { whenState: "isHovered", then: "visible", else: "auto" },
          depth: { whenState: "isHovered", then: "topNodes", else: "nodes" },
          cursor: opts.interactive ? "pointer" : "default",
          backdropVisibility: "hidden",
          visibility: { whenState: "isHidden", then: "hidden", else: "visible" },
        },
        edges: {
          size: { attribute: "size", defaultValue: 1 },
          color: { attribute: "color", defaultValue: "#3a4048" },
          opacity: { attribute: "opacity", defaultValue: 0.6 },
          head: { attribute: "head", defaultValue: "arrow" },
          path: "curved",
          depth: { whenState: ["isHighlighted", "isHovered"], then: "topEdges", else: "edges" },
          visibility: { whenState: "isHidden", then: "hidden", else: "visible" },
        },
      },
      settings: {
        itemSizesReference: "screen",
        zoomToSizeRatioFunction: (r: number) => Math.sqrt(r),
        enableCameraZooming: opts.interactive,
        enableCameraPanning: opts.interactive,
        enableCameraRotation: false,
        enableCameraMouseRotation: false,
        gestureTarget: opts.interactive ? "graph" : "page",
        minCameraRatio: 0.08,
        maxCameraRatio: 4,
        labelDensity: 0.9,
        labelRenderedSizeThreshold: 9,
        stagePadding: 40,
        minEdgeThickness: 1,
        zoomDuration: opts.reducedMotion ? 0 : 250,
        inertiaDuration: opts.reducedMotion ? 0 : 200,
      },
      nodeReducer: (key, data, attrs) => {
        const out: PfpNodeDisplayData = userNode ? { ...data, ...userNode(key, data, attrs) } : { ...data };
        const boost = this.boost(key);
        if (boost !== 1) out.size = (out.size ?? 6) * boost;
        // Only real URLs may reach the image layer: it registers any string it sees, including "" (a failed load).
        if (!out.image) out.image = undefined;
        return out;
      },
      edgeReducer: userEdge ? (key, data, attrs) => userEdge(key, data, attrs) : undefined,
    });

    this.overlay = document.createElement("canvas");
    this.overlay.setAttribute("aria-hidden", "true");
    Object.assign(this.overlay.style, { position: "absolute", inset: "0", pointerEvents: "none", zIndex: "2" });
    host.appendChild(this.overlay);
    this.ctx = this.overlay.getContext("2d")!;
    this.sizeOverlay();
    this.sigma.on("afterRender", () => this.draw());

    this.ro = new ResizeObserver(() => {
      if (this.killed || this.host.offsetWidth === 0 || this.host.offsetHeight === 0) return;
      this.sigma.resize();
      this.sizeOverlay();
      this.sigma.scheduleRender();
    });
    this.ro.observe(host);
  }

  kill() {
    this.killed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.sigma.kill();
    this.overlay.remove();
  }

  /** Pulse a node (size tween + glow ring). No-op under reduced motion. */
  pulse(node: string, color: string, strength = 1, delayMs = 0) {
    if (this.killed || this.reducedMotion || !this.sigma.getGraph().hasNode(node)) return;
    this.pulses.push({ node, color, start: performance.now() + delayMs, dur: 1200, strength });
    this.loop();
  }

  /** Spike travelling along the synapse from → to (quadratic curve matching the rendered edge). */
  travel(from: string, to: string, color: string, delayMs = 0, durMs = 700) {
    if (this.killed || this.reducedMotion) return;
    const g = this.sigma.getGraph();
    if (!g.hasNode(from) || !g.hasNode(to)) return;
    this.travels.push({ from, to, color, start: performance.now() + delayMs, dur: durMs });
    this.loop();
  }

  setAnnotation(node: string, a: Annotation | null) {
    if (a) this.annotations.set(node, a);
    else this.annotations.delete(node);
    this.redraw();
  }

  clearAnnotations() {
    this.annotations.clear();
    this.redraw();
  }

  setRing(node: string, color: string | null) {
    if (color) this.rings.set(node, color);
    else this.rings.delete(node);
    this.redraw();
  }

  clearEffects() {
    this.pulses = [];
    this.travels = [];
    this.redraw();
  }

  flyTo(node: string, ratio = 0.7) {
    const d = this.killed ? undefined : this.sigma.getNodeDisplayData(node);
    if (!d) return;
    void this.sigma.getCamera().animate({ x: d.x, y: d.y, ratio }, { duration: this.reducedMotion ? 0 : 600 });
  }

  /**
   * Make `nodes` the home view (Fit button, cascade/path resets) and move the camera there. Camera rotation stays off
   * (a pinch must never turn the map), so when the layout turned a quarter frames clearly larger (a wide cluster on a
   * tall phone screen) the node positions are turned instead: layout orientation carries no meaning.
   */
  fitTo(nodes: string[]) {
    if (this.killed) return;
    this.fitNodes = nodes.length ? nodes : null;
    if (this.homeState(Math.PI / 2).ratio < this.homeState(0).ratio * 0.8) {
      this.sigma.getGraph().updateEachNodeAttributes((_, a) => ({ ...a, x: -a.y, y: a.x }));
    }
    this.resetCamera();
  }

  resetCamera() {
    if (this.killed) return;
    void this.sigma.getCamera().animate(this.homeState(0), { duration: this.reducedMotion ? 0 : 400 });
  }

  /**
   * Camera at `angle` framing the bulk of `fitNodes` inside the stage padding; stragglers beyond a fence on either axis
   * (half the 10th–90th percentile span past those percentiles) may fall outside.
   */
  private homeState(angle: number): CameraState {
    const home = { x: 0.5, y: 0.5, ratio: 1, angle };
    if (!this.fitNodes) return home;
    this.sigma.refresh(); // display data must reflect the latest layout positions
    const xs: number[] = [];
    const ys: number[] = [];
    for (const n of this.fitNodes) {
      const d = this.sigma.getNodeDisplayData(n);
      if (!d) continue;
      xs.push(d.x);
      ys.push(d.y);
    }
    if (!xs.length) return home;
    const [x0, x1] = fenced(xs);
    const [y0, y1] = fenced(ys);
    const { width, height } = this.sigma.getDimensions();
    const pad = this.sigma.getStagePadding();
    const cam = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, ratio: 1, angle };
    const pts = [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x0, y: y1 },
      { x: x1, y: y1 },
    ].map((c) => this.sigma.framedGraphToViewport(c, { cameraState: cam }));
    const w = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
    const h = Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));
    const ratio = Math.max(w / Math.max(1, width - 2 * pad), h / Math.max(1, height - 2 * pad));
    return { ...cam, ratio: Math.min(1, Math.max(this.sigma.getSetting("minCameraRatio") ?? 0, ratio)) };
  }

  zoom(factor: number) {
    if (this.killed) return;
    const cam = this.sigma.getCamera();
    void cam.animate({ ratio: cam.ratio / factor }, { duration: this.reducedMotion ? 0 : 200 });
  }

  /** Effects/annotation state changed: repaint (no-op once killed — late timers and effect cleanups land here). */
  private redraw() {
    if (!this.killed) this.sigma.scheduleRender();
  }

  /** Viewport position (CSS px) + radius of a node, or null when it isn't rendered. */
  nodeViewport(node: string): (Vec & { r: number }) | null {
    const d = this.sigma.getNodeDisplayData(node);
    if (!d || d.visibility === "hidden") return null;
    const p = this.sigma.framedGraphToViewport(d);
    return { x: p.x, y: p.y, r: this.sigma.scaleSize(d.size) };
  }

  private boost(node: string): number {
    if (!this.pulses.length) return 1;
    const now = performance.now();
    let b = 1;
    for (const p of this.pulses) {
      if (p.node !== node) continue;
      const t = (now - p.start) / p.dur;
      if (t < 0 || t > 1) continue;
      b = Math.max(b, 1 + 0.55 * p.strength * Math.sin(Math.PI * Math.min(1, t * 1.6)) * (1 - t));
    }
    return b;
  }

  private sizeOverlay() {
    this.dpr = window.devicePixelRatio || 1;
    const w = this.host.offsetWidth;
    const h = this.host.offsetHeight;
    this.overlay.width = Math.max(1, Math.round(w * this.dpr));
    this.overlay.height = Math.max(1, Math.round(h * this.dpr));
    this.overlay.style.width = `${w}px`;
    this.overlay.style.height = `${h}px`;
  }

  private loop() {
    if (this.raf || this.killed) return;
    const tick = () => {
      this.raf = 0;
      if (this.killed) return;
      const now = performance.now();
      this.pulses = this.pulses.filter((p) => now - p.start < p.dur);
      this.travels = this.travels.filter((t) => now - t.start < t.dur + 400);
      const pulsing = [...new Set(this.pulses.map((p) => p.node))];
      if (pulsing.length) this.sigma.scheduleRefresh({ partialGraph: { nodes: pulsing }, skipIndexation: true });
      else this.sigma.scheduleRender();
      if (this.pulses.length || this.travels.length) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Control point of the rendered curved edge, computed in framed-graph space then projected. */
  private curve(from: string, to: string): [Vec, Vec, Vec] | null {
    const a = this.sigma.getNodeDisplayData(from);
    const b = this.sigma.getNodeDisplayData(to);
    if (!a || !b) return null;
    const g = this.sigma.getGraph();
    const edge = g.edge(from, to);
    const k: number = edge != null ? (g.getEdgeAttribute(edge, "curvature") ?? CURVATURE) : CURVATURE;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const c = { x: mx - (b.y - a.y) * k, y: my + (b.x - a.x) * k };
    return [this.sigma.framedGraphToViewport(a), this.sigma.framedGraphToViewport(c), this.sigma.framedGraphToViewport(b)];
  }

  private draw() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const now = performance.now();

    for (const [node, color] of this.rings) {
      const v = this.nodeViewport(node);
      if (!v) continue;
      ctx.beginPath();
      ctx.arc(v.x, v.y, v.r + 3.5, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    for (const t of this.travels) {
      const k = (now - t.start) / t.dur;
      if (k < 0) continue;
      const pts = this.curve(t.from, t.to);
      if (!pts) continue;
      const [p0, c, p1] = pts;
      const fade = k > 1 ? Math.max(0, 1 - (k - 1) / 0.6) : 1;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.quadraticCurveTo(c.x, c.y, p1.x, p1.y);
      ctx.strokeStyle = withAlpha(t.color, 0.55 * fade);
      ctx.lineWidth = 2;
      ctx.stroke();
      if (k <= 1) {
        const e = easeInOut(k);
        const x = (1 - e) * (1 - e) * p0.x + 2 * (1 - e) * e * c.x + e * e * p1.x;
        const y = (1 - e) * (1 - e) * p0.y + 2 * (1 - e) * e * c.y + e * e * p1.y;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, 9);
        glow.addColorStop(0, withAlpha(t.color, 0.95));
        glow.addColorStop(1, withAlpha(t.color, 0));
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, 9, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    for (const p of this.pulses) {
      const k = (now - p.start) / p.dur;
      if (k < 0 || k > 1) continue;
      const v = this.nodeViewport(p.node);
      if (!v) continue;
      const r = v.r * (1 + 1.8 * p.strength * k) + 4;
      const glow = ctx.createRadialGradient(v.x, v.y, v.r * 0.6, v.x, v.y, r * 1.25);
      glow.addColorStop(0, withAlpha(p.color, 0.45 * (1 - k)));
      glow.addColorStop(1, withAlpha(p.color, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(v.x, v.y, r * 1.25, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(v.x, v.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = withAlpha(p.color, 0.9 * (1 - k));
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    if (this.annotations.size) {
      ctx.font = "500 11px ui-monospace, SFMono-Regular, monospace";
      ctx.textBaseline = "middle";
      for (const [node, a] of this.annotations) {
        const v = this.nodeViewport(node);
        if (!v) continue;
        const w = ctx.measureText(a.text).width + 10;
        const x = v.x + v.r * 0.7 + 4;
        const y = v.y - v.r * 0.7 - 10;
        ctx.fillStyle = "rgba(10,12,14,0.88)";
        ctx.strokeStyle = withAlpha(a.color, 0.7);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x, y - 8, w, 16, 8);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = a.color;
        ctx.fillText(a.text, x + 5, y + 0.5);
      }
    }
  }
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/** `#rrggbb` → `rgba(r,g,b,a)`; other color strings pass through. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}
