"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { TierBadge } from "@/components/ui/badges";
import { fmtDuration, fmtPct } from "@/lib/format";
import type { CascadeDTO, ConnectomeDTO, FiringDTO, NeuronDTO, PathDTO, RegionDTO, ReplayDTO, ReplayListDTO } from "@/server/connectome/types";
import type { CanvasHandle, Spotlight } from "./ConnectomeCanvas";
import { ConnectomeTable } from "./ConnectomeTable";
import { useFiringStream, useReducedMotion, type StreamStatus } from "./hooks";
import { ACCENT, BUY_COLOR, edgeKey, fmtLag, rankColor, regionCssColor, relTime, SELL_COLOR } from "./lib";
import { NeuronCard } from "./NeuronCard";

const ConnectomeCanvas = dynamic(() => import("./ConnectomeCanvas"), {
  ssr: false,
  loading: () => (
    <div role="status" className="absolute inset-0 flex items-center justify-center text-sm text-mute">
      <span className="live-dot mr-2 size-1.5 rounded-full bg-accent" aria-hidden="true" />
      Growing the connectome…
    </div>
  ),
});

const WIRING_TOP = 8;
const CASCADE_LAYER_MS = 1100;
const REPLAY_PLAY_MS = 14_000;
const TICKER_MAX = 24;
const FOLLOW_MIN_WINDOW_MS = 30_000;

interface Load<T> {
  status: "idle" | "loading" | "error";
  data: T | null;
  error?: string;
}
const IDLE = { status: "idle", data: null } as const;

interface TickerItem {
  f: FiringDTO;
  live: boolean;
  /** Label of the neuron whose predicted follower this firing was ("activity after"). */
  after?: string;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export interface ExplorerInit {
  focus: string | null;
  cascade: string | null;
  replay: string | null;
  minWeight: number | null;
}

export function ConnectomeExplorer({ data, init }: { data: ConnectomeDTO; init: ExplorerInit }) {
  const reducedMotion = useReducedMotion();
  const neurons = useMemo(() => new Map(data.neurons.map((n) => [n.id, n])), [data]);
  const regions = useMemo(() => new Map(data.regions.map((r) => [r.id, r])), [data]);
  const synapseByKey = useMemo(() => new Map(data.synapses.map((s) => [edgeKey(s.pre, s.post), s])), [data]);
  const maxWeight = useMemo(() => Math.max(1, ...data.synapses.map((s) => s.weight)), [data]);
  const [nowSec] = useState(() => Math.floor(Date.now() / 1000));

  const canvas = useRef<CanvasHandle | null>(null);
  const [selected, setSelected] = useState<string | null>(init.focus && neurons.has(init.focus) ? init.focus : null);
  const [minWeight, setMinWeight] = useState(init.minWeight != null && Number.isFinite(init.minWeight) ? init.minWeight : 0);
  // ~600 brains have no significant synapse; showing them by default buries the wired brain under a ring of
  // labels. Start with single-brain regions hidden ("Unwired" toggle restores them) — except a focused one.
  const [hiddenRegions, setHiddenRegions] = useState<ReadonlySet<number>>(() => {
    const focusRegion = init.focus ? data.neurons.find((n) => n.id === init.focus)?.region : undefined;
    return new Set(data.regions.filter((r) => r.size <= 1 && r.id !== focusRegion).map((r) => r.id));
  });
  const [showLabels, setShowLabels] = useState(true);
  const [view, setView] = useState<"graph" | "table">("graph");
  const [layoutSeq, setLayoutSeq] = useState(0);
  const [sheet, setSheet] = useState<"controls" | null>(null);
  const [cascade, setCascade] = useState<Load<CascadeDTO>>(IDLE);
  const [cascadeDepth, setCascadeDepth] = useState(0);
  const [path, setPath] = useState<Load<PathDTO>>(IDLE);
  const [replays, setReplays] = useState<Load<ReplayListDTO>>(IDLE);
  const [replay, setReplay] = useState<Load<ReplayDTO>>(IDLE);
  const [replayT, setReplayT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ticker, setTicker] = useState<TickerItem[]>([]);
  const [layoutReady, setLayoutReady] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const visibleSynapses = useMemo(
    () => data.synapses.filter((s) => s.weight >= minWeight && !hiddenRegions.has(neurons.get(s.pre)?.region ?? -1) && !hiddenRegions.has(neurons.get(s.post)?.region ?? -1)),
    [data, minWeight, hiddenRegions, neurons],
  );

  // ---- selection helpers ----
  const pick = useCallback((id: string | null) => {
    setSelected(id);
    setPath(IDLE);
    setCascade(IDLE);
    canvas.current?.clearAnnotations();
    if (id) setSheet(null);
  }, []);
  const pickAndFly = useCallback(
    (id: string) => {
      pick(id);
      canvas.current?.flyTo(id);
      setView("graph");
    },
    [pick],
  );

  // ---- cascade ----
  const traceCascade = useCallback(
    async (source: string) => {
      setCascade({ status: "loading", data: null });
      setPath(IDLE);
      canvas.current?.clearAnnotations();
      try {
        const c = await getJson<CascadeDTO>(`/api/connectome/cascade?source=${encodeURIComponent(source)}&depth=3`);
        // Reduced motion reveals every layer at once; otherwise the animation below reveals them one by one.
        setCascadeDepth(reducedMotion ? Number.POSITIVE_INFINITY : 0);
        setCascade({ status: "idle", data: c });
      } catch (e) {
        setCascade({ status: "error", data: null, error: e instanceof Error ? e.message : "Cascade failed" });
      }
    },
    [reducedMotion],
  );

  // Animate cascade layers: travel along the winning synapse, pulse, annotate the cumulative lag.
  useEffect(() => {
    const c = cascade.data;
    if (!c) return;
    const maxDepth = Math.max(1, ...c.steps.map((s) => s.depth));
    const h = canvas.current;
    h?.resetCamera();
    h?.annotate(c.source, { text: "seed", color: ACCENT });
    if (reducedMotion) {
      for (const s of c.steps) h?.annotate(s.id, { text: fmtLag(s.cumulativeLagSec), color: rankColor(s.depth + 1, maxDepth + 1) });
      return;
    }
    h?.pulse(c.source, ACCENT, 1);
    const timers: number[] = [];
    for (let d = 1; d <= maxDepth; d++) {
      timers.push(
        window.setTimeout(() => {
          setCascadeDepth(d);
          const color = rankColor(d + 1, maxDepth + 1);
          for (const s of c.steps.filter((x) => x.depth === d)) {
            canvas.current?.travel(s.via, s.id, color, 0, 650);
            canvas.current?.pulse(s.id, color, 0.4 + 0.6 * s.strength, 600);
            timers.push(window.setTimeout(() => canvas.current?.annotate(s.id, { text: fmtLag(s.cumulativeLagSec), color }), 650));
          }
        }, (d - 1) * CASCADE_LAYER_MS + 250),
      );
    }
    return () => timers.forEach((t) => clearTimeout(t));
  }, [cascade.data, reducedMotion]);

  const clearCascade = useCallback(() => {
    setCascade(IDLE);
    canvas.current?.clearAnnotations();
  }, []);

  // ---- path ----
  const findPath = useCallback(async (from: string, to: string) => {
    setPath({ status: "loading", data: null });
    setCascade(IDLE);
    canvas.current?.clearAnnotations();
    try {
      const p = await getJson<PathDTO>(`/api/connectome/path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      setPath({ status: "idle", data: p });
      canvas.current?.resetCamera();
      for (const h of p.hops ?? []) canvas.current?.annotate(h.post, { text: fmtLag(h.medianLagSec), color: ACCENT });
    } catch (e) {
      setPath({ status: "error", data: null, error: e instanceof Error ? e.message : "Path failed" });
    }
  }, []);

  // ---- replay ----
  const loadReplays = useCallback(async () => {
    setReplays({ status: "loading", data: null });
    try {
      setReplays({ status: "idle", data: await getJson<ReplayListDTO>("/api/connectome/replays") });
    } catch (e) {
      setReplays({ status: "error", data: null, error: e instanceof Error ? e.message : "Could not load replays" });
    }
  }, []);

  const loadReplay = useCallback(
    async (mint: string) => {
      if (!mint) return;
      setPlaying(false);
      setReplay({ status: "loading", data: null });
      try {
        const r = await getJson<ReplayDTO>(`/api/connectome/replay?mint=${encodeURIComponent(mint)}`);
        setReplay({ status: "idle", data: r });
        setReplayT(r.entries[0]?.at ?? 0);
        setPlaying(!reducedMotion);
      } catch (e) {
        setReplay({ status: "error", data: null, error: e instanceof Error ? e.message : "Replay failed" });
      }
    },
    [reducedMotion],
  );

  const closeReplay = useCallback(() => {
    setPlaying(false);
    setReplay(IDLE);
  }, []);

  const replaySpan = useMemo(() => {
    const r = replay.data;
    if (!r || !r.entries.length) return null;
    const times = [...r.entries.map((e) => e.at), ...r.exits.map((e) => e.at)];
    const t0 = Math.min(...times);
    const t1 = Math.max(t0 + 1, ...times);
    return { t0, t1 };
  }, [replay.data]);

  // Playback clock.
  useEffect(() => {
    if (!playing || !replaySpan) return;
    let raf = 0;
    let last = performance.now();
    const rate = (replaySpan.t1 - replaySpan.t0) / REPLAY_PLAY_MS;
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      setReplayT((t) => {
        const next = Math.min(replaySpan.t1, t + dt * rate);
        if (next >= replaySpan.t1) setPlaying(false);
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, replaySpan]);

  // Pulse neurons as the playhead crosses their entry / exit.
  const prevT = useRef(0);
  useEffect(() => {
    const r = replay.data;
    const from = prevT.current;
    prevT.current = replayT;
    if (!r || !playing || replayT <= from) return;
    const maxRank = Math.max(1, ...r.entries.map((e) => e.rank));
    for (const e of r.entries) if (e.at > from && e.at <= replayT) canvas.current?.pulse(e.brainId, rankColor(e.rank, maxRank), 0.9);
    for (const e of r.exits) if (e.at > from && e.at <= replayT) canvas.current?.pulse(e.brainId, SELL_COLOR, 0.8);
  }, [replayT, playing, replay.data]);

  // ---- spotlight (path > replay > cascade) ----
  const spotlight = useMemo<Spotlight | null>(() => {
    const p = path.data;
    if (p?.hops?.length) {
      return { kind: "path", nodes: [p.from, ...p.hops.map((h) => h.post)], edges: p.hops.map((h) => edgeKey(h.pre, h.post)) };
    }
    const r = replay.data;
    if (r) {
      const ranks: Record<string, number> = {};
      for (const e of r.entries) if (e.at <= replayT) ranks[e.brainId] = e.rank;
      const exited: Record<string, true> = {};
      for (const e of r.exits) if (e.at <= replayT) exited[e.brainId] = true;
      const entered = Object.keys(ranks);
      const edges: string[] = [];
      for (const a of entered) for (const b of entered) if (ranks[a] < ranks[b] && synapseByKey.has(edgeKey(a, b))) edges.push(edgeKey(a, b));
      return { kind: "ranks", ranks, maxRank: Math.max(1, ...r.entries.map((e) => e.rank)), edges, exited };
    }
    const c = cascade.data;
    if (c) {
      const maxDepth = Math.max(1, ...c.steps.map((s) => s.depth));
      const ranks: Record<string, number> = { [c.source]: 1 };
      const edges: string[] = [];
      for (const s of c.steps) {
        if (s.depth > cascadeDepth) continue;
        ranks[s.id] = s.depth + 1;
        edges.push(edgeKey(s.via, s.id));
      }
      return { kind: "ranks", ranks, maxRank: maxDepth + 1, edges };
    }
    return null;
  }, [path.data, replay.data, replayT, cascade.data, cascadeDepth, synapseByKey]);

  // ---- live firing + prediction vs reality ----
  const expectations = useRef(new Map<string, { pre: string; until: number }>());
  const viewRef = useRef({ minWeight, hiddenRegions });
  useEffect(() => {
    viewRef.current = { minWeight, hiddenRegions };
  }, [minWeight, hiddenRegions]);

  const onFire = useCallback(
    (f: FiringDTO, live: boolean) => {
      const n = neurons.get(f.brainId);
      if (!n) return;
      let after: string | undefined;
      if (live) {
        const now = Date.now();
        const exp = expectations.current.get(f.brainId);
        if (f.side === "buy" && exp && exp.until >= now) {
          after = neurons.get(exp.pre)?.label;
          expectations.current.delete(f.brainId);
          canvas.current?.pulse(f.brainId, ACCENT, 1.2);
          canvas.current?.annotate(f.brainId, { text: `activity after ${after}`, color: ACCENT });
          window.setTimeout(() => canvas.current?.annotate(f.brainId, null), 6000);
        }
        canvas.current?.pulse(f.brainId, f.side === "buy" ? BUY_COLOR : SELL_COLOR, 0.5 + f.sizeBucket * 0.25);
        if (f.side === "buy") {
          const { minWeight: mw, hiddenRegions: hr } = viewRef.current;
          const outs = data.synapses
            .filter((s) => s.pre === f.brainId && s.weight >= mw && !hr.has(neurons.get(s.post)?.region ?? -1))
            .sort((a, b) => b.weight - a.weight)
            .slice(0, 6);
          for (const s of outs) {
            canvas.current?.travel(s.pre, s.post, BUY_COLOR, 150, 900);
            expectations.current.set(s.post, { pre: s.pre, until: now + Math.max(FOLLOW_MIN_WINDOW_MS, 2 * s.medianLagSec * 1000) });
          }
        }
      }
      setTicker((t) => [{ f, live, after }, ...t].slice(0, TICKER_MAX));
    },
    [data, neurons],
  );
  const streamStatus = useFiringStream(onFire);

  // ---- URL state (?focus=&cascade=&replay=&minWeight=) ----
  useEffect(() => {
    const q = new URLSearchParams();
    if (selected) q.set("focus", selected);
    if (cascade.data) q.set("cascade", cascade.data.source);
    if (replay.data) q.set("replay", replay.data.mint);
    if (minWeight > 0) q.set("minWeight", String(+minWeight.toFixed(2)));
    const qs = q.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
    if (url !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(window.history.state, "", url);
  }, [selected, cascade.data, replay.data, minWeight]);

  // Apply initial deep-link once the layout has settled.
  const applied = useRef(false);
  const onLayoutDone = useCallback(() => {
    setLayoutReady(true);
    if (applied.current) return;
    applied.current = true;
    if (init.focus && neurons.has(init.focus)) canvas.current?.flyTo(init.focus);
    if (init.cascade && neurons.has(init.cascade)) {
      setSelected(init.cascade);
      void traceCascade(init.cascade);
    }
    if (init.replay) void loadReplay(init.replay);
  }, [init, neurons, traceCascade, loadReplay]);

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName));
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === "Escape") {
        if (typing) (e.target as HTMLElement).blur();
        if (selected || path.data || cascade.data) pick(null);
        else if (replay.data) closeReplay();
        setSheet(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, path.data, cascade.data, replay.data, pick, closeReplay]);

  const selectedNeuron = selected ? neurons.get(selected) : undefined;
  const inputs = useMemo(
    () => (selected ? visibleSynapses.filter((s) => s.post === selected).sort((a, b) => b.weight - a.weight).slice(0, WIRING_TOP) : []),
    [selected, visibleSynapses],
  );
  const outputs = useMemo(
    () => (selected ? visibleSynapses.filter((s) => s.pre === selected).sort((a, b) => b.weight - a.weight).slice(0, WIRING_TOP) : []),
    [selected, visibleSynapses],
  );

  const multiRegions = data.regions.filter((r) => r.size > 1);
  const solitary = data.regions.filter((r) => r.size <= 1);
  const toggleRegions = (ids: number[]) =>
    setHiddenRegions((prev) => {
      const next = new Set(prev);
      const hide = !ids.every((id) => prev.has(id));
      for (const id of ids) {
        if (hide) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const renderTooltip = useCallback(
    (id: string) => {
      const n = neurons.get(id);
      if (!n) return null;
      const r = regions.get(n.region);
      return (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2.5">
            <Avatar src={n.avatarUrl} name={n.label} tier={n.tier} size={32} />
            <div className="min-w-0">
              <p className="flex items-center gap-2 font-medium text-ink">
                <span className="truncate">{n.label}</span> <TierBadge tier={n.tier} size="sm" />
              </p>
              {n.label !== n.codename && <p className="num truncate text-[10px] text-mute">{n.codename}</p>}
            </div>
          </div>
          {r && <p className="text-mute">{r.name}</p>}
          <p className="num text-ink-2">
            PR {n.pagerank.toFixed(2)} · lead {fmtPct(n.leadShare)} · {n.partners} partners
          </p>
          <p className="text-faint">Click to pin</p>
        </div>
      );
    },
    [neurons, regions],
  );

  const controls = (
    <ControlsPanel
      data={data}
      neurons={data.neurons}
      onSearchPick={pickAndFly}
      searchRef={searchRef}
      minWeight={minWeight}
      maxWeight={maxWeight}
      onMinWeight={setMinWeight}
      visibleCount={visibleSynapses.length}
      multiRegions={multiRegions}
      solitary={solitary}
      hiddenRegions={hiddenRegions}
      onToggleRegions={toggleRegions}
      onShowAllRegions={() => setHiddenRegions(new Set())}
      showLabels={showLabels}
      onShowLabels={setShowLabels}
      onRelayout={() => setLayoutSeq((s) => s + 1)}
      replays={replays}
      onOpenReplays={loadReplays}
      replay={replay}
      onPickReplay={loadReplay}
      nowSec={nowSec}
    />
  );

  const right: ReactNode = selectedNeuron ? (
    <NeuronCard
      neuron={selectedNeuron}
      region={regions.get(selectedNeuron.region)}
      inputs={inputs}
      outputs={outputs}
      neurons={neurons}
      regions={regions}
      cascade={cascade}
      path={path}
      onTraceCascade={() => void traceCascade(selectedNeuron.id)}
      onClearCascade={clearCascade}
      onPath={(to) => void findPath(selectedNeuron.id, to)}
      onClearPath={() => {
        setPath(IDLE);
        canvas.current?.clearAnnotations();
      }}
      onPick={pickAndFly}
      onClose={() => pick(null)}
    />
  ) : replay.data ? (
    <ReplayOrder replay={replay.data} t={replayT} neurons={neurons} onPick={pickAndFly} />
  ) : null;

  return (
    <div className="relative h-[calc(100dvh-4rem)] min-h-[560px] overflow-clip bg-[radial-gradient(ellipse_at_center,rgb(124_196_255/0.06),transparent_65%)]">
      <h1 className="sr-only">Trading connectome</h1>
      <p className="sr-only">
        Map of {data.neurons.length} tracked wallets (neurons) and {data.synapses.length} directed co-entry relations (synapses). Use the table view for
        a fully accessible list.
      </p>

      <div className={`absolute inset-0 bottom-11 lg:left-[19rem] ${view === "graph" ? "" : "invisible"}`} aria-hidden={view !== "graph"}>
        {data.neurons.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6">
            <p className="max-w-sm text-center text-sm text-mute">
              The connectome is computed once listed wallets have overlapping first buys. Nothing to map yet.
            </p>
          </div>
        ) : (
          <ConnectomeCanvas
            data={data}
            variant="explorer"
            reducedMotion={reducedMotion}
            minWeight={minWeight}
            hiddenRegions={hiddenRegions}
            showLabels={showLabels}
            selected={selected}
            spotlight={spotlight}
            layoutSeq={layoutSeq}
            onSelect={pick}
            onReady={(h) => {
              canvas.current = h;
            }}
            onLayoutDone={onLayoutDone}
            renderTooltip={renderTooltip}
            ariaLabel={`Connectome graph: ${data.neurons.length} neurons, ${visibleSynapses.length} synapses shown`}
          />
        )}
      </div>

      {view === "table" && (
        <div className="absolute inset-0 overflow-auto px-4 pb-20 pt-16 lg:px-80 lg:pt-6">
          <ConnectomeTable neurons={data.neurons} synapses={visibleSynapses} regions={regions} nowSec={nowSec} onPick={pickAndFly} />
        </div>
      )}

      {/* Top toolbar */}
      <div className="absolute right-3 top-3 z-20 flex gap-2 lg:left-[19.5rem] lg:right-auto">
        <button type="button" className="btn btn-ghost btn-sm bg-panel/90 lg:hidden" onClick={() => setSheet(sheet ? null : "controls")} aria-expanded={sheet === "controls"}>
          Controls
        </button>
        <div role="group" aria-label="View" className="flex overflow-hidden rounded-lg border border-line-2 bg-panel/90 text-xs">
          {(["graph", "table"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={`px-3 py-1.5 capitalize ${view === v ? "bg-white/[0.08] text-ink" : "text-mute hover:text-ink"}`}
            >
              {v}
            </button>
          ))}
        </div>
        {view === "graph" && (
          <div className="hidden overflow-hidden rounded-lg border border-line-2 bg-panel/90 text-xs sm:flex">
            <button type="button" className="px-2.5 py-1.5 text-mute hover:text-ink" onClick={() => canvas.current?.zoom(1.5)} aria-label="Zoom in">
              +
            </button>
            <button type="button" className="px-2.5 py-1.5 text-mute hover:text-ink" onClick={() => canvas.current?.zoom(1 / 1.5)} aria-label="Zoom out">
              −
            </button>
            <button type="button" className="px-2.5 py-1.5 text-mute hover:text-ink" onClick={() => canvas.current?.resetCamera()}>
              Fit
            </button>
          </div>
        )}
        {!layoutReady && view === "graph" && data.neurons.length > 0 && (
          <span role="status" className="hidden items-center gap-2 self-center text-xs text-mute sm:flex">
            <span className="live-dot size-1.5 rounded-full bg-accent" aria-hidden="true" /> settling layout…
          </span>
        )}
      </div>

      {/* Left: controls (side panel ≥lg, bottom sheet below) */}
      <Panel side="left" open={sheet === "controls"} onClose={() => setSheet(null)} label="Connectome controls">
        {controls}
      </Panel>

      {/* Right: neuron card / replay order */}
      {right && (
        <Panel side="right" open onClose={() => (selectedNeuron ? pick(null) : closeReplay())} label={selectedNeuron ? `Neuron ${selectedNeuron.label}` : "Replay"}>
          {right}
        </Panel>
      )}

      {replay.data && replaySpan && (
        <ReplayBar
          replay={replay.data}
          t={replayT}
          span={replaySpan}
          playing={playing}
          onPlay={() => {
            if (replayT >= replaySpan.t1) setReplayT(replaySpan.t0);
            setPlaying((p) => !p);
          }}
          onScrub={(t) => {
            setPlaying(false);
            setReplayT(t);
          }}
          onClose={closeReplay}
        />
      )}

      <Ticker items={ticker} status={streamStatus} neurons={neurons} onPick={pickAndFly} />
    </div>
  );
}

function Panel({ side, open, onClose, label, children }: { side: "left" | "right"; open: boolean; onClose: () => void; label: string; children: ReactNode }) {
  const desktop =
    side === "left"
      ? "lg:left-3 lg:top-3 lg:bottom-14 lg:w-72"
      : "lg:right-3 lg:top-3 lg:bottom-14 lg:w-[22rem] lg:left-auto";
  return (
    <aside
      aria-label={label}
      className={`${open ? "flex" : "hidden"} fixed inset-x-0 bottom-0 z-30 max-h-[70dvh] flex-col rounded-t-2xl border border-line-2 bg-panel/95 shadow-2xl backdrop-blur-xl lg:absolute lg:flex lg:max-h-none lg:rounded-[14px] ${desktop}`}
    >
      <div className="flex justify-center py-2 lg:hidden">
        <button type="button" onClick={onClose} className="h-1.5 w-12 rounded-full bg-line-2" aria-label="Close panel" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 lg:pt-4">{children}</div>
    </aside>
  );
}

function ControlsPanel({ searchRef, ...p }: {
  data: ConnectomeDTO;
  neurons: NeuronDTO[];
  onSearchPick: (id: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  minWeight: number;
  maxWeight: number;
  onMinWeight: (w: number) => void;
  visibleCount: number;
  multiRegions: RegionDTO[];
  solitary: RegionDTO[];
  hiddenRegions: ReadonlySet<number>;
  onToggleRegions: (ids: number[]) => void;
  onShowAllRegions: () => void;
  showLabels: boolean;
  onShowLabels: (v: boolean) => void;
  onRelayout: () => void;
  replays: Load<ReplayListDTO>;
  onOpenReplays: () => void;
  replay: Load<ReplayDTO>;
  onPickReplay: (mint: string) => void;
  nowSec: number;
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const needle = q.trim().toLowerCase();
  const matches = needle
    ? p.neurons
        .filter(
          (n) =>
            n.label.toLowerCase().includes(needle) ||
            n.codename.toLowerCase().includes(needle) ||
            n.attribution?.toLowerCase().includes(needle) ||
            n.id.toLowerCase().includes(needle),
        )
        .slice(0, 8)
    : [];
  const choose = (id: string) => {
    p.onSearchPick(id);
    setQ("");
    setActive(0);
  };
  const solitaryIds = p.solitary.map((r) => r.id);
  const solitaryHidden = solitaryIds.length > 0 && solitaryIds.every((id) => p.hiddenRegions.has(id));

  return (
    <div className="space-y-6">
      <div>
        <p className="eyebrow">Trading connectome</p>
        <p className="num mt-1 text-xs text-mute">
          {p.data.neurons.length} neurons · {p.visibleCount}/{p.data.synapses.length} synapses · {p.multiRegions.length} regions
        </p>
        <p className="mt-1 text-[11px] text-faint">
          {p.data.windowDays}d window · co-entry ≤ {fmtDuration(p.data.windowSec)} · updated {relTime(p.data.computedAt, p.nowSec)}
        </p>
      </div>

      <div className="relative">
        <label htmlFor="cx-search" className="eyebrow mb-1.5 block">
          Search <kbd className="ml-1 rounded border border-line-2 px-1 text-[10px] normal-case">/</kbd>
        </label>
        <input
          id="cx-search"
          ref={searchRef}
          className="field h-9"
          placeholder="Codename or attributed name"
          autoComplete="off"
          role="combobox"
          aria-expanded={matches.length > 0}
          aria-controls="cx-search-list"
          aria-activedescendant={matches[active] ? `cx-opt-${matches[active].id}` : undefined}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(matches.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter" && matches[active]) {
              e.preventDefault();
              choose(matches[active].id);
            }
          }}
        />
        {matches.length > 0 && (
          <ul id="cx-search-list" role="listbox" className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-line-2 bg-panel-2 shadow-2xl">
            {matches.map((n, i) => (
              <li
                key={n.id}
                id={`cx-opt-${n.id}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(n.id);
                }}
                className={`flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm ${i === active ? "bg-white/[0.06] text-ink" : "text-ink-2"}`}
              >
                <Avatar src={n.avatarUrl} name={n.label} tier={n.tier} size={28} />
                <span className="min-w-0">
                  <span className="block truncate">{n.label}</span>
                  {(n.attribution ?? (n.label !== n.codename ? n.codename : null)) && (
                    <span className="block truncate text-[11px] text-mute">{n.attribution ?? n.codename}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {needle && matches.length === 0 && <p className="mt-1.5 text-xs text-mute">No neuron matches “{q}”.</p>}
      </div>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between">
          <label htmlFor="cx-weight" className="eyebrow">
            Synapse threshold
          </label>
          <span className="num text-xs text-ink-2">w ≥ {p.minWeight.toFixed(1)}</span>
        </div>
        <input
          id="cx-weight"
          type="range"
          min={0}
          max={p.maxWeight}
          step={p.maxWeight / 200}
          value={p.minWeight}
          onChange={(e) => p.onMinWeight(Number(e.target.value))}
          className="w-full accent-[var(--color-accent)]"
        />
        <p className="mt-1 text-[11px] leading-relaxed text-faint">
          Synapses are statistically significant co-entries (rarer tokens and shorter lags weigh more). Raise the threshold to keep the strongest
          wiring.
        </p>
      </div>

      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <p className="eyebrow">Regions</p>
          {p.hiddenRegions.size > 0 && (
            <button type="button" className="text-xs text-mute hover:text-ink" onClick={p.onShowAllRegions}>
              Show all
            </button>
          )}
        </div>
        <ul className="space-y-1">
          {p.multiRegions.map((r) => (
            <li key={r.id}>
              <RegionToggle label={r.name} count={r.size} color={regionCssColor(r.id, r.size)} on={!p.hiddenRegions.has(r.id)} onClick={() => p.onToggleRegions([r.id])} />
            </li>
          ))}
          {p.solitary.length > 0 && (
            <li>
              <RegionToggle label="Solitary neurons" count={p.solitary.length} color={regionCssColor(0, 1)} on={!solitaryHidden} onClick={() => p.onToggleRegions(solitaryIds)} />
            </li>
          )}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-2">
          <input type="checkbox" checked={p.showLabels} onChange={(e) => p.onShowLabels(e.target.checked)} className="accent-[var(--color-accent)]" />
          Show labels
        </label>
        <button type="button" className="btn btn-ghost btn-sm" onClick={p.onRelayout}>
          Re-run layout
        </button>
      </div>

      <div>
        <p className="eyebrow mb-1.5">Token replay</p>
        {p.replays.data ? (
          p.replays.data.tokens.length ? (
            <select
              aria-label="Token to replay"
              className="field h-9 text-xs"
              value={p.replay.data?.mint ?? ""}
              onChange={(e) => p.onPickReplay(e.target.value)}
            >
              <option value="">Pick a token…</option>
              {p.replays.data.tokens.map((t) => (
                <option key={t.mint} value={t.mint}>
                  {t.symbol ? `$${t.symbol}` : `${t.mint.slice(0, 6)}…`} · {t.brains} brains · {relTime(t.firstAt, p.nowSec)}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-xs text-mute">No token was entered by 3+ tracked wallets yet (last hour excluded).</p>
          )
        ) : (
          <button type="button" className="btn btn-ghost btn-sm" onClick={p.onOpenReplays} disabled={p.replays.status === "loading"}>
            {p.replays.status === "loading" ? "Loading tokens…" : "Replay a token"}
          </button>
        )}
        {p.replays.status === "error" && <p className="mt-1 text-xs text-down">{p.replays.error}</p>}
        {p.replay.status === "loading" && <p className="mt-1 text-xs text-mute">Loading replay…</p>}
        {p.replay.status === "error" && <p className="mt-1 text-xs text-down">{p.replay.error}</p>}
        <p className="mt-1.5 text-[11px] leading-relaxed text-faint">Watch a token spread: neurons light up in entry order, exits flash red.</p>
      </div>

      <div className="space-y-1.5 border-t border-line pt-4 text-[11px] leading-relaxed text-mute">
        <p>
          <span className="text-ink-2">Neuron</span> = tracked wallet, size ∝ PageRank. <span className="text-ink-2">Synapse</span> A→B = B tends to
          enter a token after A. Grey undirected links = shared signal (both directions about equal). Faded links haven&apos;t fired recently.
        </p>
        <p>
          Historical co-movement among tracked wallets — timing, not causation. Keys: <kbd className="rounded border border-line-2 px-1">/</kbd> search,{" "}
          <kbd className="rounded border border-line-2 px-1">Esc</kbd> clear.
        </p>
        <Link href="/methodology" className="text-ink-2 underline decoration-line-2 hover:text-accent">
          Methodology
        </Link>
      </div>
    </div>
  );
}

function RegionToggle({ label, count, color, on, onClick }: { label: string; count: number; color: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-white/[0.04] ${on ? "text-ink-2" : "text-faint line-through"}`}
    >
      <span className="size-2.5 shrink-0 rounded-full" style={{ background: on ? color : "transparent", boxShadow: `inset 0 0 0 1.5px ${color}` }} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="num text-xs text-mute">{count}</span>
    </button>
  );
}

function ReplayOrder({ replay, t, neurons, onPick }: { replay: ReplayDTO; t: number; neurons: Map<string, NeuronDTO>; onPick: (id: string) => void }) {
  const maxRank = Math.max(1, ...replay.entries.map((e) => e.rank));
  const t0 = replay.entries[0]?.at ?? 0;
  const exits = new Map(replay.exits.map((e) => [e.brainId, e.at]));
  return (
    <div className="space-y-4">
      <div>
        <p className="eyebrow mb-1">Token replay</p>
        <h2 className="text-lg font-semibold text-ink">{replay.symbol ? `$${replay.symbol}` : `${replay.mint.slice(0, 8)}…`}</h2>
        <p className="mt-1 text-xs text-mute">Entry order among tracked wallets (rank colouring: first = lime → last = pink).</p>
      </div>
      <ol className="space-y-1.5">
        {replay.entries.map((e) => {
          const reached = e.at <= t;
          const exitAt = exits.get(e.brainId);
          return (
            <li key={e.brainId} className={`flex items-center gap-2 text-xs ${reached ? "" : "opacity-40"}`}>
              <span className="num w-6 shrink-0 text-right" style={{ color: rankColor(e.rank, maxRank) }}>
                #{e.rank}
              </span>
              <button type="button" onClick={() => onPick(e.brainId)} className="min-w-0 flex-1 truncate text-left text-ink hover:text-accent">
                {neurons.get(e.brainId)?.label ?? e.brainId}
              </button>
              <span className="num shrink-0 text-mute">{fmtLag(e.at - t0)}</span>
              {exitAt != null && (
                <span className={`num shrink-0 ${exitAt <= t ? "text-down" : "text-faint"}`} title="Exited (position ≤1% of peak)">
                  exit {fmtLag(exitAt - t0)}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p className="text-[11px] text-faint">Events older than one hour only. Order of entry is not evidence that one wallet caused another&apos;s.</p>
    </div>
  );
}

function ReplayBar({
  replay,
  t,
  span,
  playing,
  onPlay,
  onScrub,
  onClose,
}: {
  replay: ReplayDTO;
  t: number;
  span: { t0: number; t1: number };
  playing: boolean;
  onPlay: () => void;
  onScrub: (t: number) => void;
  onClose: () => void;
}) {
  const entered = replay.entries.filter((e) => e.at <= t).length;
  return (
    <div className="absolute inset-x-3 bottom-14 z-20 mx-auto max-w-xl rounded-xl border border-line-2 bg-panel/95 px-3 py-2 shadow-2xl backdrop-blur lg:bottom-14">
      <div className="flex items-center gap-3">
        <button type="button" className="btn btn-primary btn-sm w-9 px-0" onClick={onPlay} aria-label={playing ? "Pause replay" : "Play replay"}>
          {playing ? (
            <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true">
              <path d="M1 1h2.5v10H1zM6.5 1H9v10H6.5z" fill="currentColor" />
            </svg>
          ) : (
            <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true">
              <path d="M1 1l8 5-8 5z" fill="currentColor" />
            </svg>
          )}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between text-[11px]">
            <span className="truncate text-ink-2">{replay.symbol ? `$${replay.symbol}` : replay.mint.slice(0, 8)}</span>
            <span className="num text-mute">
              {fmtLag(t - span.t0)} · {entered}/{replay.entries.length} entered
            </span>
          </div>
          <input
            type="range"
            aria-label="Replay time"
            min={span.t0}
            max={span.t1}
            step={Math.max(1, (span.t1 - span.t0) / 400)}
            value={t}
            onChange={(e) => onScrub(Number(e.target.value))}
            className="w-full accent-[var(--color-accent)]"
          />
        </div>
        <button type="button" className="btn btn-ghost btn-sm px-2" onClick={onClose} aria-label="Close replay">
          <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function Ticker({
  items,
  status,
  neurons,
  onPick,
}: {
  items: TickerItem[];
  status: StreamStatus;
  neurons: Map<string, NeuronDTO>;
  onPick: (id: string) => void;
}) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 5000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="absolute inset-x-0 bottom-0 z-20 flex h-11 items-center gap-3 border-t border-line bg-bg/85 px-3 backdrop-blur">
      <span className="flex shrink-0 items-center gap-2 text-xs text-ink-2">
        <span className={`size-1.5 rounded-full ${status === "live" ? "live-dot bg-up" : "bg-warn"}`} aria-hidden="true" />
        <span className="eyebrow">{status === "live" ? "Firing" : status === "connecting" ? "Connecting" : "Reconnecting"}</span>
      </span>
      <ol aria-label="Recent firing" aria-live="polite" className="flex min-w-0 flex-1 gap-4 overflow-x-auto whitespace-nowrap text-xs [scrollbar-width:none]">
        {items.length === 0 ? (
          <li className="text-mute">Waiting for trades…</li>
        ) : (
          items.map(({ f, live, after }) => {
            const n = neurons.get(f.brainId);
            return (
              <li key={f.id} data-firing-id={f.id} data-live={live || undefined} className="flex items-center gap-1.5">
                <span className={`size-1.5 rounded-full ${f.side === "buy" ? "bg-up" : "bg-down"}`} aria-hidden="true" />
                <button type="button" className="text-ink hover:text-accent" onClick={() => onPick(f.brainId)}>
                  {n?.label ?? f.brainId}
                </button>
                <span className={f.side === "buy" ? "text-up" : "text-down"}>{f.side}</span>
                <span className="text-faint" aria-label={`size bucket ${f.sizeBucket} of 3`}>
                  {"•".repeat(f.sizeBucket)}
                </span>
                {after && <span className="text-accent">activity after {after}</span>}
                <span className="num text-mute">{relTime(f.at, now)}</span>
              </li>
            );
          })
        )}
      </ol>
    </div>
  );
}
