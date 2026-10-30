"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Markdown } from "@/components/Markdown";
import { BrainAvatar, type AvatarBrain } from "@/components/ui/Avatar";
import { Disclaimer } from "@/components/ui/Disclaimer";

interface Msg {
  id: number | string;
  role: "user" | "assistant";
  content: string;
}

const SUGGESTIONS = [
  "How does this wallet size into bonding-curve plays?",
  "When does it cut a losing position?",
  "What separates its winners from its losers?",
  "Is this style realistic to copy with a few seconds of latency?",
];

const MAX_LEN = 2000;

async function errorText(r: Response): Promise<string> {
  const body = (await r.json().catch(() => null)) as { error?: string } | null;
  if (r.status === 429) {
    const retry = r.headers.get("retry-after");
    return `${body?.error ?? "Rate limit reached"}${retry ? ` — try again in ${Math.ceil(Number(retry) / 60)} min` : ""}.`;
  }
  return body?.error ?? `Request failed (HTTP ${r.status}).`;
}

/** Holder-only coaching chat: history via GET, streamed text/plain replies via POST. */
export function CoachChat({ brainId, title, brain }: { brainId: string; title: string; brain?: AvatarBrain }) {
  const url = `/api/brains/${encodeURIComponent(brainId)}/chat`;
  const [messages, setMessages] = useState<Msg[]>([]);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(await errorText(r));
        return (await r.json()) as { messages: Msg[]; remaining?: number };
      })
      .then((d) => {
        if (cancelled) return;
        setMessages(d.messages);
        if (typeof d.remaining === "number") setRemaining(d.remaining);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || streaming) return;
    setError(null);
    setInput("");
    const replyId = `pending-${Date.now()}`;
    setMessages((m) => [...m, { id: `u-${Date.now()}`, role: "user", content: message }, { id: replyId, role: "assistant", content: "" }]);
    setStreaming(true);
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) });
      if (!r.ok || !r.body) throw new Error(await errorText(r));
      const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        setMessages((m) => m.map((x) => (x.id === replyId ? { ...x, content: x.content + value } : x)));
      }
      setRemaining((n) => (n == null ? n : Math.max(0, n - 1)));
    } catch (e) {
      setMessages((m) => m.filter((x) => x.id !== replyId || x.content));
      setError(e instanceof Error ? e.message : String(e));
      setInput(message);
    } finally {
      setStreaming(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(input);
  }

  return (
    <section aria-labelledby="coach-title" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-3">
          {brain && <BrainAvatar brain={brain} size={40} />}
          <div>
            <h2 id="coach-title" className="text-lg font-semibold text-ink">
              Coach
            </h2>
            <p className="text-xs text-mute">Ask about {title}&apos;s style. It explains the pattern; it does not tell you what to trade.</p>
          </div>
        </div>
        {remaining != null && <span className="num text-xs text-mute">{remaining} questions left this hour</span>}
      </div>

      <div className="card flex h-[min(70vh,560px)] flex-col">
        <div className="flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite" aria-busy={streaming}>
          {loading ? (
            <p className="text-sm text-mute" role="status">
              Loading conversation…
            </p>
          ) : messages.length === 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-ink-2">Start with one of these:</p>
              <ul className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <li key={s}>
                    <button type="button" className="chip h-auto py-1.5 text-left hover:border-accent/50 hover:text-ink" onClick={() => void send(s)}>
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="ml-auto max-w-[85%] rounded-2xl rounded-br-md border border-accent/25 bg-accent/[0.06] px-3.5 py-2.5 text-sm text-ink">
                  {m.content}
                </div>
              ) : (
                <div key={m.id} className="max-w-[92%] text-sm">
                  {m.content ? (
                    <Markdown source={m.content} />
                  ) : (
                    <p className="flex items-center gap-2 text-xs text-mute">
                      <span className="live-dot size-1.5 rounded-full bg-accent" aria-hidden="true" />
                      Thinking…
                    </p>
                  )}
                </div>
              ),
            )
          )}
          <div ref={endRef} />
        </div>
        {error && (
          <p role="alert" className="mx-4 mb-2 rounded-lg border border-down/30 bg-down/[0.05] px-3 py-2 text-xs text-down">
            {error}
          </p>
        )}
        <form onSubmit={onSubmit} className="flex gap-2 border-t border-line p-3">
          <label htmlFor="coach-input" className="sr-only">
            Your question
          </label>
          <textarea
            id="coach-input"
            rows={1}
            value={input}
            maxLength={MAX_LEN}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            placeholder="Ask about entries, sizing, exits…"
            className="field min-h-10 flex-1 resize-none"
            disabled={streaming}
          />
          <button type="submit" className="btn btn-primary" disabled={streaming || !input.trim() || remaining === 0}>
            {streaming ? "…" : "Ask"}
          </button>
        </form>
      </div>
      <Disclaimer compact />
    </section>
  );
}
