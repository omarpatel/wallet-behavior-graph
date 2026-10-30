import type { AgentDTO } from "@/server/agents/types";
import { ARCHETYPE_LABELS } from "@/server/profile/archetypes";
import type { ArchetypeId } from "@/server/profile/types";
import { apiErrorMessage } from "@/components/wallet/http";
import { fmtSol, fmtUsd, lamportsToSol } from "@/lib/format";

/** Signed SOL amount from lamports ("+0.42 SOL" / "−0.10 SOL"). */
export function fmtSignedSol(lamports: number | null | undefined, digits = 3): string {
  if (lamports == null || !Number.isFinite(lamports)) return "—";
  const sol = lamportsToSol(lamports);
  const s = fmtSol(Math.abs(sol), digits);
  return sol > 0 ? `+${s}` : sol < 0 ? `−${s}` : s;
}

export const solOf = (lamports: number | null | undefined, digits = 3) =>
  lamports == null ? "—" : fmtSol(lamportsToSol(lamports), digits);

/** Percent value (already ×100) with sign. */
export function fmtSignedPct(pct: number | null | undefined, digits = 1): string {
  if (pct == null || !Number.isFinite(pct)) return "—";
  const v = pct.toFixed(digits);
  return pct > 0 ? `+${v}%` : pct < 0 ? `−${v.slice(1)}%` : `${v}%`;
}

/** Text colour for a signed value (also null-safe). */
export function signClass(n: number | null | undefined): string {
  return n == null || n === 0 ? "text-ink-2" : n > 0 ? "text-up" : "text-down";
}

/** Token price in USD; sub-cent memecoin prices keep 3 significant digits ($0.0000712). */
export function fmtPrice(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  if (!(usd > 0 && usd < 0.01)) return fmtUsd(usd);
  return `$${usd.toFixed(Math.min(12, 2 - Math.floor(Math.log10(usd))))}`;
}

export function archetypeLabel(id: string): string {
  return ARCHETYPE_LABELS[id as ArchetypeId] ?? id;
}

export const STATUS_TONE: Record<AgentDTO["status"], "up" | "down" | "warn" | "mute"> = {
  running: "up",
  paused: "mute",
  halted: "warn",
  stopped: "down",
};

export const STATUS_LABEL: Record<AgentDTO["status"], string> = {
  running: "Running",
  paused: "Paused",
  halted: "Halted",
  stopped: "Stopped",
};

/** Typed JSON call to our own agent API; throws an Error carrying the API's `{ error }` message. */
export async function agentApi<T>(url: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
    cache: "no-store",
    signal: init?.signal,
  });
  if (!res.ok) throw new Error(await apiErrorMessage(res));
  // Our own API's documented response shape (src/server/agents/types.ts).
  const data: T = await res.json();
  return data;
}
