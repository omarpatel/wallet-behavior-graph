"use client";

import { useId, useState, type KeyboardEvent, type ReactNode } from "react";

export interface TabDef {
  id: string;
  label: string;
  badge?: ReactNode;
  panel: ReactNode;
}

/** Accessible tabs; every panel stays mounted so the live stream keeps running while another tab is shown. */
export function BrainTabs({ tabs }: { tabs: TabDef[] }) {
  const [active, setActive] = useState(tabs[0]?.id);
  const base = useId();

  function onKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = tabs[(i + dir + tabs.length) % tabs.length];
    setActive(next.id);
    document.getElementById(`${base}-tab-${next.id}`)?.focus();
  }

  if (tabs.length === 1) return <>{tabs[0].panel}</>;

  return (
    <div>
      <div role="tablist" aria-label="Brain sections" className="mb-6 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line">
        {tabs.map((t, i) => {
          const selected = t.id === active;
          return (
            <button
              key={t.id}
              id={`${base}-tab-${t.id}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`${base}-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(t.id)}
              onKeyDown={(e) => onKey(e, i)}
              className={`-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-3 text-sm transition-colors ${
                selected ? "border-accent text-ink" : "border-transparent text-mute hover:text-ink-2"
              }`}
            >
              {t.label}
              {t.badge}
            </button>
          );
        })}
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          id={`${base}-panel-${t.id}`}
          role="tabpanel"
          aria-labelledby={`${base}-tab-${t.id}`}
          hidden={t.id !== active}
          tabIndex={0}
          className="focus-visible:outline-none"
        >
          {t.panel}
        </div>
      ))}
    </div>
  );
}
