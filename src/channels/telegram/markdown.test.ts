import { describe, it, expect } from "vitest";
import { markdownToTelegramHtml, markdownToTelegramHtmlChunks } from "./markdown.js";

describe("markdownToTelegramHtml", () => {
  it("converts bold", () => {
    expect(markdownToTelegramHtml("**hello**")).toBe("<b>hello</b>");
  });

  it("converts italic", () => {
    expect(markdownToTelegramHtml("*hello*")).toBe("<i>hello</i>");
  });

  it("converts inline code", () => {
    expect(markdownToTelegramHtml("`code`")).toBe("<code>code</code>");
  });

  it("converts code blocks", () => {
    const result = markdownToTelegramHtml("```\nconst x = 1;\n```");
    expect(result).toContain("<pre><code>");
    expect(result).toContain("const x = 1;");
    expect(result).toContain("</code></pre>");
  });

  it("converts links", () => {
    const result = markdownToTelegramHtml("[Google](https://google.com)");
    expect(result).toBe('<a href="https://google.com">Google</a>');
  });

  it("converts strikethrough", () => {
    expect(markdownToTelegramHtml("~~deleted~~")).toBe("<s>deleted</s>");
  });

  it("escapes HTML entities in text", () => {
    expect(markdownToTelegramHtml("1 < 2 & 3 > 0")).toBe("1 &lt; 2 &amp; 3 &gt; 0");
  });

  it("escapes HTML entities in link href", () => {
    const result = markdownToTelegramHtml('[test](https://example.com?a=1&b=2)');
    expect(result).toContain("&amp;b=2");
  });

  it("handles mixed formatting", () => {
    const result = markdownToTelegramHtml("**bold** and *italic* and `code`");
    expect(result).toContain("<b>bold</b>");
    expect(result).toContain("<i>italic</i>");
    expect(result).toContain("<code>code</code>");
  });

  it("handles plain text passthrough", () => {
    expect(markdownToTelegramHtml("just plain text")).toBe("just plain text");
  });

  it("handles empty string", () => {
    expect(markdownToTelegramHtml("")).toBe("");
  });

  it("handles lists", () => {
    const result = markdownToTelegramHtml("- item 1\n- item 2");
    expect(result).toContain("item 1");
    expect(result).toContain("item 2");
  });

  it("renders table as code block with tableMode: code", () => {
    const result = markdownToTelegramHtml("| A | B |\n|---|---|\n| 1 | 2 |", {
      tableMode: "code",
    });
    expect(result).toContain("<pre><code>");
    expect(result).toContain("</code></pre>");
  });

  it("renders table as bullets with tableMode: bullets", () => {
    const result = markdownToTelegramHtml("| Name | Age |\n|------|-----|\n| Bob | 25 |", {
      tableMode: "bullets",
    });
    expect(result).not.toContain("<pre>");
    expect(result).toContain("Bob");
    expect(result).toContain("25");
  });

  it("rejects javascript: protocol in links", () => {
    const result = markdownToTelegramHtml("[click](javascript:alert(1))");
    // No <a> tag should be generated for dangerous protocols
    expect(result).not.toContain("<a ");
    expect(result).not.toContain("href");
  });

  it("allows mailto: links", () => {
    const result = markdownToTelegramHtml("[email](mailto:test@example.com)");
    expect(result).toContain('<a href="mailto:test@example.com">');
  });
});

describe("markdownToTelegramHtmlChunks", () => {
  it("returns single chunk for short text", () => {
    const chunks = markdownToTelegramHtmlChunks("hello", 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("hello");
  });

  it("splits long text into multiple chunks", () => {
    const text = "word ".repeat(200); // ~1000 chars
    const chunks = markdownToTelegramHtmlChunks(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // Each chunk's source text should be ≤ limit
      expect(chunk.length).toBeLessThanOrEqual(200); // HTML overhead margin
    }
  });

  it("preserves HTML formatting across chunks", () => {
    const text = `**bold text** and then ${"a ".repeat(500)}more **bold**`;
    const chunks = markdownToTelegramHtmlChunks(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain("<b>");
  });

  it("returns empty array for empty input", () => {
    const chunks = markdownToTelegramHtmlChunks("", 100);
    expect(chunks).toHaveLength(0);
  });
});
