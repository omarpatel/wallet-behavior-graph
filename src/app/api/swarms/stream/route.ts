import { connection } from "next/server";
import { getSession } from "@/server/auth/session";
import { PUBLIC_DELAY_SEC } from "@/server/connectome/types";
import { changedSwarmRows, newestSwarmRows, swarmDTOs, swarmViewer, type SwarmViewer } from "@/server/signals/queries";
import { SWARM_ACTIVE_SEC, type SwarmDTO } from "@/server/signals/types";

const POLL_MS = 2_000;
const HEARTBEAT_MS = 15_000;
const VIEWER_RECHECK_MS = 60_000;
const BACKLOG = 20;

/**
 * Public SSE of swarms: a `swarm` event (SwarmDTO) when a swarm forms, gains a member, or its token is revealed to
 * this viewer (hidden → visible after PUBLIC_DELAY_SEC, or a seat was bought). The DB is the bus: every 2 s we read
 * swarms that are new or recent enough to still change. The newest 20 swarms are sent first as backlog.
 * Swarms reconstructed from history (old lastJoinAt) are not pushed live; they appear in GET /api/swarms.
 */
export async function GET(req: Request) {
  await connection();
  const wallet = (await getSession())?.wallet ?? null;
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

      let viewer: SwarmViewer = { all: false, brainIds: new Set() };
      let maxId = 0;
      /** What this client last saw per swarm id: member count + hidden flag. */
      const seen = new Map<number, { members: number; hidden: boolean }>();
      const send = (s: SwarmDTO) => {
        seen.set(s.id, { members: s.members, hidden: s.hidden });
        write(`event: swarm\nid: ${s.id}\ndata: ${JSON.stringify(s)}\n\n`);
      };

      const poll = async () => {
        const now = Math.floor(Date.now() / 1000);
        // reveals happen PUBLIC_DELAY_SEC after the last join, so keep watching that long
        const rows = await changedSwarmRows(maxId, now - PUBLIC_DELAY_SEC - 120);
        if (!rows.length) return;
        for (const r of rows) maxId = Math.max(maxId, r.id);
        const candidates = rows.filter((r) => {
          const prev = seen.get(r.id);
          if (!prev) return now - r.lastJoinAt < SWARM_ACTIVE_SEC;
          return prev.members !== r.members || prev.hidden;
        });
        for (const s of await swarmDTOs(candidates, viewer)) {
          const prev = seen.get(s.id);
          if (!prev || prev.members !== s.members || prev.hidden !== s.hidden) send(s);
        }
      };

      try {
        write(`retry: 3000\n\n`);
        viewer = await swarmViewer(wallet);
        const backlog = await newestSwarmRows(BACKLOG);
        for (const s of (await swarmDTOs(backlog, viewer)).reverse()) send(s);
        maxId = Math.max(0, ...backlog.map((r) => r.id));
        await poll();
      } catch (err) {
        console.error(`[swarms/stream] ${err instanceof Error ? err.message : err}`);
        close();
        return;
      }

      let polling = false;
      timers.push(
        setInterval(async () => {
          if (closed || polling) return;
          polling = true;
          try {
            await poll();
          } catch (err) {
            console.error(`[swarms/stream] ${err instanceof Error ? err.message : err}`);
          } finally {
            polling = false;
          }
        }, POLL_MS),
        setInterval(() => write(`: ping\n\n`), HEARTBEAT_MS),
        setInterval(async () => {
          viewer = await swarmViewer(wallet).catch(() => viewer);
        }, VIEWER_RECHECK_MS),
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
