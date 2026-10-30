import type { BrainTier } from "@/db/schema";
import { monogram } from "@/lib/avatar";

/** Tier → [background, ink] (globals.css accent / info / ink-2 / mute over a tinted panel). */
const TIER_COLORS: Record<BrainTier, [string, string]> = {
  S: ["#1d2a14", "#c6ff3a"],
  A: ["#14222d", "#7cc4ff"],
  B: ["#1a1d21", "#b9bfc6"],
  C: ["#15181b", "#7d858f"],
  unrated: ["#12161a", "#7d858f"],
};

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

/**
 * Square tier-coloured monogram served when no pfp resolves (or the identity rules allow no likeness). Explicit
 * width/height so WebGL texture loaders (sigma pfp nodes) rasterize it at the requested size.
 */
export function monogramSvg(name: string, tier: BrainTier, px: number): string {
  const [bg, ink] = TIER_COLORS[tier];
  const text = monogram(name).replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 100 100">` +
    `<rect width="100" height="100" fill="${bg}"/>` +
    `<text x="50" y="50" dy="0.35em" text-anchor="middle" fill="${ink}" font-family="ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif" font-size="38" font-weight="600">${text}</text>` +
    `</svg>`
  );
}
