"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import type { AgentDTO } from "@/server/agents/types";
import { ConnectButton, useSession } from "@/components/wallet";
import { AgentRiskNote } from "./AgentRiskNote";
import { agentApi, archetypeLabel } from "./lib";
import { StrategyRules } from "./StrategyRules";

/**
 * Create flow on a brain page (POST /api/agents). On success shows the derived strategy from the response and a link
 * to the cockpit; the agent starts paused in paper mode.
 */
export function CreateAgent({ brainId, brainName, canCreate, hasProfile }: { brainId: string; brainName: string; canCreate: boolean; hasProfile: boolean }) {
  const { session } = useSession();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<AgentDTO | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setCreated(await agentApi<AgentDTO>("/api/agents", { method: "POST", body: { brainId, name: name.trim() } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!session) {
    return (
      <div className="card flex flex-col items-start gap-3 p-5">
        <p className="text-sm text-ink-2">
          Seat holders of {brainName} can create an agent that trades with rules derived from this brain&apos;s style. Sign in to
          check your seat.
        </p>
        <ConnectButton />
      </div>
    );
  }
  if (!canCreate) {
    return (
      <div className="card space-y-3 p-5">
        <p className="text-sm text-ink-2">
          A seat on {brainName} unlocks agents: an automated trader with its own wallet whose entry, sizing and exit rules are
          derived from this brain&apos;s style statistics. It does not copy this brain&apos;s wallet.
        </p>
        <Link href="#seat-title" className="btn btn-ghost btn-sm">
          See seat details
        </Link>
      </div>
    );
  }
  if (!hasProfile) {
    return (
      <div className="card p-5 text-sm text-ink-2">
        Agents are derived from the brain&apos;s style profile, which hasn&apos;t been computed yet for {brainName}.
      </div>
    );
  }
  if (created) {
    return (
      <div className="card space-y-5 p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="eyebrow">Agent created · paused · paper</p>
            <h3 className="mt-1 truncate text-lg font-semibold text-ink">{created.name}</h3>
            <p className="mt-1 text-xs text-mute">{archetypeLabel(created.strategy.archetype)}</p>
          </div>
          <Link href={`/agents/${created.id}`} className="btn btn-primary btn-sm">
            Open cockpit
          </Link>
        </div>
        <p className="text-sm leading-relaxed text-ink-2">{created.strategy.summary}</p>
        <StrategyRules strategy={created.strategy} />
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="card space-y-4 p-5">
      <p className="text-sm text-ink-2">
        Create an agent with its own wallet that trades on its own using rules derived from {brainName}&apos;s style statistics
        (entry market cap, timing, sizing, holds, exits). It starts paused in paper mode with simulated SOL; you review the rules
        before starting it.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor="agent-name">
          Agent name
        </label>
        <input
          id="agent-name"
          className="field sm:max-w-xs"
          placeholder="Agent name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          required
          minLength={2}
          autoComplete="off"
        />
        <button type="submit" className="btn btn-primary" disabled={busy || name.trim().length < 2}>
          {busy ? "Creating…" : "Create agent"}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-down">
          {error}
        </p>
      )}
      <AgentRiskNote compact />
    </form>
  );
}
