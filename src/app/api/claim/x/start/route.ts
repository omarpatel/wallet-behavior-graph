import { connection } from "next/server";
import { MissingConfigError } from "@/lib/env";
import { getSession } from "@/server/auth/session";
import { XLinkError, startXLink } from "@/server/x/oauth";

export async function GET(req: Request) {
  await connection();
  const brainId = new URL(req.url).searchParams.get("brainId");
  if (!brainId) return Response.json({ error: "brainId is required" }, { status: 400 });
  const session = await getSession();
  if (!session) return Response.json({ error: "Sign in with the brain wallet first" }, { status: 401 });

  try {
    const url = await startXLink({ brainId, wallet: session.wallet });
    return Response.redirect(url, 302);
  } catch (err) {
    if (err instanceof XLinkError) return Response.json({ error: err.message }, { status: err.status });
    if (err instanceof MissingConfigError) return Response.json({ error: err.message }, { status: 503 });
    throw err;
  }
}
