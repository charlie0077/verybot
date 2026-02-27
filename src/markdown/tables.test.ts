import { describe, it, expect } from "vitest";
import { resolveMarkdownTableMode } from "./tables.js";

describe("resolveMarkdownTableMode", () => {
  it("defaults to 'code' for telegram", () => {
    expect(resolveMarkdownTableMode({ channel: "telegram" })).toBe("code");
  });

  it("defaults to 'code' for discord", () => {
    expect(resolveMarkdownTableMode({ channel: "discord" })).toBe("code");
  });

  it("defaults to 'bullets' for signal", () => {
    expect(resolveMarkdownTableMode({ channel: "signal" })).toBe("bullets");
  });

  it("defaults to 'bullets' for whatsapp", () => {
    expect(resolveMarkdownTableMode({ channel: "whatsapp" })).toBe("bullets");
  });

  it("defaults to 'code' for unknown channels", () => {
    expect(resolveMarkdownTableMode({ channel: "unknown" })).toBe("code");
  });

  it("uses explicit channelTableMode when provided", () => {
    expect(
      resolveMarkdownTableMode({ channel: "telegram", channelTableMode: "bullets" }),
    ).toBe("bullets");
  });

  it("uses 'off' when explicitly set", () => {
    expect(
      resolveMarkdownTableMode({ channel: "telegram", channelTableMode: "off" }),
    ).toBe("off");
  });

  it("falls back to default when channelTableMode is null", () => {
    expect(
      resolveMarkdownTableMode({ channel: "signal", channelTableMode: null }),
    ).toBe("bullets");
  });

  it("falls back to default when channelTableMode is invalid", () => {
    expect(
      resolveMarkdownTableMode({ channel: "telegram", channelTableMode: "invalid" }),
    ).toBe("code");
  });

  it("overrides channel default with explicit config", () => {
    expect(
      resolveMarkdownTableMode({ channel: "signal", channelTableMode: "code" }),
    ).toBe("code");
  });
});
