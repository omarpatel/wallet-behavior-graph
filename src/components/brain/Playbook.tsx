import { firstSection, MarkdownBlocks, parseBlocks } from "@/components/Markdown";
import { SectionTitle } from "@/components/ui/primitives";

export function Playbook({ markdown, full, stale }: { markdown: string | null; full: boolean; stale: boolean }) {
  return (
    <section aria-labelledby="playbook" className="space-y-4">
      <SectionTitle id="playbook" eyebrow={stale ? "AI-written from the profile · refresh pending" : "AI-written from the profile"}>
        Playbook
      </SectionTitle>
      {!markdown ? (
        <div className="card p-5 text-sm text-mute">The playbook is written after the profile is computed.</div>
      ) : full ? (
        <div className="card p-6">
          <MarkdownBlocks blocks={parseBlocks(markdown)} />
        </div>
      ) : (
        <Teaser markdown={markdown} />
      )}
    </section>
  );
}

function Teaser({ markdown }: { markdown: string }) {
  const { head, hiddenSections } = firstSection(parseBlocks(markdown));
  return (
    <div className="card relative overflow-hidden p-6">
      <MarkdownBlocks blocks={head} />
      {hiddenSections > 0 && (
        <div className="relative mt-4">
          <div aria-hidden="true" className="space-y-2 blur-[3px] select-none">
            <div className="h-3 w-3/4 rounded bg-white/10" />
            <div className="h-3 w-full rounded bg-white/10" />
            <div className="h-3 w-5/6 rounded bg-white/10" />
            <div className="h-3 w-2/3 rounded bg-white/10" />
          </div>
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="flex items-center gap-2 rounded-full border border-line-2 bg-panel px-4 py-2 text-xs text-ink-2">
              <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" strokeWidth="1.4" />
              </svg>
              {hiddenSections} more section{hiddenSections === 1 ? "" : "s"} for seat holders
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
