"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { fmtDuration } from "@/lib/format";
import { PUBLIC_DELAY_SEC, type TokenGraphDTO } from "@/server/connectome/types";
import { useReducedMotion } from "./hooks";

const TokenGraphCanvas = dynamic(() => import("./TokenGraphCanvas"), {
  ssr: false,
  loading: () => <p className="absolute inset-0 flex items-center justify-center text-sm text-mute">Drawing tokens…</p>,
});

type State = { status: "idle" } | { status: "error"; error: string } | { status: "ready"; data: TokenGraphDTO };

/** Brain-page tab: the brain's own wiring of tokens. Fetches only once the tab is first shown. */
export function TokenConnectome({ brainId, title }: { brainId: string; title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<State>({ status: "idle" });
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth > 0) setVisible(true);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const ac = new AbortController();
    fetch(`/api/brains/${encodeURIComponent(brainId)}/connectome`, { signal: ac.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? "Brain not found" : `Request failed (${res.status})`);
        setState({ status: "ready", data: (await res.json()) as TokenGraphDTO });
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setState({ status: "error", error: e instanceof Error ? e.message : "Could not load the token map" });
      });
    return () => ac.abort();
  }, [visible, brainId]);

  return (
    <section ref={ref} aria-labelledby="token-cx" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow mb-1.5">Last 30 days</p>
          <h2 id="token-cx" className="text-lg font-semibold tracking-tight text-ink">
            Token connectome
          </h2>
        </div>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-mute" aria-label="Legend">
          <li className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-accent" aria-hidden="true" /> this brain
          </li>
          <li className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-up" aria-hidden="true" /> realized gain
          </li>
          <li className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-down" aria-hidden="true" /> realized loss
          </li>
          <li className="flex items-center gap-1.5">
            <span className="size-2 rounded-full border border-warn" aria-hidden="true" /> open position
          </li>
          <li className="flex items-center gap-1.5">
            <span className="text-info" aria-hidden="true">
              →
            </span>{" "}
            sold, then bought next
          </li>
        </ul>
      </div>

      {state.status === "ready" && state.data.delayed && (
        <p role="note" className="rounded-xl border border-line-2 bg-panel px-4 py-2.5 text-xs text-ink-2">
          <span className="mr-2 inline-block size-1.5 rounded-full bg-warn align-middle" aria-hidden="true" />
          Delayed view: trades from the last {fmtDuration(PUBLIC_DELAY_SEC)} are hidden. Seat holders see this map in real time.
        </p>
      )}

      <div className="card relative h-[460px] overflow-hidden bg-[radial-gradient(ellipse_at_center,rgb(198_255_58/0.05),transparent_60%)] sm:h-[520px]">
        {state.status === "error" ? (
          <p role="alert" className="flex h-full items-center justify-center px-6 text-center text-sm text-down">
            {state.error}
          </p>
        ) : state.status !== "ready" ? (
          <p role="status" className="flex h-full items-center justify-center text-sm text-mute">
            <span className="live-dot mr-2 size-1.5 rounded-full bg-accent" aria-hidden="true" />
            Loading token map…
          </p>
        ) : state.data.tokens.length === 0 ? (
          <p className="flex h-full items-center justify-center px-6 text-center text-sm text-mute">No token activity in this window yet.</p>
        ) : (
          <TokenGraphCanvas data={state.data} somaLabel={title} reducedMotion={reducedMotion} />
        )}
      </div>
      {state.status === "ready" && state.data.tokens.length > 0 && (
        <p className="text-xs text-mute">
          {state.data.tokens.length} tokens · {state.data.rotations.length} rotations. Node size ∝ USD bought; arrows mark capital rotating from one
          token into the next within minutes. Hover a token for its stats.
        </p>
      )}
    </section>
  );
}
