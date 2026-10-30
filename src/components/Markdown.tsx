import { Fragment, type ReactNode } from "react";

/**
 * Tiny safe Markdown renderer for LLM-written playbooks: headings, bullet/numbered lists,
 * paragraphs, **bold**, *italic*, `code` and http(s) links. Builds React elements only —
 * no HTML passthrough, so model output can never inject markup.
 */

type Block =
  | { kind: "h"; level: 2 | 3 | 4; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "p"; text: string };

export function parseBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { kind: "ul" | "ol"; items: string[] } | null = null;
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join(" ") });
    para = [];
    if (list) blocks.push(list);
    list = null;
  };
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flush();
    } else if (heading) {
      flush();
      // h1 in model output becomes h2: the page already owns the h1.
      const level = Math.min(4, Math.max(2, heading[1].length + (heading[1].length === 1 ? 1 : 0))) as 2 | 3 | 4;
      blocks.push({ kind: "h", level, text: heading[2].replace(/#+\s*$/, "") });
    } else if (bullet || ordered) {
      const kind = bullet ? "ul" : "ol";
      if (para.length) {
        blocks.push({ kind: "p", text: para.join(" ") });
        para = [];
      }
      if (!list || list.kind !== kind) {
        if (list) blocks.push(list);
        list = { kind, items: [] };
      }
      list.items.push((bullet ?? ordered)![1]);
    } else if (list && /^\s{2,}\S/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      if (list) {
        blocks.push(list);
        list = null;
      }
      para.push(line.trim());
    }
  }
  flush();
  return blocks;
}

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\((?:https?:\/\/)[^)\s]+\)|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (!part) return null;
    if ((part.startsWith("**") && part.endsWith("**")) || (part.startsWith("__") && part.endsWith("__"))) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part);
    if (link) {
      return (
        <a key={i} href={link[2]} target="_blank" rel="noopener noreferrer nofollow">
          {link[1]}
        </a>
      );
    }
    if (part.length > 2 && ((part.startsWith("*") && part.endsWith("*")) || (part.startsWith("_") && part.endsWith("_")))) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

export function MarkdownBlocks({ blocks }: { blocks: Block[] }) {
  return (
    <div className="prose-kb">
      {blocks.map((b, i) => {
        if (b.kind === "h") {
          const H = `h${b.level}` as "h2" | "h3" | "h4";
          return <H key={i}>{inline(b.text)}</H>;
        }
        if (b.kind === "p") return <p key={i}>{inline(b.text)}</p>;
        const L = b.kind;
        return (
          <L key={i}>
            {b.items.map((it, j) => (
              <li key={j}>{inline(it)}</li>
            ))}
          </L>
        );
      })}
    </div>
  );
}

export function Markdown({ source }: { source: string }) {
  return <MarkdownBlocks blocks={parseBlocks(source)} />;
}

/** Everything up to (not including) the second heading — the teaser shown to non-holders. */
export function firstSection(blocks: Block[]): { head: Block[]; hiddenSections: number } {
  const headings = blocks.map((b, i) => (b.kind === "h" ? i : -1)).filter((i) => i >= 0);
  if (headings.length < 2) {
    const cut = Math.min(blocks.length, 3);
    return { head: blocks.slice(0, cut), hiddenSections: blocks.length > cut ? 1 : 0 };
  }
  return { head: blocks.slice(0, headings[1]), hiddenSections: headings.length - 1 };
}
