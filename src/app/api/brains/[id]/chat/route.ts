import { connection } from "next/server";
import { z } from "zod";
import { MissingConfigError } from "@/lib/env";
import { hasBrainAccess } from "@/server/access";
import { AiUnavailableError } from "@/server/ai/client";
import { CHAT_MAX_CHARS, ChatRateLimitError, chatQuota, getChatHistory, streamChat } from "@/server/ai/chat";
import { loadBrain } from "@/server/ai/context";
import { getSession } from "@/server/auth/session";

const body = z.object({ message: z.string().trim().min(1).max(CHAT_MAX_CHARS) });

/** Session + seat gate shared by GET/POST. Returns the wallet or a JSON error response. */
async function gate(brainId: string): Promise<{ wallet: string } | Response> {
  if (!(await loadBrain(brainId))) return Response.json({ error: "Brain not found" }, { status: 404 });
  const session = await getSession();
  const access = await hasBrainAccess(session?.wallet ?? null, brainId);
  if (!session || access.reason === "signed_out") {
    return Response.json({ error: "Sign in with your wallet first" }, { status: 401 });
  }
  if (!access.ok) {
    return Response.json(
      { error: access.reason === "expired" ? "Your seat's access term has expired" : "A seat is required to chat with this brain", reason: access.reason },
      { status: 403 },
    );
  }
  return { wallet: session.wallet };
}

export async function GET(_req: Request, ctx: RouteContext<"/api/brains/[id]/chat">) {
  await connection();
  const { id } = await ctx.params;
  const g = await gate(id);
  if (g instanceof Response) return g;
  const [messages, quota] = await Promise.all([getChatHistory(id, g.wallet), chatQuota(id, g.wallet)]);
  return Response.json({ messages, remaining: quota.remaining });
}

export async function POST(req: Request, ctx: RouteContext<"/api/brains/[id]/chat">) {
  await connection();
  const { id } = await ctx.params;
  const g = await gate(id);
  if (g instanceof Response) return g;

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: `message must be 1–${CHAT_MAX_CHARS} characters` }, { status: 400 });
  }

  try {
    const stream = await streamChat({ brainId: id, wallet: g.wallet, message: parsed.data.message, signal: req.signal });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    if (err instanceof ChatRateLimitError) {
      return Response.json({ error: err.message }, { status: 429, headers: { "Retry-After": String(err.retryAfterSec) } });
    }
    if (err instanceof MissingConfigError || err instanceof AiUnavailableError) {
      return Response.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
