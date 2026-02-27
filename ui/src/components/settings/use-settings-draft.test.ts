import { describe, expect, it } from "vitest"
import {
  buildDirtyPatch,
  deriveDirtyByGroup,
  flattenConfig,
  isConfigValueEqual,
  unflattenConfig,
} from "./use-settings-draft"

describe("settings draft helpers", () => {
  it("flattens one level while preserving mcpServers as object", () => {
    const flat = flattenConfig({
      model: "gpt-5.3-codex",
      browser: {
        mode: "shared",
        headless: true,
      },
      mcpServers: {
        github: {
          command: "node",
        },
      },
    })

    expect(flat).toEqual({
      model: "gpt-5.3-codex",
      "browser.mode": "shared",
      "browser.headless": true,
      mcpServers: {
        github: {
          command: "node",
        },
      },
    })
  })

  it("unflattens dot paths into nested patch payload", () => {
    const patch = unflattenConfig({
      model: "gpt-5.3-codex",
      "sandbox.enabled": true,
      "sandbox.memoryLimit": "512m",
      mcpServers: {
        foo: { command: "uvx" },
      },
    })

    expect(patch).toEqual({
      model: "gpt-5.3-codex",
      sandbox: {
        enabled: true,
        memoryLimit: "512m",
      },
      mcpServers: {
        foo: { command: "uvx" },
      },
    })
  })

  it("compares deep config values", () => {
    expect(isConfigValueEqual(
      { foo: ["a", { bar: 1 }] },
      { foo: ["a", { bar: 1 }] },
    )).toBe(true)

    expect(isConfigValueEqual(
      { foo: ["a", { bar: 1 }] },
      { foo: ["a", { bar: 2 }] },
    )).toBe(false)
  })

  it("builds dirty patch from dirty keys only", () => {
    const patch = buildDirtyPatch(
      {
        model: "gpt-5.3-codex",
        "sandbox.enabled": true,
        "sandbox.memoryLimit": "256m",
      },
      ["sandbox.enabled"],
    )

    expect(patch).toEqual({
      "sandbox.enabled": true,
    })
  })

  it("derives dirty counts by settings group", () => {
    const counts = deriveDirtyByGroup(
      ["model", "sandbox.enabled", "OPENAI_API_KEY", "mystery"],
      {
        model: "agent",
        "sandbox.enabled": "runtime",
        OPENAI_API_KEY: "integrations",
      },
    )

    expect(counts).toEqual({
      general: 0,
      agent: 1,
      runtime: 1,
      integrations: 1,
    })
  })
})
