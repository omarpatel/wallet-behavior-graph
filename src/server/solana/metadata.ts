// Metaplex JSON metadata + deterministic generative seat art. Unclaimed brains: codename only.
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { env } from "@/lib/env";
import type { BrainProfile } from "@/server/profile/types";
import { brainPublicName } from "./collection";

type Brain = typeof schema.brains.$inferSelect;

const DISCLAIMER =
  "Educational analysis of public on-chain activity. Not investment, financial, legal or tax advice. No recommendation to buy or sell. You may lose all funds.";

export async function loadBrainForMeta(brainId: string): Promise<Brain | null> {
  return (await getDb().query.brains.findFirst({ where: eq(schema.brains.id, brainId) })) ?? null;
}

function archetypeLabel(b: Brain): string {
  if (!b.profileJson) return "Unrated";
  try {
    return (JSON.parse(b.profileJson) as BrainProfile).archetype?.label ?? "Unrated";
  } catch {
    return "Unrated";
  }
}

const tierLabel = (b: Brain) => (b.tier === "unrated" ? "Unrated" : `Tier ${b.tier}`);

function description(b: Brain): string {
  const subject =
    b.status === "claimed"
      ? `${brainPublicName(b)}'s trading style (claimed by the wallet owner)`
      : `the public wallet codenamed ${b.codename} (unaffiliated analysis)`;
  return (
    `Access seat for the Wallet Behavior Graph analysis of ${subject}: live trade alerts with explanations and style coaching. ` +
    `Each seat carries an access term of ${b.termDays} days, renewable in the app; the remaining term travels with the seat. ` +
    `This is a membership/access tool, not an investment. ${DISCLAIMER}`
  );
}

export function collectionMetadata(b: Brain) {
  const base = env().PUBLIC_URL;
  return {
    name: `Wallet Behavior Graph: ${brainPublicName(b)}`,
    symbol: "KBRAIN",
    description: description(b),
    image: `${base}/api/meta/${b.id}/image.svg`,
    external_url: `${base}/brains/${b.id}`,
    attributes: [
      { trait_type: "Tier", value: tierLabel(b) },
      { trait_type: "Archetype", value: archetypeLabel(b) },
      { trait_type: "Seat supply", value: b.seatSupply },
      { trait_type: "Access term (days)", value: b.termDays },
    ],
    properties: {
      category: "image",
      files: [{ uri: `${base}/api/meta/${b.id}/image.svg`, type: "image/svg+xml" }],
    },
  };
}

export function seatMetadata(b: Brain, n: number) {
  const base = env().PUBLIC_URL;
  const image = `${base}/api/meta/${b.id}/image.svg?n=${n}`;
  return {
    name: `${brainPublicName(b)} Seat #${n}`,
    symbol: "KBRAIN",
    description: description(b),
    image,
    external_url: `${base}/brains/${b.id}`,
    attributes: [
      { trait_type: "Tier", value: tierLabel(b) },
      { trait_type: "Archetype", value: archetypeLabel(b) },
      { trait_type: "Seat number", value: n },
      { trait_type: "Seat supply", value: b.seatSupply },
      { trait_type: "Access term (days)", value: b.termDays },
    ],
    properties: { category: "image", files: [{ uri: image, type: "image/svg+xml" }] },
  };
}

// ---------------------------------------------------------------- art

const TIER_COLORS: Record<Brain["tier"], { a: string; b: string; glow: string }> = {
  S: { a: "#ffd66b", b: "#ff8a3d", glow: "#ffb547" },
  A: { a: "#c4b5fd", b: "#7c3aed", glow: "#a78bfa" },
  B: { a: "#67e8f9", b: "#0891b2", glow: "#22d3ee" },
  C: { a: "#6ee7b7", b: "#059669", glow: "#34d399" },
  unrated: { a: "#cbd5e1", b: "#475569", glow: "#94a3b8" },
};

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Deterministic byte stream from the brain wallet. */
function rng(seed: string) {
  let block = createHash("sha256").update(seed).digest();
  let i = 0;
  let counter = 0;
  return () => {
    if (i >= block.length) {
      block = createHash("sha256").update(seed).update(String(++counter)).digest();
      i = 0;
    }
    return block[i++] / 255;
  };
}

/** Neural-net style generative art: nodes on a brain-shaped field, tier-coloured, seat number badge. */
export function seatImageSvg(b: Brain, n: number | null): string {
  const c = TIER_COLORS[b.tier];
  const r = rng(b.wallet);
  const W = 1000;
  const cx = 500;
  const cy = 430;

  // Nodes inside two overlapping ellipses (hemispheres).
  const nodes: { x: number; y: number; s: number }[] = [];
  while (nodes.length < 46) {
    const left = nodes.length % 2 === 0;
    const ang = r() * Math.PI * 2;
    const rad = Math.sqrt(r());
    const x = cx + (left ? -95 : 95) + Math.cos(ang) * rad * 175;
    const y = cy + Math.sin(ang) * rad * 205;
    nodes.push({ x, y, s: 3 + r() * 7 });
  }
  const edges: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const dists = nodes
      .map((m, j) => ({ j, d: Math.hypot(m.x - nodes[i].x, m.y - nodes[i].y) }))
      .filter((e) => e.j > i)
      .sort((x, y) => x.d - y.d)
      .slice(0, 2 + Math.floor(r() * 2));
    for (const e of dists) {
      const m = nodes[e.j];
      const op = (0.18 + r() * 0.5).toFixed(2);
      edges.push(
        `<line x1="${nodes[i].x.toFixed(1)}" y1="${nodes[i].y.toFixed(1)}" x2="${m.x.toFixed(1)}" y2="${m.y.toFixed(1)}" stroke="url(#g)" stroke-width="${(1 + r() * 2).toFixed(1)}" opacity="${op}"/>`,
      );
    }
  }
  const dots = nodes
    .map(
      (p) =>
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.s.toFixed(1)}" fill="${r() > 0.7 ? c.a : "#e2e8f0"}" opacity="${(0.6 + r() * 0.4).toFixed(2)}"/>`,
    )
    .join("");
  const rings = Array.from({ length: 4 }, (_, k) => {
    const rad = 250 + k * 34 + r() * 10;
    const dash = `${(4 + r() * 30).toFixed(0)} ${(6 + r() * 24).toFixed(0)}`;
    return `<circle cx="${cx}" cy="${cy}" r="${rad.toFixed(0)}" fill="none" stroke="${c.glow}" stroke-width="${k === 0 ? 2 : 1}" stroke-dasharray="${dash}" opacity="${(0.5 - k * 0.1).toFixed(2)}" transform="rotate(${(r() * 360).toFixed(0)} ${cx} ${cy})"/>`;
  }).join("");

  const name = esc(brainPublicName(b));
  const tier = b.tier === "unrated" ? "UNRATED" : `TIER ${b.tier}`;
  const seatLine = n ? `SEAT #${n} / ${b.seatSupply}` : `${b.seatSupply} SEATS`;
  const nameSize = name.length > 22 ? 44 : 56;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}" width="${W}" height="${W}">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.a}"/><stop offset="1" stop-color="${c.b}"/></linearGradient>
<radialGradient id="bg" cx="0.5" cy="0.42" r="0.75"><stop offset="0" stop-color="#1e1b2e"/><stop offset="0.6" stop-color="#0d0b16"/><stop offset="1" stop-color="#05040a"/></radialGradient>
<radialGradient id="halo" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${c.glow}" stop-opacity="0.35"/><stop offset="1" stop-color="${c.glow}" stop-opacity="0"/></radialGradient>
<filter id="blur"><feGaussianBlur stdDeviation="3"/></filter>
</defs>
<rect width="${W}" height="${W}" fill="url(#bg)"/>
<circle cx="${cx}" cy="${cy}" r="330" fill="url(#halo)"/>
${rings}
<g filter="url(#blur)" opacity="0.6">${edges.join("")}</g>
<g>${edges.join("")}</g>
<g>${dots}</g>
<rect x="40" y="40" width="${W - 80}" height="${W - 80}" rx="36" fill="none" stroke="url(#g)" stroke-width="3" opacity="0.8"/>
<text x="80" y="110" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="28" letter-spacing="6" fill="${c.a}">WALLET BEHAVIOR GRAPH</text>
<g transform="translate(${W - 80} 82)"><rect x="-170" y="0" width="170" height="44" rx="22" fill="url(#g)"/><text x="-85" y="30" text-anchor="middle" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="22" font-weight="700" fill="#0b0a12">${tier}</text></g>
<text x="${cx}" y="800" text-anchor="middle" font-family="Inter,Segoe UI,Helvetica,Arial,sans-serif" font-size="${nameSize}" font-weight="700" fill="#f8fafc">${name}</text>
<text x="${cx}" y="860" text-anchor="middle" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="30" letter-spacing="4" fill="${c.a}">${seatLine}</text>
<text x="${cx}" y="912" text-anchor="middle" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="18" fill="#64748b">${esc(`${b.wallet.slice(0, 4)}…${b.wallet.slice(-4)} · ACCESS ${b.termDays}D`)}</text>
</svg>`;
}
