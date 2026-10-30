/**
 * Same-origin avatar URLs + monogram text, shared by the UI, the sigma canvas and the avatar route
 * (src/app/api/avatar/[brainId]/route.ts, cache in src/server/avatars). Client-safe.
 */

export const AVATAR_SIZES = [64, 128, 256] as const;
export type AvatarPx = (typeof AVATAR_SIZES)[number];

/** Smallest cached size covering `px` CSS pixels at 2× density. */
export function avatarPx(px: number): AvatarPx {
  return AVATAR_SIZES.find((s) => s >= px * 2) ?? 256;
}

/** FNV-1a (32-bit, base36): short stable version tag for cache-busting URLs. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** One or two letters for a monogram ("Ansem" → "AN", "Trench Dame" → "TD"). */
export function monogram(name: string): string {
  const words = name
    .replace(/^@/, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return [...words[0]].slice(0, 2).join("").toUpperCase();
  return ([...words[0]][0] + [...words[1]][0]).toUpperCase();
}
