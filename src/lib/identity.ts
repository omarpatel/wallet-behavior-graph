/**
 * Public identity rules for brain surfaces:
 * - claimed → the owner's chosen name/avatar (verified);
 * - platform-attributed (the wallet directory lists it with a public label) → that public name and pfp, always with
 *   the source label ("via Public directory") and the unaffiliated banner on the brain page;
 * - community-attributed / unattributed → neutral codename, no likeness.
 * The codename stays a secondary label everywhere and is the only name in seat NFT metadata.
 * Client-safe (no server imports).
 */
import type { BrainTier, Provenance } from "@/db/schema";
import type { DirectorySource, DirectorySourceId } from "@/server/directory/types";
import { shortHash } from "./avatar";

export interface IdentityFields {
  brainId: string;
  codename: string;
  displayName: string | null;
  xHandle: string | null;
  provenance: Provenance;
  status: "unclaimed" | "claimed";
  /** KOL-provided avatar (claimed brains only). */
  avatarUrl: string | null;
  /** pfp published by the wallet directory. */
  publicAvatarUrl: string | null;
}

/** True when the title is a person's public name rather than the neutral codename. */
export function showsPublicName(b: Pick<IdentityFields, "status" | "provenance" | "displayName" | "xHandle">): boolean {
  if (b.status === "claimed") return !!b.displayName;
  return b.provenance === "platform_attributed" && !!(b.displayName || b.xHandle);
}

export function brainTitle(b: Pick<IdentityFields, "status" | "provenance" | "displayName" | "xHandle" | "codename">): string {
  if (!showsPublicName(b)) return b.codename;
  return b.displayName ?? `@${b.xHandle}`;
}

/**
 * Same-origin cached pfp route (src/app/api/avatar/[brainId]/route.ts; consumers append `&s=<AvatarPx>` from
 * src/lib/avatar.ts), or null when the identity rules allow no likeness or nothing could resolve one. The route walks
 * the claimed avatar, every directory pfp and unavatar.io for the X handle, and serves a monogram if all fail. `v`
 * versions the URL on identity changes (responses are cached immutably).
 */
export function brainAvatar(
  b: Pick<IdentityFields, "brainId" | "status" | "provenance" | "avatarUrl" | "publicAvatarUrl" | "xHandle">,
): string | null {
  const claimed = b.status === "claimed";
  if (!claimed && b.provenance !== "platform_attributed") return null;
  if (!(claimed && b.avatarUrl) && !b.publicAvatarUrl && !b.xHandle) return null;
  const version = shortHash([b.status, b.provenance, claimed ? b.avatarUrl : "", b.publicAvatarUrl, b.xHandle].join("|"));
  return `/api/avatar/${encodeURIComponent(b.brainId)}?v=${version}`;
}

/** Only the fields an avatar needs (never serialize a whole BrainDetail into a client component's props). */
export function pickFace<T extends IdentityFields & { tier?: BrainTier }>(b: T): IdentityFields & { tier?: BrainTier } {
  return {
    brainId: b.brainId,
    codename: b.codename,
    displayName: b.displayName,
    xHandle: b.xHandle,
    provenance: b.provenance,
    status: b.status,
    avatarUrl: b.avatarUrl,
    publicAvatarUrl: b.publicAvatarUrl,
    tier: b.tier,
  };
}

export const SOURCE_LABEL: Record<DirectorySourceId, string> = {
  directory: "Public directory",
  study: "Early-entry study",
};

/** Directory order for chips / "via" labels (most authoritative public roster first). */
export const SOURCE_ORDER: DirectorySourceId[] = ["directory", "study"];

export function sortSources(sources: DirectorySource[]): DirectorySource[] {
  return [...sources].sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));
}

/** Tier → avatar ring colour class. */
export const TIER_RING: Record<BrainTier, string> = {
  S: "ring-accent",
  A: "ring-info",
  B: "ring-ink-2/60",
  C: "ring-line-2",
  unrated: "ring-line",
};

export function telegramUrl(telegram: string | null): string | null {
  if (!telegram) return null;
  if (/^https?:\/\//i.test(telegram)) return telegram.replace(/^http:/i, "https:");
  return `https://t.me/${telegram.replace(/^@/, "")}`;
}

export function fmtFollowers(n: number | null): string | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
}
