import { AVATAR_SIZES } from "@/lib/avatar";
import { avatarResponse, loadAvatarBrain } from "@/server/avatars/cache";

/** Versioned URLs (`v` from brainAvatar()) change on identity edits; the server re-fetches the image every 14 days. */
const IMAGE_CACHE = "public, max-age=1209600, immutable";
/** Monograms may turn into a real image once the 24 h negative cache expires; unversioned URLs aren't immutable. */
const SHORT_CACHE = "public, max-age=3600";

/**
 * A brain's pfp from the local avatar cache (src/server/avatars/cache.ts) at `s` = 64 | 128 | 256 px (default 128),
 * or a tier-coloured SVG monogram when no source resolves or the identity rules allow no likeness.
 */
export async function GET(req: Request, { params }: { params: Promise<{ brainId: string }> }) {
  const { brainId } = await params;
  const sp = new URL(req.url).searchParams;
  const px = AVATAR_SIZES.find((s) => String(s) === sp.get("s")) ?? 128;
  const brain = brainId.length <= 64 ? await loadAvatarBrain(brainId) : null;
  if (!brain) return Response.json({ error: "Brain not found" }, { status: 404 });

  const img = await avatarResponse(brain, px);
  const headers = {
    "content-type": img.contentType,
    "cache-control": img.source === "monogram" || !sp.has("v") ? SHORT_CACHE : IMAGE_CACHE,
    etag: img.etag,
    "x-avatar-source": img.source,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  };
  if (req.headers.get("if-none-match") === img.etag) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(img.body), { headers });
}
