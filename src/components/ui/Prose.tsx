import type { ReactNode } from "react";

/** Long-form static content (methodology / legal pages). */
export function Prose({ children }: { children: ReactNode }) {
  return (
    <div className="prose-kb max-w-3xl [&_h2]:scroll-mt-24 [&_table]:my-4 [&_table]:w-full [&_table]:text-[13px] [&_td]:border-b [&_td]:border-line [&_td]:px-2 [&_td]:py-2 [&_td]:align-top [&_td]:text-ink-2 [&_th]:border-b [&_th]:border-line-2 [&_th]:px-2 [&_th]:py-2 [&_th]:text-left [&_th]:font-mono [&_th]:text-[11px] [&_th]:font-medium [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-mute">
      {children}
    </div>
  );
}

export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">{children}</div>;
}
