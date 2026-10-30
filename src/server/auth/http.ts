// JSON API plumbing shared by the chain/auth routes. No Next.js imports (usable from the worker).
import { MissingConfigError } from "@/lib/env";

/** An error with an HTTP status and a user-presentable message. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const jsonError = (status: number, error: string) => Response.json({ error }, { status });

/** Maps thrown values to `{ error }` JSON responses (thrown `Response`s pass through). */
export function toErrorResponse(e: unknown): Response {
  if (e instanceof Response) return e;
  if (e instanceof HttpError) return jsonError(e.status, e.message);
  if (e instanceof MissingConfigError) return jsonError(503, e.message);
  console.error(e);
  return jsonError(500, e instanceof Error ? e.message : "Internal error");
}

/** Wraps a route handler so thrown errors become JSON responses. */
export function withApi<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      // Next.js control-flow errors (prerender bail-out of connection()/cookies(), redirect, notFound…) carry a
      // string `digest` and must propagate — swallowing them turns a dynamic route into a static error response.
      // (unstable_rethrow does this, but this module stays free of Next imports for the worker.)
      if (e instanceof Error && typeof (e as Error & { digest?: unknown }).digest === "string") throw e;
      return toErrorResponse(e);
    }
  };
}

/** Parses a JSON body; empty body → `{}`. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "Body must be a JSON object");
}
