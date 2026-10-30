import type { NeuronDTO, SynapseDTO } from "@/server/connectome/types";
import { fmtDuration } from "@/lib/format";

/** Palette slots defined in globals.css (`--color-region-N`). Singleton regions render neutral. */
export const REGION_SLOTS = 10;
export const SOLITARY_COLOR = "#7d858f";
export const DIM_NODE = "#1b2026";
export const DIM_EDGE = "#14181c";
export const BUY_COLOR = "#35d48f";
export const SELL_COLOR = "#ff5d73";
export const ACCENT = "#c6ff3a";
/** Edge bend (fraction of edge length). Sigma reads it from the `curvature` edge attribute; the overlay matches it. */
export const CURVATURE = 0.14;

const FALLBACK_PALETTE = ["#7cc4ff", "#c792ff", "#ffb648", "#4fe3d0", "#ff8ad8", "#c6ff3a", "#8fa8ff", "#ffd36e", "#ff9f6e", "#9ee6ff"];

/** CSS custom property for a region (used by React swatches; sigma reads resolved colors via `readPalette`). */
export function regionCssColor(region: number, size: number): string {
  return size <= 1 ? SOLITARY_COLOR : `var(--color-region-${region % REGION_SLOTS})`;
}

/** Resolved hex palette from the CSS variables (sigma needs concrete colors). Browser only. */
export function readPalette(): string[] {
  const cs = getComputedStyle(document.documentElement);
  return FALLBACK_PALETTE.map((fallback, i) => cs.getPropertyValue(`--color-region-${i}`).trim() || fallback);
}

export function regionColor(palette: string[], region: number, size: number): string {
  return size <= 1 ? SOLITARY_COLOR : palette[region % palette.length];
}

/** Deterministic 0..1 hash so seeded layouts are stable across loads. */
export function hash01(s: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100_000) / 100_000;
}

export const edgeKey = (pre: string, post: string) => `${pre}->${post}`;

export const fmtLag = (sec: number) => `+${fmtDuration(sec)}`;

export function sampleSymbols(s: SynapseDTO, n = 3): string {
  const syms = [...new Set(s.sample.map((x) => x.symbol).filter((x): x is string => !!x))].slice(0, n);
  return syms.length ? syms.map((x) => `$${x}`).join(" ") : "—";
}

/** Node radius (screen px at camera ratio 1) from normalised PageRank. The 6px floor keeps a pfp legible inside its ring. */
export function neuronSize(n: Pick<NeuronDTO, "pagerank">, scale = 1): number {
  return (6 + 14 * Math.sqrt(Math.max(0, n.pagerank))) * scale;
}

const RANK_STOPS = ["#c6ff3a", "#4fe3d0", "#7cc4ff", "#c792ff", "#ff8ad8"];

/** FlyWire-style rank colouring: earliest (rank 1 / depth 1) = lime → latest = pink. */
export function rankColor(rank: number, maxRank: number): string {
  const t = maxRank <= 1 ? 0 : Math.min(1, Math.max(0, (rank - 1) / (maxRank - 1)));
  const f = t * (RANK_STOPS.length - 1);
  const i = Math.min(RANK_STOPS.length - 2, Math.floor(f));
  const k = f - i;
  const a = parseInt(RANK_STOPS[i].slice(1), 16);
  const b = parseInt(RANK_STOPS[i + 1].slice(1), 16);
  const mix = (shift: number) => Math.round(((a >> shift) & 255) * (1 - k) + ((b >> shift) & 255) * k);
  return `#${((mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).padStart(6, "0")}`;
}

/**
 * Plasticity: synapses fade with time since their last co-entry (half-life ~3 days), floored so old wiring stays
 * visible.
 */
export function synapseOpacity(lastEventAt: number, nowSec: number): number {
  const age = Math.max(0, nowSec - lastEventAt);
  return 0.18 + 0.67 * Math.pow(0.5, age / (3 * 86_400));
}

/**
 * Region-seeded initial positions: region centroids on a circle (largest region first), members jittered around
 * them by a hash of their id. Gives ForceAtlas2 the same starting point every load, so the map is stable.
 */
export function seedPosition(n: NeuronDTO, regionIndex: number, regionCount: number): { x: number; y: number } {
  const angle = (2 * Math.PI * regionIndex) / Math.max(1, regionCount) + 0.3;
  const ring = regionCount <= 1 ? 0 : 120;
  const jitterA = hash01(n.id, 1) * 2 * Math.PI;
  const jitterR = 20 + 35 * hash01(n.id, 2);
  return { x: Math.cos(angle) * ring + Math.cos(jitterA) * jitterR, y: Math.sin(angle) * ring + Math.sin(jitterA) * jitterR };
}

export function relTime(unixSec: number, nowSec: number): string {
  const d = nowSec - unixSec;
  if (d < 5) return "just now";
  return `${fmtDuration(d)} ago`;
}
