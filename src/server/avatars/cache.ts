/**
 * Brain pfp cache. Third-party image hosts often break hotlinking (403s without a browser fingerprint, CDN 404s), so pages never
 * load third-party pfps: `/api/avatar/<brainId>` serves the first candidate that downloads, cached on disk as
 * `<AVATARS_DIR>/<wallet>.<ext>` (original) + `<wallet>-<64|128|256>.webp` (resized with sharp when it loads) + a
 * `<wallet>.json` sidecar (source, fetchedAt, failures). Good images refresh after 14 days (a failed refresh keeps the
 * old file); a total failure is negative-cached for 24 h, during which the route serves a tier-coloured monogram.
 * Shared by the site (route) and the worker (`prewarmAvatars`); both write atomically, so racing them is harmless.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { eq } from "drizzle-orm";
import type sharpFn from "sharp";
import { getDb, schema } from "@/db/client";
import { env } from "@/lib/env";
import type { BrainTier, Provenance } from "@/db/schema";
import { AVATAR_SIZES, shortHash, type AvatarPx } from "@/lib/avatar";
import { brainTitle } from "@/lib/identity";
import type { DirectorySource, DirectorySourceId } from "@/server/directory/types";
import { downloadImage, HttpError, MAX_AVATAR_BYTES, type ImageType } from "./fetch";
import { monogramSvg } from "./monogram";

/** AVATARS_DIR (default data/avatars, relative to the working directory; use a persistent volume in production). */
const avatarDir = () => path.resolve(env().AVATARS_DIR);
const REFRESH_OK_SEC = 14 * 86_400;
const RETRY_FAILED_SEC = 86_400;
/** unavatar.io's anonymous quota is ~25 lookups/day per IP: after a 429, stop asking for an hour. */
const UNAVATAR_BACKOFF_MS = 3_600_000;
/** Worker prewarm pace: at most this many brains that need a download per second. */
const PREWARM_PER_SEC = 2;

/** Directory pfp order: the directory's own image first. */
const SOURCE_ORDER: DirectorySourceId[] = ["directory", "study"];

export type AvatarSource = "claimed" | DirectorySourceId | "public" | "unavatar";

interface Candidate {
  source: AvatarSource;
  url: string;
}

export interface AvatarMeta {
  brainId: string;
  wallet: string;
  /** Hash of the candidate URL list this outcome was computed for (a new list re-resolves). */
  key: string;
  status: "ok" | "failed";
  /** Original image file name in AVATARS_DIR. */
  file: string | null;
  type: ImageType | null;
  /** `<wallet>-<px>.webp` variants exist (sharp available at fetch time). */
  resized: boolean;
  source: AvatarSource | null;
  sourceUrl: string | null;
  /** unix s of the last resolve attempt (success, failed refresh, or failure). */
  fetchedAt: number;
  failures: { source: AvatarSource; url: string; error: string; at: number }[];
}

export interface AvatarBrain {
  id: string;
  wallet: string;
  codename: string;
  displayName: string | null;
  xHandle: string | null;
  status: "unclaimed" | "claimed";
  provenance: Provenance;
  tier: BrainTier;
  avatarUrl: string | null;
  publicAvatarUrl: string | null;
  sourcesJson: string;
}

const avatarColumns = {
  id: schema.brains.id,
  wallet: schema.brains.wallet,
  codename: schema.brains.codename,
  displayName: schema.brains.displayName,
  xHandle: schema.brains.xHandle,
  status: schema.brains.status,
  provenance: schema.brains.provenance,
  tier: schema.brains.tier,
  avatarUrl: schema.brains.avatarUrl,
  publicAvatarUrl: schema.brains.publicAvatarUrl,
  sourcesJson: schema.brains.sourcesJson,
};

export async function loadAvatarBrain(brainId: string): Promise<AvatarBrain | null> {
  const [row] = await getDb().select(avatarColumns).from(schema.brains).where(eq(schema.brains.id, brainId)).limit(1);
  return row ?? null;
}

/**
 * Candidate image URLs, best first; empty when the identity rules allow no likeness (src/lib/identity.ts: only
 * claimed and platform-attributed brains show a face).
 */
export function avatarCandidates(b: AvatarBrain): Candidate[] {
  const claimed = b.status === "claimed";
  if (!claimed && b.provenance !== "platform_attributed") return [];
  let sources: DirectorySource[] = [];
  try {
    sources = JSON.parse(b.sourcesJson) as DirectorySource[];
  } catch {
    // malformed sources_json: claimed / public / unavatar candidates still apply
  }
  const out: Candidate[] = [];
  const add = (source: AvatarSource, url: string | null | undefined) => {
    // X's default egg is worse than our monogram
    if (url && !url.includes("default_profile") && !out.some((c) => c.url === url)) out.push({ source, url });
  };
  if (claimed) add("claimed", b.avatarUrl);
  for (const s of [...sources].sort((x, y) => SOURCE_ORDER.indexOf(x.source) - SOURCE_ORDER.indexOf(y.source))) add(s.source, s.avatarUrl);
  add("public", b.publicAvatarUrl);
  const handle = b.xHandle ?? sources.find((s) => s.handle)?.handle;
  if (handle && /^[A-Za-z0-9_]{1,15}$/.test(handle)) add("unavatar", `https://unavatar.io/x/${handle}?fallback=false`);
  return out;
}

const metaPath = (wallet: string) => path.join(avatarDir(), `${wallet}.json`);
const variantName = (wallet: string, px: AvatarPx) => `${wallet}-${px}.webp`;

async function readMeta(wallet: string): Promise<AvatarMeta | null> {
  try {
    return JSON.parse(await readFile(metaPath(wallet), "utf8")) as AvatarMeta;
  } catch {
    return null;
  }
}

/** tmp + rename so a concurrent reader (site vs worker) never sees a half-written file; Windows may briefly lock. */
async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 4) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
      await sleep(50 * (attempt + 1));
    }
  }
}

type Sharp = typeof sharpFn;
let sharpLoad: Promise<Sharp | null> | null = null;

/** sharp is a native module: if its binary fails to load, the cache stores and serves original bytes instead. */
function loadSharp(): Promise<Sharp | null> {
  sharpLoad ??= import("sharp")
    .then((m) => m.default)
    .catch((err: unknown) => {
      console.warn(`[avatars] sharp unavailable, serving original images: ${err instanceof Error ? err.message : err}`);
      return null;
    });
  return sharpLoad;
}

/** Decodes (rejecting decompression bombs / garbage) and renders every served size; null without sharp. */
async function renderVariants(bytes: Buffer): Promise<Map<AvatarPx, Buffer> | null> {
  const sharp = await loadSharp();
  if (!sharp) return null;
  const out = new Map<AvatarPx, Buffer>();
  for (const px of AVATAR_SIZES) {
    const webp = await sharp(bytes, { limitInputPixels: 40_000_000, failOn: "error" })
      .timeout({ seconds: 10 })
      .rotate()
      .resize(px, px, { fit: "cover" })
      .webp({ quality: 82 })
      .toBuffer();
    out.set(px, webp);
  }
  return out;
}

let unavatarBlockedUntil = 0;
const inflight = new Map<string, Promise<AvatarMeta>>();

/** Walks the candidates until one downloads and decodes; records the outcome in the sidecar. */
async function resolve(b: AvatarBrain, cands: Candidate[], key: string, prev: AvatarMeta | null): Promise<AvatarMeta> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(b.wallet)) throw new Error(`unexpected wallet ${b.wallet}`);
  await mkdir(avatarDir(), { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  const failures: AvatarMeta["failures"] = [];
  for (const c of cands) {
    if (c.source === "unavatar" && Date.now() < unavatarBlockedUntil) {
      failures.push({ source: c.source, url: c.url, error: "skipped: unavatar rate limit backoff", at: now });
      continue;
    }
    try {
      const img = await downloadImage(c.url);
      const variants = await renderVariants(img.bytes);
      const file = `${b.wallet}.${img.type === "jpeg" ? "jpg" : img.type}`;
      await writeAtomic(path.join(avatarDir(), file), img.bytes);
      if (prev?.file && prev.file !== file) await unlink(path.join(avatarDir(), prev.file)).catch(() => {});
      for (const [px, webp] of variants ?? []) await writeAtomic(path.join(avatarDir(), variantName(b.wallet, px)), webp);
      const meta: AvatarMeta = {
        brainId: b.id,
        wallet: b.wallet,
        key,
        status: "ok",
        file,
        type: img.type,
        resized: variants != null,
        source: c.source,
        sourceUrl: c.url,
        fetchedAt: now,
        failures,
      };
      await writeAtomic(metaPath(b.wallet), JSON.stringify(meta, null, 2));
      return meta;
    } catch (err) {
      if (c.source === "unavatar" && err instanceof HttpError && err.status === 429) unavatarBlockedUntil = Date.now() + UNAVATAR_BACKOFF_MS;
      const error = (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 200);
      failures.push({ source: c.source, url: c.url, error, at: now });
    }
  }
  // A failed refresh keeps serving the cached image while its source is still a candidate.
  const keep = prev?.status === "ok" && cands.some((c) => c.url === prev.sourceUrl);
  const meta: AvatarMeta = keep
    ? { ...prev, key, fetchedAt: now, failures }
    : { brainId: b.id, wallet: b.wallet, key, status: "failed", file: null, type: null, resized: false, source: null, sourceUrl: null, fetchedAt: now, failures };
  await writeAtomic(metaPath(b.wallet), JSON.stringify(meta, null, 2));
  return meta;
}

/**
 * The brain's cached avatar state, resolving it when missing, for a changed candidate list, or after the failure
 * window; a stale good image is refreshed in the background (awaited with `wait`). null = no candidate at all.
 */
export async function ensureAvatar(b: AvatarBrain, opts: { wait?: boolean; force?: boolean } = {}): Promise<AvatarMeta | null> {
  const cands = avatarCandidates(b);
  if (cands.length === 0) return null;
  const key = shortHash(cands.map((c) => c.url).join("\n"));
  const running = inflight.get(b.wallet);
  if (running) return running;
  const prev = await readMeta(b.wallet);
  const age = Math.floor(Date.now() / 1000) - (prev?.fetchedAt ?? 0);
  if (!opts.force && prev?.key === key) {
    if (prev.status === "failed" && age < RETRY_FAILED_SEC) return prev;
    if (prev.status === "ok" && age < REFRESH_OK_SEC) return prev;
  }
  const p = resolve(b, cands, key, prev).finally(() => inflight.delete(b.wallet));
  inflight.set(b.wallet, p);
  if (prev?.status === "ok" && prev.key === key && !opts.wait && !opts.force) {
    p.catch((err: unknown) => console.warn(`[avatars] refresh ${b.id} failed: ${err instanceof Error ? err.message : err}`));
    return prev;
  }
  return p;
}

async function readImage(meta: AvatarMeta, px: AvatarPx): Promise<{ body: Buffer; contentType: string } | null> {
  if (meta.status !== "ok" || !meta.file) return null;
  try {
    if (meta.resized) return { body: await readFile(path.join(avatarDir(), variantName(meta.wallet, px))), contentType: "image/webp" };
    const body = await readFile(path.join(avatarDir(), meta.file));
    return body.length <= MAX_AVATAR_BYTES ? { body, contentType: `image/${meta.type}` } : null;
  } catch {
    return null;
  }
}

export interface AvatarResponse {
  body: Buffer;
  contentType: string;
  /** Where the image came from, or "monogram". */
  source: AvatarSource | "monogram";
  etag: string;
}

/** Image (or monogram) to serve for a brain at `px`. */
export async function avatarResponse(b: AvatarBrain, px: AvatarPx): Promise<AvatarResponse> {
  let meta = await ensureAvatar(b);
  let img = meta ? await readImage(meta, px) : null;
  // sidecar says ok but the file is gone (manual cleanup): re-fetch once
  if (meta?.status === "ok" && !img) {
    meta = await ensureAvatar(b, { force: true });
    img = meta ? await readImage(meta, px) : null;
  }
  const out = img
    ? { ...img, source: meta!.source ?? ("public" as const) }
    : { body: Buffer.from(monogramSvg(brainTitle(b), b.tier, px)), contentType: "image/svg+xml; charset=utf-8", source: "monogram" as const };
  return { ...out, etag: `"${createHash("sha1").update(out.body).digest("base64url").slice(0, 20)}"` };
}

/**
 * Worker task: resolves every listed brain's avatar ahead of page views, pacing downloads to PREWARM_PER_SEC
 * (cached, fresh entries cost no request). Returns per-source totals.
 */
export async function prewarmAvatars(opts: { shouldStop?: () => boolean; onProgress?: (msg: string) => void } = {}): Promise<string> {
  const rows = await getDb().select(avatarColumns).from(schema.brains).where(eq(schema.brains.listed, true));
  const bySource: Record<string, number> = {};
  let monograms = 0;
  let noLikeness = 0;
  let fetched = 0;
  const started = Math.floor(Date.now() / 1000);
  for (const [i, b] of rows.entries()) {
    if (opts.shouldStop?.()) break;
    const t0 = Date.now();
    const meta = await ensureAvatar(b, { wait: true }).catch((err: unknown) => {
      opts.onProgress?.(`${b.id}: ${err instanceof Error ? err.message : err}`);
      return undefined;
    });
    if (meta === null) noLikeness++;
    else if (meta?.status === "ok" && meta.source) bySource[meta.source] = (bySource[meta.source] ?? 0) + 1;
    else monograms++;
    if (meta && meta.fetchedAt >= started) {
      fetched++;
      const wait = 1000 / PREWARM_PER_SEC - (Date.now() - t0);
      if (wait > 0) await sleep(wait);
    }
    if ((i + 1) % 100 === 0) opts.onProgress?.(`${i + 1}/${rows.length} brains (${fetched} fetched)`);
  }
  const sources = Object.entries(bySource)
    .sort((x, y) => y[1] - x[1])
    .map(([s, n]) => `${s} ${n}`)
    .join(", ");
  return `${rows.length} brains: ${sources || "no images"}; monogram fallback ${monograms}; no likeness ${noLikeness} (${fetched} resolved now)`;
}
