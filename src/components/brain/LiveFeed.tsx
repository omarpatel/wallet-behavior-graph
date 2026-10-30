"use client";

import { useEffect, useRef, useState } from "react";
import { timeAgo } from "@/lib/format";
import type { AvatarBrain } from "@/components/ui/Avatar";
import type { AlertDTO } from "@/server/alerts/types";
import { AlertCard } from "./AlertCard";

type Conn = "connecting" | "live" | "reconnecting" | "denied";

const MAX_ALERTS = 100;

function upsert(list: AlertDTO[], a: AlertDTO): AlertDTO[] {
  const i = list.findIndex((x) => x.id === a.id);
  if (i >= 0) {
    const next = list.slice();
    next[i] = { ...next[i], ...a, explanation: a.explanation ?? next[i].explanation };
    return next;
  }
  return [a, ...list].sort((x, y) => y.publishAt - x.publishAt || y.id - x.id).slice(0, MAX_ALERTS);
}

/** Holder-only live alert stream (SSE `/api/brains/[id]/stream`, deduped by AlertDTO.id). */
export function LiveFeed({
  brainId,
  initial,
  alertDelaySec,
  serverNow,
  brain,
}: {
  brainId: string;
  initial: AlertDTO[];
  alertDelaySec: number;
  serverNow: number;
  brain?: AvatarBrain;
}) {
  const [alerts, setAlerts] = useState(initial);
  const [fresh, setFresh] = useState<Record<number, true>>({});
  const [conn, setConn] = useState<Conn>("connecting");
  const [denied, setDenied] = useState<string | null>(null);
  const [now, setNow] = useState(serverNow);
  const known = useRef(new Set(initial.map((a) => a.id)));

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const url = `/api/brains/${encodeURIComponent(brainId)}/stream`;
    const es = new EventSource(url);
    const onAlert = (ev: MessageEvent<string>) => {
      try {
        const a = JSON.parse(ev.data) as AlertDTO;
        if (!known.current.has(a.id)) {
          known.current.add(a.id);
          setFresh((f) => ({ ...f, [a.id]: true }));
        }
        setAlerts((list) => upsert(list, a));
      } catch {
        // malformed frame: ignore, the next alert or reconnect resyncs
      }
    };
    es.addEventListener("open", () => setConn("live"));
    es.addEventListener("alert", onAlert);
    es.addEventListener("alert-update", onAlert);
    const probe = new AbortController();
    es.addEventListener("error", () => {
      if (es.readyState !== EventSource.CLOSED) {
        setConn("reconnecting");
        return;
      }
      // Pre-stream errors (401/403/404) close the stream; ask the route why, then drop the probe.
      fetch(url, { signal: probe.signal })
        .then(async (r) => {
          if (r.ok) return null;
          const body = (await r.json().catch(() => null)) as { error?: string } | null;
          return body?.error ?? `HTTP ${r.status}`;
        })
        .catch(() => null)
        .then((reason) => {
          probe.abort();
          setConn("denied");
          setDenied(reason ?? "The live stream closed. Reload the page to reconnect.");
        });
    });
    return () => {
      probe.abort();
      es.close();
    };
  }, [brainId]);

  return (
    <section aria-labelledby="live-title" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="live-title" className="text-lg font-semibold text-ink">
            Live alerts
          </h2>
          <p className="text-xs text-mute">
            Every new trade by this wallet, with facts against its own baseline.
            {alertDelaySec > 0 && ` Alerts publish ${alertDelaySec}s after the trade (anti-front-running delay).`}
          </p>
        </div>
        <span
          className={`chip ${conn === "live" ? "border-up/40 text-up" : conn === "denied" ? "border-down/40 text-down" : "text-mute"}`}
          role="status"
          aria-live="polite"
        >
          <span className={`size-1.5 rounded-full bg-current ${conn === "live" ? "live-dot" : ""}`} aria-hidden="true" />
          {conn === "live" ? "Live" : conn === "connecting" ? "Connecting…" : conn === "reconnecting" ? "Reconnecting…" : "Disconnected"}
        </span>
      </div>
      {denied && (
        <p role="alert" className="rounded-lg border border-down/30 bg-down/[0.05] px-3 py-2 text-sm text-down">
          {denied}
        </p>
      )}
      {alerts.length === 0 ? (
        <div className="card flex flex-col items-center gap-2 px-6 py-12 text-center">
          <span className="live-dot size-2 rounded-full bg-accent" aria-hidden="true" />
          <p className="text-sm text-ink">Waiting for the next trade</p>
          <p className="max-w-sm text-xs text-mute">New alerts appear here the moment they publish. Keep this tab open.</p>
        </div>
      ) : (
        <ol className="space-y-3" aria-live="polite" aria-relevant="additions">
          {alerts.map((a) => (
            <li key={a.id}>
              <AlertCard alert={a} isNew={!!fresh[a.id]} timeLabel={timeAgo(a.facts.blockTime, now)} brain={brain} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
