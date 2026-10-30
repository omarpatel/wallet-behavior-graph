import { fmtFollowers, SOURCE_LABEL, sortSources, telegramUrl } from "@/lib/identity";
import type { DirectorySource } from "@/server/directory/types";

const SOURCE_TONE: Record<DirectorySource["source"], string> = {
  directory: "border-accent/30 text-accent",
  study: "border-region-1/30 text-region-1",
};

function XIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M18.9 2H22l-6.8 7.8L23 22h-6.3l-4.9-6.4L6.2 22H3l7.3-8.4L1 2h6.4l4.4 5.9L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z" />
    </svg>
  );
}

function TelegramIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M21.9 4.3 18.6 20c-.2 1.1-.9 1.4-1.8.9l-5-3.7-2.4 2.3c-.3.3-.5.5-1 .5l.4-5.1 9.2-8.3c.4-.4-.1-.6-.6-.2L6 13.6l-4.9-1.5c-1.1-.3-1.1-1.1.2-1.6L20.5 3c.9-.3 1.7.2 1.4 1.3Z" />
    </svg>
  );
}

/**
 * Public identity links of an attributed brain: X, Telegram, followers and one chip per directory that lists the
 * wallet (linking to that directory's profile page, with its rank when published).
 */
export function IdentityLinks({
  xHandle,
  telegram,
  followers,
  sources,
}: {
  xHandle: string | null;
  telegram: string | null;
  followers: number | null;
  sources: DirectorySource[];
}) {
  const tg = telegramUrl(telegram);
  const fol = fmtFollowers(followers);
  const listed = sortSources(sources);
  if (!xHandle && !tg && !fol && listed.length === 0) return null;
  const pill = "chip relative z-10 transition-colors hover:border-white/30 hover:text-ink";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {xHandle && (
        <a href={`https://x.com/${encodeURIComponent(xHandle)}`} target="_blank" rel="noopener noreferrer" className={pill}>
          <XIcon />@{xHandle}
          <span className="sr-only">(opens in new tab)</span>
        </a>
      )}
      {tg && (
        <a href={tg} target="_blank" rel="noopener noreferrer" className={pill}>
          <TelegramIcon />
          Telegram
          <span className="sr-only">(opens in new tab)</span>
        </a>
      )}
      {fol && (
        <span className="chip num border-transparent text-mute" title="Followers as published by the directory">
          {fol} followers
        </span>
      )}
      {listed.length > 0 && <span className="mx-1 h-4 w-px bg-line-2" aria-hidden="true" />}
      {listed.map((s) => {
        const label = (
          <>
            <span className="font-medium">{SOURCE_LABEL[s.source]}</span>
            {s.rank != null && <span className="num opacity-70">#{s.rank}</span>}
          </>
        );
        const cls = `chip relative z-10 ${SOURCE_TONE[s.source]}`;
        return s.url ? (
          <a
            key={s.source}
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            className={`${cls} transition-colors hover:bg-white/[0.04]`}
            title={`Listed on ${SOURCE_LABEL[s.source]}${s.name ? ` as ${s.name}` : ""} · snapshot ${new Date(s.fetchedAt * 1000).toISOString().slice(0, 10)}`}
          >
            {label}
            <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true" className="opacity-60">
              <path d="M3 1h6v6M9 1 1 9" fill="none" stroke="currentColor" strokeWidth="1.4" />
            </svg>
            <span className="sr-only">(opens in new tab)</span>
          </a>
        ) : (
          <span key={s.source} className={cls} title={`Listed in ${SOURCE_LABEL[s.source]}${s.name ? ` as ${s.name}` : ""}`}>
            {label}
          </span>
        );
      })}
    </div>
  );
}
