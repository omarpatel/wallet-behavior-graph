import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";

/**
 * Geo-block: UK (FCA financial-promotion regime) + OFAC comprehensive
 * sanctions, configurable via BLOCKED_COUNTRIES. Country comes from the edge (Vercel / Cloudflare).
 */
export function proxy(request: NextRequest) {
  const country = (request.headers.get("x-vercel-ip-country") ?? request.headers.get("cf-ipcountry") ?? "").toUpperCase();
  if (!country || !env().BLOCKED_COUNTRIES.includes(country)) return NextResponse.next();

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return Response.json({ error: "Not available in your region" }, { status: 451 });
  }
  return NextResponse.rewrite(new URL("/blocked", request.url), { status: 451 });
}

export const config = {
  matcher: [
    // Everything except: the blocked page itself, Next internals, Helius webhook + NFT metadata
    // (server-to-server / marketplace fetches) and static files.
    "/((?!blocked|_next/static|_next/image|api/helius/webhook|api/meta|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|woff2?)$).*)",
  ],
};
