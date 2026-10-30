"use client";

import Form from "next/form";
import { useRef } from "react";

export interface FilterOptions {
  archetypes: { id: string; label: string }[];
  sorts: Record<string, string>;
}

export interface FilterValues {
  q?: string;
  tier?: string;
  archetype?: string;
  claimed?: string;
  openSeats?: boolean;
  sort?: string;
}

export function BrainFilters({ values, options }: { values: FilterValues; options: FilterOptions }) {
  const ref = useRef<HTMLFormElement>(null);
  const submit = () => ref.current?.requestSubmit();
  const select = "field h-9 cursor-pointer pr-8 text-[13px]";

  return (
    <Form ref={ref} action="/brains" replace scroll={false} className="card grid grid-cols-2 gap-2 p-3 sm:gap-3 lg:grid-cols-[1.6fr_repeat(4,1fr)_auto]" role="search" aria-label="Filter brains">
      <label className="relative col-span-2 lg:col-span-1">
        <span className="sr-only">Search by codename, attributed name or wallet</span>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mute">
          <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="m11 11 3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          name="q"
          type="search"
          defaultValue={values.q}
          placeholder="Codename, name, wallet…"
          className="field h-9 pl-9 text-[13px]"
          autoComplete="off"
        />
      </label>
      <label>
        <span className="sr-only">Tier</span>
        <select name="tier" defaultValue={values.tier ?? ""} onChange={submit} className={select}>
          <option value="">All tiers</option>
          {["S", "A", "B", "C"].map((t) => (
            <option key={t} value={t}>
              Tier {t}
            </option>
          ))}
          <option value="unrated">Unrated</option>
        </select>
      </label>
      <label>
        <span className="sr-only">Archetype</span>
        <select name="archetype" defaultValue={values.archetype ?? ""} onChange={submit} className={select}>
          <option value="">All archetypes</option>
          {options.archetypes.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="sr-only">Claim status</span>
        <select name="claimed" defaultValue={values.claimed ?? ""} onChange={submit} className={select}>
          <option value="">Any claim status</option>
          <option value="claimed">Claimed by owner</option>
          <option value="unclaimed">Unclaimed</option>
        </select>
      </label>
      <label>
        <span className="sr-only">Sort by</span>
        <select name="sort" defaultValue={values.sort ?? "score"} onChange={submit} className={select}>
          {Object.entries(options.sorts).map(([k, v]) => (
            <option key={k} value={k}>
              Sort: {v}
            </option>
          ))}
        </select>
      </label>
      <label className="flex h-9 cursor-pointer items-center gap-2 rounded-[10px] border border-line-2 px-3 text-[13px] text-ink-2">
        <input type="checkbox" name="open" value="1" defaultChecked={values.openSeats} onChange={submit} className="accent-[#c6ff3a]" />
        Open seats
      </label>
    </Form>
  );
}
