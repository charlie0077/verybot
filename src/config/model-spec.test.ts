import { describe, it, expect } from "vitest";
import { parseModelSpec } from "./model-spec.js";

describe("parseModelSpec", () => {
  it("defaults gpt-5.3-codex to medium reasoning", () => {
    const parsed = parseModelSpec("codex-cli:gpt-5.3-codex");
    expect(parsed.provider).toBe("codex-cli");
    expect(parsed.modelId).toBe("gpt-5.3-codex");
    expect(parsed.codexReasoningEffort).toBe("medium");
  });

  it("falls back to medium for invalid reasoning values", () => {
    const parsed = parseModelSpec("codex-cli:gpt-5.3-codex?reasoningEffort=turbo");
    expect(parsed.codexReasoningEffort).toBe("medium");
  });

  it("parses explicit codex reasoning effort", () => {
    const parsed = parseModelSpec("codex-cli:gpt-5.3-codex?reasoningEffort=high");
    expect(parsed.codexReasoningEffort).toBe("high");
  });

  it("normalizes extra_high aliases to xhigh", () => {
    const parsed = parseModelSpec("codex-cli:gpt-5.3-codex?reasoningLevel=extra_high");
    expect(parsed.codexReasoningEffort).toBe("xhigh");
  });

  it("normalizes extra high (current) labels to xhigh", () => {
    const parsed = parseModelSpec("codex-cli:gpt-5.3-codex?reasoningLevel=extra+high+%28current%29");
    expect(parsed.codexReasoningEffort).toBe("xhigh");
  });

  it("does not force defaults for non-target codex models", () => {
    const parsed = parseModelSpec("codex-cli:gpt-5.3-codex-spark");
    expect(parsed.codexReasoningEffort).toBeUndefined();
  });

  it("ignores codex parsing for non-codex providers", () => {
    const parsed = parseModelSpec("anthropic:claude-sonnet-4-5-20250929");
    expect(parsed.provider).toBe("anthropic");
    expect(parsed.modelId).toBe("claude-sonnet-4-5-20250929");
    expect(parsed.codexReasoningEffort).toBeUndefined();
  });

  it("keeps query params intact for non-codex providers", () => {
    const parsed = parseModelSpec("openai:gpt-4o?temperature=0.3");
    expect(parsed.provider).toBe("openai");
    expect(parsed.modelId).toBe("gpt-4o?temperature=0.3");
    expect(parsed.codexReasoningEffort).toBeUndefined();
  });
});
