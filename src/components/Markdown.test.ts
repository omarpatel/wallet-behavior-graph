import { describe, expect, it } from "vitest";
import { firstSection, parseBlocks } from "./Markdown";

describe("parseBlocks", () => {
  it("splits headings, lists and paragraphs; maps h1 to h2", () => {
    const blocks = parseBlocks("# Title\nIntro line one\nline two\n\n- a\n- b\n1. x\n2) y\n### Sub");
    expect(blocks).toEqual([
      { kind: "h", level: 2, text: "Title" },
      { kind: "p", text: "Intro line one line two" },
      { kind: "ul", items: ["a", "b"] },
      { kind: "ol", items: ["x", "y"] },
      { kind: "h", level: 3, text: "Sub" },
    ]);
  });

  it("keeps raw HTML as plain text (no markup passthrough)", () => {
    const [p] = parseBlocks("<script>alert(1)</script> **bold**");
    expect(p).toEqual({ kind: "p", text: "<script>alert(1)</script> **bold**" });
  });

  it("does not treat **bold** at line start as a bullet and joins indented continuations", () => {
    expect(parseBlocks("**Entry:** fast")).toEqual([{ kind: "p", text: "**Entry:** fast" }]);
    expect(parseBlocks("- one\n  continued")).toEqual([{ kind: "ul", items: ["one continued"] }]);
  });
});

describe("firstSection", () => {
  it("returns content before the second heading and counts hidden sections", () => {
    const { head, hiddenSections } = firstSection(parseBlocks("## A\ntext\n## B\nmore\n## C\nend"));
    expect(head).toEqual([
      { kind: "h", level: 2, text: "A" },
      { kind: "p", text: "text" },
    ]);
    expect(hiddenSections).toBe(2);
  });

  it("truncates heading-less playbooks to three blocks", () => {
    const { head, hiddenSections } = firstSection(parseBlocks("a\n\nb\n\nc\n\nd"));
    expect(head).toHaveLength(3);
    expect(hiddenSections).toBe(1);
  });
});
