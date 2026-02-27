import { describe, expect, it } from "vitest"
import { getCodexReasoningLevel, setCodexReasoningLevel } from "./model-spec.js"

describe("ui model-spec codex reasoning", () => {
  it("defaults gpt-5.3-codex to medium", () => {
    expect(getCodexReasoningLevel("codex-cli:gpt-5.3-codex")).toBe("medium")
  })

  it("falls back to medium for invalid reasoning values", () => {
    expect(getCodexReasoningLevel("codex-cli:gpt-5.3-codex?reasoningEffort=turbo")).toBe("medium")
  })

  it("normalizes extra high (current) labels to extra_high", () => {
    const model = "codex-cli:gpt-5.3-codex?reasoningLevel=extra+high+%28current%29"
    expect(getCodexReasoningLevel(model)).toBe("extra_high")
  })

  it("normalizes xhigh labels to extra_high", () => {
    const model = "codex-cli:gpt-5.3-codex?reasoningEffort=xhigh"
    expect(getCodexReasoningLevel(model)).toBe("extra_high")
  })

  it("writes selected reasoning as reasoningEffort", () => {
    const model = "codex-cli:gpt-5.3-codex?reasoningLevel=extra_high"
    expect(setCodexReasoningLevel(model, "high")).toBe("codex-cli:gpt-5.3-codex?reasoningEffort=high")
  })

  it("writes extra_high as xhigh for codex-cli", () => {
    expect(setCodexReasoningLevel("codex-cli:gpt-5.3-codex", "extra_high")).toBe(
      "codex-cli:gpt-5.3-codex?reasoningEffort=xhigh",
    )
  })

  it("keeps unsupported models unchanged", () => {
    expect(setCodexReasoningLevel("openai:gpt-4.1", "high")).toBe("openai:gpt-4.1")
    expect(getCodexReasoningLevel("openai:gpt-4.1")).toBeNull()
  })
})
