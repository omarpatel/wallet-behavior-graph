"use client";

import { useEffect, useState } from "react";
import type { SwarmDTO } from "@/server/signals/types";

export type StreamState = "connecting" | "live" | "reconnecting";

/**
 * Swarms seeded from the server render and kept current by the public SSE (`/api/swarms/stream`, `swarm` events):
 * new swarms, members joining, tokens revealed. Sorted newest first, capped at `max`.
 */
export function useSwarmStream(initial: SwarmDTO[], max = 60): { swarms: SwarmDTO[]; state: StreamState; freshIds: Set<number> } {
  const [swarms, setSwarms] = useState(initial);
  const [state, setState] = useState<StreamState>("connecting");
  const [freshIds, setFreshIds] = useState<Set<number>>(() => new Set());

  useEffect(() => {
    const es = new EventSource("/api/swarms/stream");
    const known = new Map(initial.map((s) => [s.id, s.members]));
    es.onopen = () => setState("live");
    es.onerror = () => setState("reconnecting");
    es.addEventListener("swarm", (e) => {
      let s: SwarmDTO;
      try {
        s = JSON.parse((e as MessageEvent<string>).data) as SwarmDTO;
      } catch {
        return;
      }
      const prev = known.get(s.id);
      known.set(s.id, s.members);
      setSwarms((list) => {
        const next = list.filter((x) => x.id !== s.id);
        next.push(s);
        next.sort((a, b) => b.startedAt - a.startedAt || b.id - a.id);
        return next.slice(0, max);
      });
      // Highlight growth only (backlog replays arrive with the same member count).
      if (prev === undefined ? s.active : s.members > prev) {
        setFreshIds((f) => new Set(f).add(s.id));
        setTimeout(
          () =>
            setFreshIds((f) => {
              const n = new Set(f);
              n.delete(s.id);
              return n;
            }),
          4000,
        );
      }
    });
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribe once; `initial` only seeds the list
  }, []);

  return { swarms, state, freshIds };
}

/** Seconds clock that ticks every `everyMs` (timers since swarm start). Starts from the server time to avoid drift. */
export function useNow(serverNow: number, everyMs = 1000): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const offset = serverNow * 1000 - Date.now();
    const t = setInterval(() => setNow(Math.floor((Date.now() + offset) / 1000)), everyMs);
    return () => clearInterval(t);
  }, [serverNow, everyMs]);
  return now;
}
