"use client";

import Link from "next/link";
import { useState } from "react";
import type { AgentDetailDTO, AgentDTO } from "@/server/agents/types";
import { Modal } from "./Modal";
import { agentApi, solOf } from "./lib";

type Patch = { status?: "running" | "paused"; mode?: "paper" | "live"; useLlm?: boolean; acknowledgeCustodialRisk?: true };

/** Owner controls: start/pause, paper↔live (blocking confirm with custodial-risk acknowledgement), LLM judge. */
export function AgentControls({ agent, onChange }: { agent: AgentDetailDTO; onChange: (a: AgentDTO) => void }) {
  const [busy, setBusy] = useState<keyof Patch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switchTo, setSwitchTo] = useState<"paper" | "live" | null>(null);
  const [ack, setAck] = useState(false);
  const running = agent.status === "running";

  async function patch(body: Patch, key: keyof Patch) {
    setError(null);
    setBusy(key);
    try {
      onChange(await agentApi<AgentDTO>(`/api/agents/${agent.id}`, { method: "PATCH", body }));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  function closeSwitch() {
    setSwitchTo(null);
    setAck(false);
  }

  async function confirmSwitch() {
    if (!switchTo) return;
    if (await patch(switchTo === "live" ? { mode: "live", acknowledgeCustodialRisk: true } : { mode: "paper" }, "mode")) closeSwitch();
  }

  return (
    <section aria-labelledby="controls" className="card space-y-4 p-5">
      <h2 id="controls" className="text-sm font-semibold text-ink">
        Controls
      </h2>
      {!agent.agentsEnabled && (
        <p role="note" className="rounded-lg border border-warn/30 bg-warn/[0.05] px-3 py-2 text-xs text-warn">
          Agents are paused platform-wide right now. Withdrawals stay available.
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          className={`btn ${running ? "btn-ghost" : "btn-primary"}`}
          disabled={busy !== null || (!running && !agent.agentsEnabled)}
          onClick={() => void patch({ status: running ? "paused" : "running" }, "status")}
        >
          {busy === "status" ? "…" : running ? "Pause" : agent.status === "halted" ? "Resume" : "Start"}
        </button>
        <button
          type="button"
          className={`btn ${agent.mode === "live" ? "btn-ghost" : "btn-danger"}`}
          disabled={busy !== null || (agent.mode === "paper" && !agent.liveEnabled)}
          title={agent.mode === "paper" && !agent.liveEnabled ? "Live trading is not enabled on this platform yet" : undefined}
          onClick={() => setSwitchTo(agent.mode === "paper" ? "live" : "paper")}
        >
          {agent.mode === "paper" ? "Go live…" : "Back to paper…"}
        </button>
      </div>
      <p className="text-[11px] leading-snug text-mute">
        {agent.mode === "paper" && !agent.liveEnabled ? "Live mode isn't enabled on this platform yet. " : ""}
        Paused or halted agents open nothing new; exits on open positions keep running.
      </p>

      <label className="flex cursor-pointer items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-sm text-ink">LLM judge</span>
          <span className="block text-[11px] leading-snug text-mute">
            A language model reads the brain&apos;s playbook and can veto candidates that pass the rules. Its rationale shows on the
            tape.
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"
          checked={agent.useLlm}
          disabled={busy !== null}
          onChange={(e) => void patch({ useLlm: e.target.checked }, "useLlm")}
        />
      </label>

      {error && (
        <p role="alert" className="break-words text-xs text-down">
          {error}
        </p>
      )}

      {switchTo === "live" && (
        <Modal title="Switch to live trading?" onClose={() => busy === null && closeSwitch()}>
          <div className="space-y-3 text-sm text-ink-2">
            <p>
              In live mode <strong className="text-ink">{agent.name}</strong> trades real SOL from its own wallet on Solana mainnet,
              with no confirmation per trade.
            </p>
            <ul className="list-disc space-y-1.5 pl-5 text-xs leading-relaxed">
              <li>
                The wallet is <strong className="text-ink">custodial</strong>: its private key is generated and held by our server,
                which signs every trade.
              </li>
              <li>
                You can lose <strong className="text-ink">everything you deposit</strong> — through bad trades, rugs, illiquid
                tokens, slippage, software faults or a compromise of the server or key.
              </li>
              <li>
                Rules derived from a brain&apos;s style are not advice and carry no guarantee; stop-losses and the daily loss limit
                ({solOf(agent.strategy.risk.dailyLossLimitLamports)}) may trigger late or not at all.
              </li>
              <li>Paper state (simulated balance and positions) is reset. The agent trades only SOL you deposit.</li>
              <li>You can withdraw the SOL to your signed-in wallet at any time; close open positions first to get them as SOL.</li>
            </ul>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-warn/30 bg-warn/[0.04] p-3 text-xs text-ink">
              <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--color-warn)]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>
                I understand the server holds this agent&apos;s keys, that I can lose all deposited funds, and that nothing here is
                advice. I accept the <Link href="/terms" className="underline">terms</Link> (section 4).
              </span>
            </label>
          </div>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button type="button" className="btn btn-ghost btn-sm" onClick={closeSwitch} disabled={busy !== null}>
              Cancel
            </button>
            <button type="button" className="btn btn-danger btn-sm" disabled={!ack || busy !== null} onClick={() => void confirmSwitch()}>
              {busy === "mode" ? "Switching…" : "Switch to live"}
            </button>
          </div>
        </Modal>
      )}
      {switchTo === "paper" && (
        <Modal title="Switch back to paper?" onClose={() => busy === null && closeSwitch()}>
          <p className="text-sm text-ink-2">
            The agent stops trading real SOL and continues with simulated SOL. Open live positions must be closed first. SOL left
            in the agent wallet stays there until you withdraw it.
          </p>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button type="button" className="btn btn-ghost btn-sm" onClick={closeSwitch} disabled={busy !== null}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => void confirmSwitch()}>
              {busy === "mode" ? "Switching…" : "Switch to paper"}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
