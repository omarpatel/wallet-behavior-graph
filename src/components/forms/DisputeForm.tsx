"use client";

import { useState, type FormEvent } from "react";

const KINDS = [
  { id: "correction", label: "Correction — a label, number or attribution is wrong" },
  { id: "opt_out", label: "Objection / opt-out — I object to the profiling of my wallet (GDPR Art. 21)" },
  { id: "other", label: "Other" },
] as const;

export function DisputeForm({ brainId }: { brainId?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneId, setDoneId] = useState<number | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/disputes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brainId: String(fd.get("brainId") ?? ""),
          contact: String(fd.get("contact") ?? ""),
          kind: String(fd.get("kind") ?? "correction"),
          message: String(fd.get("message") ?? ""),
        }),
      });
      const body = (await r.json().catch(() => null)) as { id?: number; error?: string } | null;
      if (!r.ok || body?.id == null) throw new Error(body?.error ?? `Request failed (HTTP ${r.status})`);
      setDoneId(body.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (doneId != null) {
    return (
      <div role="status" className="card space-y-2 p-6">
        <p className="text-base font-medium text-up">Request received (#{doneId})</p>
        <p className="text-sm text-ink-2">
          We review every request and reply via the contact you gave. Objections to processing are handled within one month
          (GDPR Art. 12(3)).
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-5 p-6">
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium text-ink">Request type</legend>
        {KINDS.map((k, i) => (
          <label key={k.id} className="flex cursor-pointer items-start gap-2.5 text-sm text-ink-2">
            <input type="radio" name="kind" value={k.id} defaultChecked={i === 0} className="mt-1 accent-[#c6ff3a]" />
            {k.label}
          </label>
        ))}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">Brain ID or URL slug (optional)</span>
          <input name="brainId" defaultValue={brainId} className="field num" maxLength={80} autoComplete="off" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">How to reach you</span>
          <input name="contact" required minLength={3} maxLength={200} className="field" placeholder="email, X handle, Telegram…" />
        </label>
      </div>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-ink">Details</span>
        <textarea
          name="message"
          required
          minLength={10}
          maxLength={4000}
          rows={6}
          className="field"
          placeholder="What is wrong or what you are asking for. For wallet ownership, we may ask you to sign a message with the wallet."
        />
      </label>
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? "Sending…" : "Send request"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-down">
          {error}
        </p>
      )}
    </form>
  );
}
