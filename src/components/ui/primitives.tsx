import type { ReactNode } from "react";

export function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-7xl px-4 sm:px-6 ${className}`}>{children}</div>;
}

export function PageHeader({
  eyebrow,
  title,
  lede,
  actions,
}: {
  eyebrow?: string;
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 pb-8 pt-10 sm:flex-row sm:items-end sm:justify-between sm:pt-14">
      <div className="max-w-3xl">
        {eyebrow && <p className="eyebrow mb-3">{eyebrow}</p>}
        <h1 className="font-display text-4xl leading-[1.05] tracking-tight text-ink sm:text-5xl">{title}</h1>
        {lede && <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-ink-2">{lede}</p>}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  );
}

export function SectionTitle({ id, eyebrow, children, aside }: { id?: string; eyebrow?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow mb-1.5">{eyebrow}</p>}
        <h2 id={id} className="text-lg font-semibold tracking-tight text-ink">
          {children}
        </h2>
      </div>
      {aside && <div className="shrink-0 whitespace-nowrap">{aside}</div>}
    </div>
  );
}

export type Tone = "up" | "down" | "neutral" | "accent";

export function toneFor(n: number | null | undefined): Tone {
  if (n == null || !Number.isFinite(n) || n === 0) return "neutral";
  return n > 0 ? "up" : "down";
}

const TONE_CLASS: Record<Tone, string> = {
  up: "text-up",
  down: "text-down",
  neutral: "text-ink",
  accent: "text-accent",
};

export function Stat({
  label,
  value,
  tone = "neutral",
  hint,
  size = "md",
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  hint?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const v = size === "lg" ? "text-2xl sm:text-3xl" : size === "sm" ? "text-sm" : "text-lg";
  return (
    <div className="min-w-0">
      <dt className="eyebrow truncate">{label}</dt>
      <dd className={`num mt-1 truncate font-medium ${v} ${TONE_CLASS[tone]}`}>{value}</dd>
      {hint && <dd className="mt-0.5 truncate text-[11px] text-mute">{hint}</dd>}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" className="mb-1 text-faint">
        <rect x="3.5" y="3.5" width="21" height="21" rx="5" fill="none" stroke="currentColor" strokeDasharray="3 3" />
        <path d="M9 17h10M11 12.5h6" stroke="currentColor" strokeLinecap="round" />
      </svg>
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <div className="max-w-md text-sm text-mute">{children}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorNote({ title = "Something went wrong", children }: { title?: string; children?: ReactNode }) {
  return (
    <div role="alert" className="rounded-xl border border-down/30 bg-down/[0.05] px-4 py-3 text-sm">
      <p className="font-medium text-down">{title}</p>
      {children && <div className="mt-1 text-ink-2">{children}</div>}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

export function CardsSkeleton({ count = 6, label = "Loading" }: { count?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card space-y-4 p-5">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
          <div className="grid grid-cols-2 gap-3">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        </div>
      ))}
      <span className="sr-only">{label}…</span>
    </div>
  );
}

export function TableSkeleton({ rows = 5, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} className="card space-y-3 p-4">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-8" />
      ))}
      <span className="sr-only">{label}…</span>
    </div>
  );
}

export function ExternalLink({ href, children, className = "" }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`inline-flex items-center gap-1 hover:text-accent ${className}`}>
      {children}
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="opacity-60">
        <path d="M3 1h6v6M9 1 1 9" fill="none" stroke="currentColor" strokeWidth="1.3" />
      </svg>
      <span className="sr-only">(opens in new tab)</span>
    </a>
  );
}
