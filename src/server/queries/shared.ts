import "server-only";
import { schema } from "@/db/client";
import type { BrainTier, Provenance } from "@/db/schema";
import type { BrainProfile } from "@/server/profile/types";

/** Identity fields every brain surface needs to render the title/attribution correctly. */
export interface BrainIdentity {
  id: string;
  /** = id: the face key shared with rows whose own `id` is something else (sale, trade); keys /api/avatar/<brainId>. */
  brainId: string;
  wallet: string;
  codename: string;
  displayName: string | null;
  xHandle: string | null;
  provenance: Provenance;
  provenanceSource: string | null;
  status: "unclaimed" | "claimed";
  avatarUrl: string | null; // claimed brains only
  publicAvatarUrl: string | null; // KOL directory pfp (shown for platform-attributed brains)
}

/** The identity subset needed to render a brain's name + avatar (see src/lib/identity.ts). */
export type BrainFace = Pick<
  BrainIdentity,
  "brainId" | "codename" | "displayName" | "xHandle" | "provenance" | "status" | "avatarUrl" | "publicAvatarUrl"
>;

/** Drizzle select columns for `BrainFace` (spread into a select over `brains`). */
export const faceColumns = {
  brainId: schema.brains.id,
  codename: schema.brains.codename,
  displayName: schema.brains.displayName,
  xHandle: schema.brains.xHandle,
  provenance: schema.brains.provenance,
  status: schema.brains.status,
  avatarUrl: schema.brains.avatarUrl,
  publicAvatarUrl: schema.brains.publicAvatarUrl,
};

export function parseProfile(json: string | null): BrainProfile | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as BrainProfile;
  } catch {
    return null;
  }
}

export function parseJson<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export const nowSec = () => Math.floor(Date.now() / 1000);

export const TIERS: BrainTier[] = ["S", "A", "B", "C", "unrated"];
