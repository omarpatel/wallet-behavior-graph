/**
 * Downloads one untrusted third-party avatar: https only, public hosts only (claimed avatar URLs are user input),
 * browser-like headers (+ the source site's Referer for hotlink-protected hosts), bounded size and time, and only
 * raster image bytes (sniffed: some hosts answer `binary/octet-stream`; SVG is refused since it would be served from
 * our origin).
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 3;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const ACCEPT = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";

/** Hotlink-protected hosts want their own site as Referer. */
const REFERER: Record<string, string> = {
  "pump.mypinata.cloud": "https://pump.fun/",
  "socialimages.pump.fun": "https://pump.fun/",
};

export type ImageType = "jpeg" | "png" | "gif" | "webp" | "avif";

export interface Downloaded {
  bytes: Buffer;
  type: ImageType;
}

/** HTTP failure with the upstream status (unavatar's 429 is handled by the caller). */
export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export async function downloadImage(url: string): Promise<Downloaded> {
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    if (current.protocol !== "https:") throw new Error(`refused non-https URL ${current.protocol}`);
    await assertPublicHost(current.hostname);
    const referer = REFERER[current.hostname];
    const headers: Record<string, string> = { "user-agent": UA, accept: ACCEPT, "accept-language": "en-US,en;q=0.9", ...(referer ? { referer } : {}) };

    const res = await fetch(current, { headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");
      current = new URL(location, current);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new HttpError(res.status);
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_AVATAR_BYTES) {
      await res.body?.cancel();
      throw new Error(`too large (${declared} bytes)`);
    }
    return checkImage(await readCapped(res), res.headers.get("content-type"));
  }
}

async function readCapped(res: Response): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_AVATAR_BYTES) {
      await reader.cancel();
      throw new Error(`too large (> ${MAX_AVATAR_BYTES} bytes)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Declared type must be an image or generic binary; the bytes must be a raster format we can serve. */
function checkImage(bytes: Buffer, contentType: string | null): Downloaded {
  const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (ct && !ct.startsWith("image/") && ct !== "application/octet-stream" && ct !== "binary/octet-stream") {
    throw new Error(`not an image (${ct})`);
  }
  if (bytes.length === 0) throw new Error("empty body");
  const type = sniff(bytes);
  if (!type) throw new Error(`unsupported image bytes (${ct || "no content-type"})`);
  return { bytes, type };
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sniff(b: Buffer): ImageType | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.subarray(0, 8).equals(PNG_MAGIC)) return "png";
  if (b.toString("latin1", 0, 4) === "GIF8") return "gif";
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (b.toString("latin1", 4, 8) === "ftyp" && /^avi[fs]$/.test(b.toString("latin1", 8, 12))) return "avif";
  return null;
}

/** SSRF guard: every address the host resolves to must be public unicast. */
async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || /\.(localhost|internal|local)$/.test(host)) throw new Error(`refused private host ${host}`);
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  for (const { address } of addrs) if (isPrivateIp(address)) throw new Error(`refused private address ${address} for ${host}`);
}

function isPrivateIp(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPrivateIp(mapped[1]);
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b < 128) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b < 32) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff");
}
