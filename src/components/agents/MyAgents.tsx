"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AGENT_LIMITS, type AgentDTO } from "@/server/agents/types";
import { CardsSkeleton, EmptyState, ErrorNote } from "@/components/ui/primitives";
import { ConnectButton, useSession } from "@/components/wallet";
import { AgentCard } from "./AgentCard";
import { agentApi } from "./lib";

type Load =
  | { state: "loading" }
  | { state: "error"; message: string; wallet: string }
  | { state: "ok"; agents: AgentDTO[]; wallet: string };

/** The signed-in wallet's agents (GET /api/agents). */
export function MyAgents() {
  const { session, loading } = useSession();
  const wallet = session?.wallet ?? null;
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!wallet) return;
    const ctrl = new AbortController();
    agentApi<AgentDTO[]>("/api/agents", { signal: ctrl.signal })
      .then((agents) => setLoad({ state: "ok", agents, wallet }))
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setLoad({ state: "error", message: e instanceof Error ? e.message : String(e), wallet });
      });
    return () => ctrl.abort();
  }, [wallet, attempt]);

  if (loading) return <CardsSkeleton count={3} label="Loading your agents" />;
  if (!session) {
    return (
      <div className="card flex flex-col items-center gap-4 px-6 py-14 text-center">
        <p className="text-base font-medium text-ink">Sign in with your wallet</p>
        <p className="max-w-md text-sm text-mute">
          Agents belong to the wallet that created them. Connect and sign the one-time message (no transaction, no fee) to see
          yours.
        </p>
        <ConnectButton />
      </div>
    );
  }
  // A result for a previous wallet (account switch) counts as still loading.
  if (load.state === "loading" || load.wallet !== wallet) return <CardsSkeleton count={3} label="Loading your agents" />;
  if (load.state === "error") {
    return (
      <ErrorNote title="Couldn't load your agents">
        <p>{load.message}</p>
        <button
          type="button"
          className="btn btn-ghost btn-sm mt-3"
          onClick={() => {
            setLoad({ state: "loading" });
            setAttempt((n) => n + 1);
          }}
        >
          Retry
        </button>
      </ErrorNote>
    );
  }
  if (load.agents.length === 0) {
    return (
      <EmptyState
        title="No agents yet"
        action={
          <Link href="/brains" className="btn btn-primary btn-sm">
            Find a brain
          </Link>
        }
      >
        Open a brain you hold a seat on and create an agent from its section &ldquo;Agents that trade like this brain&rdquo;. New
        agents start paused in paper mode with simulated SOL.
      </EmptyState>
    );
  }
  return (
    <div className="space-y-4">
      <p className="num text-xs text-mute">
        {load.agents.length} of {AGENT_LIMITS.maxAgentsPerOwner} agents
      </p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {load.agents.map((a) => (
          <AgentCard key={a.id} agent={a} />
        ))}
      </div>
    </div>
  );
}
