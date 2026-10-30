import { connection } from "next/server";
import { env, MissingConfigError } from "@/lib/env";
import { getSession } from "@/server/auth/session";
import { XLinkError, completeXLink, consumeXState } from "@/server/x/oauth";

function back(brainId: string | null, params: Record<string, string>) {
  const url = new URL(brainId ? `/brains/${encodeURIComponent(brainId)}` : "/", env().PUBLIC_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return Response.redirect(url, 303);
}

export async function GET(req: Request) {
  await connection();
  const q = new URL(req.url).searchParams;
  const state = q.get("state");
  const code = q.get("code");
  if (!state) return Response.json({ error: "Missing state" }, { status: 400 });

  // User denied on X (or X returned an error): consume the state and go back to the brain page.
  if (!code) {
    const brainId = await consumeXState(state).then((s) => s.brainId).catch(() => null);
    return back(brainId, { x: "error", reason: q.get("error") ?? "no_code" });
  }

  const session = await getSession();
  if (!session) return Response.json({ error: "Sign in with the brain wallet first" }, { status: 401 });

  try {
    const { brainId } = await completeXLink({ state, code, wallet: session.wallet });
    return back(brainId, { x: "linked" });
  } catch (err) {
    if (err instanceof XLinkError) {
      console.error(`[x-link] ${err.message}`);
      return err.brainId ? back(err.brainId, { x: "error", reason: err.message }) : Response.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof MissingConfigError) return Response.json({ error: err.message }, { status: 503 });
    throw err;
  }
}
