"use client";

import { useEffect, useState } from "react";
import type { AgentDecisionDTO, AgentDetailDTO, AgentDTO, AgentOrderDTO, AgentPositionDTO } from "@/server/agents/types";
import type { StreamState } from "@/components/swarms/useSwarmStream";

const MAX_DECISIONS = 120;
const MAX_ORDERS = 120;
const FRESH_MS = 4000;

function parse<T>(e: Event): T | null {
  try {
    return JSON.parse((e as MessageEvent<string>).data) as T;
  } catch {
    return null;
  }
}

/**
 * Agent detail seeded from the server render and kept current by the public SSE (`/api/agents/[id]/stream`):
 * `agent` (status/equity), `decision`, `order` (upsert by id) and `position` (upsert by mint + openedAt).
 * `fresh` holds tape keys (`d<id>` / `o<id>`) that arrived live, for a short highlight; backlog replays don't flash.
 * `setAgent` applies the AgentDTO returned by owner actions (PATCH, refresh-strategy) immediately.
 */
export function useAgentStream(initial: AgentDetailDTO) {
  const [detail, setDetail] = useState(initial);
  const [state, setState] = useState<StreamState>("connecting");
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const id = initial.id;

  useEffect(() => {
    const es = new EventSource(`/api/agents/${encodeURIComponent(id)}/stream`);
    const seenDecisions = new Set(initial.decisions.map((d) => d.id));
    const orderStatus = new Map(initial.orders.map((o) => [o.id, o.status]));
    const flash = (key: string) => {
      setFresh((f) => new Set(f).add(key));
      setTimeout(
        () =>
          setFresh((f) => {
            const n = new Set(f);
            n.delete(key);
            return n;
          }),
        FRESH_MS,
      );
    };
    es.onopen = () => setState("live");
    es.onerror = () => setState("reconnecting");
    es.addEventListener("agent", (e) => {
      const a = parse<AgentDTO>(e);
      if (a) setDetail((d) => ({ ...d, ...a }));
    });
    es.addEventListener("decision", (e) => {
      const dec = parse<AgentDecisionDTO>(e);
      if (!dec || seenDecisions.has(dec.id)) return;
      seenDecisions.add(dec.id);
      flash(`d${dec.id}`);
      setDetail((d) => ({
        ...d,
        decisions: [dec, ...d.decisions.filter((x) => x.id !== dec.id)].sort((a, b) => b.id - a.id).slice(0, MAX_DECISIONS),
      }));
    });
    es.addEventListener("order", (e) => {
      const o = parse<AgentOrderDTO>(e);
      if (!o) return;
      if (orderStatus.get(o.id) !== o.status) flash(`o${o.id}`);
      orderStatus.set(o.id, o.status);
      setDetail((d) => ({
        ...d,
        orders: [o, ...d.orders.filter((x) => x.id !== o.id)].sort((a, b) => b.id - a.id).slice(0, MAX_ORDERS),
      }));
    });
    es.addEventListener("position", (e) => {
      const p = parse<AgentPositionDTO>(e);
      if (!p) return;
      setDetail((d) => ({
        ...d,
        positions: [p, ...d.positions.filter((x) => x.mint !== p.mint || x.openedAt !== p.openedAt)],
      }));
    });
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribe once per agent; `initial` only seeds the dedupe sets
  }, [id]);

  return { detail, state, fresh, setAgent: (a: AgentDTO) => setDetail((d) => ({ ...d, ...a })) };
}
