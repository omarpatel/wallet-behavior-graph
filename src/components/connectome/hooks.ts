"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FiringDTO } from "@/server/connectome/types";

const MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(MOTION_QUERY);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(MOTION_QUERY).matches,
    () => false,
  );
}

export type StreamStatus = "connecting" | "live" | "reconnecting";

/** Firings older than this when received are history (backlog), not live activity. */
const LIVE_MAX_AGE_SEC = 600;

/**
 * Public brain-level firing stream (`/api/connectome/stream`). `onFire(f, live)` runs for every new firing once;
 * `live` is false for backlog/stale events (ticker only, no pulse). Bursts are spaced out so pulses stay readable.
 */
export function useFiringStream(onFire: (f: FiringDTO, live: boolean) => void): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const cb = useRef(onFire);
  useEffect(() => {
    cb.current = onFire;
  });
  // Survives effect re-runs (Strict Mode, Fast Refresh) so a re-sent backlog never fires twice.
  const seenRef = useRef(new Set<number>());

  useEffect(() => {
    const seen = seenRef.current;
    const queue: { f: FiringDTO; live: boolean }[] = [];
    let timer: number | undefined;
    const drain = () => {
      timer = undefined;
      const next = queue.shift();
      if (!next) return;
      cb.current(next.f, next.live);
      if (queue.length) timer = window.setTimeout(drain, next.live ? 180 : 0);
    };
    const es = new EventSource("/api/connectome/stream");
    es.onopen = () => setStatus("live");
    es.onerror = () => setStatus("reconnecting");
    es.addEventListener("fire", (ev) => {
      let f: FiringDTO;
      try {
        f = JSON.parse((ev as MessageEvent<string>).data) as FiringDTO;
      } catch {
        return;
      }
      if (seen.has(f.id)) return;
      seen.add(f.id);
      queue.push({ f, live: Date.now() / 1000 - f.at < LIVE_MAX_AGE_SEC });
      if (timer === undefined) timer = window.setTimeout(drain, 0);
    });
    return () => {
      clearTimeout(timer);
    };
  }, []);

  return status;
}
