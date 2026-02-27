import { describe, it, expect } from "vitest";
import { markdownToIR, chunkMarkdownIR } from "./ir.js";

describe("markdownToIR", () => {
  it("parses plain text", () => {
    const ir = markdownToIR("hello world");
    expect(ir.text).toBe("hello world");
    expect(ir.styles).toHaveLength(0);
    expect(ir.links).toHaveLength(0);
  });

  it("parses bold", () => {
    const ir = markdownToIR("**bold**");
    expect(ir.text).toBe("bold");
    expect(ir.styles).toHaveLength(1);
    expect(ir.styles[0]).toMatchObject({ start: 0, end: 4, style: "bold" });
  });

  it("parses italic", () => {
    const ir = markdownToIR("*italic*");
    expect(ir.text).toBe("italic");
    expect(ir.styles).toHaveLength(1);
    expect(ir.styles[0]).toMatchObject({ style: "italic" });
  });

  it("parses inline code", () => {
    const ir = markdownToIR("`code`");
    expect(ir.text).toBe("code");
    expect(ir.styles[0]).toMatchObject({ style: "code" });
  });

  it("parses links", () => {
    const ir = markdownToIR("[Google](https://google.com)");
    expect(ir.text).toBe("Google");
    expect(ir.links).toHaveLength(1);
    expect(ir.links[0]).toMatchObject({ start: 0, end: 6, href: "https://google.com" });
  });

  it("parses code blocks", () => {
    const ir = markdownToIR("```\ncode\n```");
    expect(ir.text).toContain("code");
    expect(ir.styles.some((s) => s.style === "code_block")).toBe(true);
  });

  it("parses mixed formatting", () => {
    const ir = markdownToIR("**bold** and *italic*");
    expect(ir.text).toBe("bold and italic");
    expect(ir.styles).toHaveLength(2);
  });
});

describe("table rendering", () => {
  const TABLE_MD = "| Name | Age |\n|------|-----|\n| Alice | 30 |";

  it("renders table as code block", () => {
    const ir = markdownToIR(TABLE_MD, { tableMode: "code" });
    expect(ir.text).toContain("|");
    expect(ir.text).toContain("Alice");
    expect(ir.styles.some((s) => s.style === "code_block")).toBe(true);
  });

  it("renders table as bullets", () => {
    const ir = markdownToIR(TABLE_MD, { tableMode: "bullets" });
    // Bullets: first column value as row title, remaining columns as "• Header: Value"
    expect(ir.text).toContain("Alice");
    expect(ir.text).toContain("Age");
    expect(ir.text).toContain("30");
    expect(ir.styles.some((s) => s.style === "code_block")).toBe(false);
  });

  it("passes table through as-is when mode is off", () => {
    const ir = markdownToIR(TABLE_MD, { tableMode: "off" });
    // Raw pipes appear in text
    expect(ir.text).toContain("|");
  });
});

describe("chunkMarkdownIR", () => {
  it("returns single chunk when under limit", () => {
    const ir = markdownToIR("short");
    const chunks = chunkMarkdownIR(ir, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("short");
  });

  it("splits long text", () => {
    const ir = markdownToIR("word ".repeat(100));
    const chunks = chunkMarkdownIR(ir, 50);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("preserves style spans across chunks", () => {
    // Build a long paragraph with a bold span at the start
    const ir = markdownToIR(`**important** ${"word ".repeat(50)}`);
    const chunks = chunkMarkdownIR(ir, 50);
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should carry the bold style
    expect(chunks[0].styles.some((s) => s.style === "bold")).toBe(true);
  });

  it("returns empty for empty IR", () => {
    const ir = markdownToIR("");
    const chunks = chunkMarkdownIR(ir, 100);
    expect(chunks).toHaveLength(0);
  });
});
