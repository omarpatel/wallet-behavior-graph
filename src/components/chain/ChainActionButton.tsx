"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useChainAction, useSession } from "@/components/wallet";
import { DISCLAIMER } from "@/components/ui/Disclaimer";

const STATUS_LABEL = {
  idle: null,
  building: "Building transaction…",
  signing: "Approve in your wallet…",
  submitting: "Submitting & confirming…",
  done: "Confirmed",
  error: null,
} as const;

/**
 * Runs one server-built chain action (mint / buy / renew / list / delist) through the wallet,
 * optionally behind a confirm step that shows the disclaimer before anything is signed.
 */
export function ChainActionButton({
  endpoint,
  body,
  label,
  confirm,
  variant = "primary",
  size = "md",
  disabled,
  onDone,
}: {
  endpoint: string;
  body: unknown;
  label: ReactNode;
  /** When set, a confirm panel with these details + the disclaimer is shown before signing. */
  confirm?: ReactNode;
  variant?: "primary" | "ghost" | "danger";
  size?: "md" | "sm";
  disabled?: boolean;
  onDone?: (r: { signature: string; kind: string; asset?: string }) => void;
}) {
  const router = useRouter();
  const { session, loading } = useSession();
  const { run, status, error } = useChainAction();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{ signature: string } | null>(null);
  const busy = status === "building" || status === "signing" || status === "submitting";
  const cls = `btn btn-${variant} ${size === "sm" ? "btn-sm" : ""}`;

  async function go() {
    setConfirming(false);
    try {
      const r = await run(endpoint, body);
      setResult(r);
      onDone?.(r);
      router.refresh();
    } catch {
      // surfaced via `error`
    }
  }

  if (!session) {
    const hint = loading ? "Checking session…" : "Connect and sign in with your wallet first.";
    return (
      <div className="space-y-2">
        <button type="button" className={cls} disabled title={hint}>
          {label}
        </button>
        {size === "md" && <p className="text-xs text-mute">{hint}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {confirming && confirm ? (
        <div className="min-w-[16rem] max-w-sm space-y-3 rounded-xl border border-line-2 bg-bg-2 p-3 text-left whitespace-normal" role="dialog" aria-label="Confirm transaction">
          <div className="text-sm text-ink-2">{confirm}</div>
          <p className="rounded-lg border border-warn/20 bg-warn/[0.04] px-2.5 py-2 text-[11px] leading-snug text-warn/90">{DISCLAIMER}</p>
          <div className="flex gap-2">
            <button type="button" className={cls} onClick={go} disabled={busy}>
              I understand — continue
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={cls}
          disabled={disabled || busy}
          aria-busy={busy}
          onClick={() => (confirm ? setConfirming(true) : go())}
        >
          {busy ? STATUS_LABEL[status] : label}
        </button>
      )}
      {status === "done" && result && (
        <p className="text-xs text-up" role="status">
          {STATUS_LABEL.done}
          {result.signature ? ` · ${result.signature.slice(0, 8)}…` : ""}
        </p>
      )}
      {status === "error" && error && (
        <p className="text-xs text-down" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
