import { connection } from "next/server";
import { firingsAfter, latestTradeId, recentFirings } from "@/server/connectome/firing";
import type { FiringDTO } from "@/server/connectome/types";

const POLL_MS = 1_500;
const HEARTBEAT_MS = 15_000;
const BACKLOG = 30;
const SCAN = 200;

/**
 * Public SSE of neural firing: one `fire` event per live trade, brain level only (no token). The DB is the bus:
 * every 1.5s we read live trades above the cursor. `id:` is the trade id; `Last-Event-ID` resumes after it,
 * otherwise the last 30 firings are replayed first.
 */
export async function GET(req: Request) {
  await connection();
  const lastEventId = Number(req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("lastEventId") ?? NaN);
  const resumeFrom = Number.isInteger(lastEventId) && lastEventId >= 0 ? lastEventId : null;

  const encoder = new TextEncoder();
  const signal = req.signal;
  let timers: NodeJS.Timeout[] = [];
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        for (const t of timers) clearInterval(t);
        timers = [];
        signal.removeEventListener("abort", close);
        try {
          controller.close();
        } catch {}
      };
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          close();
        }
      };
      signal.addEventListener("abort", close);

      let cursor = 0;
      const send = (f: FiringDTO) => {
        write(`event: fire\nid: ${f.id}\ndata: ${JSON.stringify(f)}\n\n`);
        cursor = Math.max(cursor, f.id);
      };

      try {
        write(`retry: 3000\n\n`);
        if (resumeFrom != null) {
          cursor = resumeFrom;
          for (const f of await firingsAfter(cursor, SCAN)) send(f);
        } else {
          const backlog = await recentFirings(BACKLOG);
          for (const f of backlog) send(f);
          if (!backlog.length) cursor = await latestTradeId();
        }
      } catch (err) {
        console.error(`[connectome/stream] ${err instanceof Error ? err.message : err}`);
        close();
        return;
      }

      let polling = false;
      timers.push(
        setInterval(async () => {
          if (closed || polling) return;
          polling = true;
          try {
            for (const f of await firingsAfter(cursor, SCAN)) send(f);
          } catch (err) {
            console.error(`[connectome/stream] ${err instanceof Error ? err.message : err}`);
          } finally {
            polling = false;
          }
        }, POLL_MS),
        setInterval(() => write(`: ping\n\n`), HEARTBEAT_MS),
      );
    },
    cancel() {
      closed = true;
      for (const t of timers) clearInterval(t);
      timers = [];
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
