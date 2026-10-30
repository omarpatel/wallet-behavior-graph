"use client";

import { useState } from "react";
import { AGENT_OVERRIDE_BOUNDS, type AgentDTO } from "@/server/agents/types";
import { agentApi, archetypeLabel } from "./lib";
import { buildOverrides, OVERRIDE_FIELDS, readOverridePath, toDisplay } from "./overrides";
import { StrategyRules } from "./StrategyRules";

function OverridesForm({ agent, onSaved, onCancel }: { agent: AgentDTO; onSaved: (a: AgentDTO) => void; onCancel: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(OVERRIDE_FIELDS.map((f) => [f.path, toDisplay(readOverridePath(agent.strategy, f.path), f.scale)])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    const built = buildOverrides(agent.strategy, values);
    if ("error" in built) return setError(built.error);
    if (Object.keys(built.overrides).length === 0) return onCancel();
    setBusy(true);
    try {
      onSaved(await agentApi<AgentDTO>(`/api/agents/${agent.id}`, { method: "PATCH", body: { strategyOverrides: built.overrides } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-line bg-bg-2/60 p-4">
      <p className="text-xs text-mute">
        Sizing and risk are yours to tighten or loosen within platform bounds. Entry rules stay derived from the brain. Overridden
        rules are marked &ldquo;owner override&rdquo; and survive a refresh from the brain.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {OVERRIDE_FIELDS.map((f) => {
          const b = AGENT_OVERRIDE_BOUNDS[f.path];
          const id = `ov-${f.path}`;
          return (
            <div key={f.path} className="min-w-0">
              <label htmlFor={id} className="eyebrow block truncate">
                {f.label}
                {f.unit && <span className="normal-case tracking-normal"> · {f.unit}</span>}
              </label>
              <input
                id={id}
                className="field num mt-1"
                type="number"
                inputMode="decimal"
                min={toDisplay(b.min, f.scale)}
                max={toDisplay(b.max, f.scale)}
                step={toDisplay(b.step, f.scale)}
                value={values[f.path]}
                onChange={(e) => setValues((v) => ({ ...v, [f.path]: e.target.value }))}
              />
              <p className="num mt-0.5 text-[10px] text-faint">
                {toDisplay(b.min, f.scale)} – {toDisplay(b.max, f.scale)}
              </p>
            </div>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="text-xs text-down">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()} disabled={busy}>
          {busy ? "Saving…" : "Save rules"}
        </button>
      </div>
    </div>
  );
}

/** Strategy summary + rules with provenance; owners can edit bounded sizing/risk and re-derive from the brain. */
export function StrategyPanel({ agent, isOwner, onChange }: { agent: AgentDTO; isOwner: boolean; onChange: (a: AgentDTO) => void }) {
  const [editing, setEditing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    setRefreshing(true);
    try {
      onChange(await agentApi<AgentDTO>(`/api/agents/${agent.id}/refresh-strategy`, { method: "POST" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section aria-labelledby="strategy" className="card space-y-5 p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="eyebrow">Strategy · {archetypeLabel(agent.strategy.archetype)}</p>
          <h2 id="strategy" className="mt-1 text-lg font-semibold tracking-tight text-ink">
            How this agent trades
          </h2>
        </div>
        {isOwner && !editing && (
          <div className="flex shrink-0 flex-wrap gap-2">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
              Edit sizing &amp; risk
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void refresh()}
              disabled={refreshing}
              title="Re-derive the rules from the brain's latest profile (your overrides are kept)"
            >
              {refreshing ? "Refreshing…" : "Refresh from brain"}
            </button>
          </div>
        )}
      </div>
      <p className="text-sm leading-relaxed text-ink-2">{agent.strategy.summary}</p>
      {error && (
        <p role="alert" className="text-xs text-down">
          {error}
        </p>
      )}
      {editing && (
        <OverridesForm
          agent={agent}
          onCancel={() => setEditing(false)}
          onSaved={(a) => {
            onChange(a);
            setEditing(false);
          }}
        />
      )}
      <StrategyRules strategy={agent.strategy} />
    </section>
  );
}
