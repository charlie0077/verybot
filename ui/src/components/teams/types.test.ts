import { describe, it, expect } from "vitest"
import {
  isUserTeam,
  cleanTeamsForPersist,
  buildInitialDraft,
  parseTeamsFromConfig,
  extractGlobalModelConfig,
  nextAvailableColor,
  DEFAULT_TEAM_ID,
  DEFAULT_GLOBAL_MODEL_CONFIG,
  DEFAULT_ORCHESTRATOR_NAME,
  EMPTY_AGENT,
  EMPTY_TEAM,
  TEAM_COLORS,
} from "./types"

describe("isUserTeam", () => {
  it("excludes the default team", () => {
    expect(isUserTeam({ ...EMPTY_TEAM, id: DEFAULT_TEAM_ID })).toBe(false)
  })

  it("includes user-created teams", () => {
    expect(isUserTeam({ ...EMPTY_TEAM, id: "abc-123" })).toBe(true)
  })
})

describe("cleanTeamsForPersist", () => {
  it("strips _key from orchestrator and workers", () => {
    const team = {
      ...EMPTY_TEAM,
      id: "t1",
      orchestrator: { ...EMPTY_AGENT, id: "o1", _key: "k1" },
      workers: [{ ...EMPTY_AGENT, id: "w1", _key: "k2" }],
    }
    const [cleaned] = cleanTeamsForPersist([team])
    expect(cleaned.orchestrator).not.toHaveProperty("_key")
    expect(cleaned.workers[0]).not.toHaveProperty("_key")
  })

  it("trims names on team, orchestrator, and workers", () => {
    const team = {
      ...EMPTY_TEAM,
      id: "t1",
      name: "  My Team  ",
      orchestrator: { ...EMPTY_AGENT, name: " Lead " },
      workers: [{ ...EMPTY_AGENT, name: " Worker " }],
    }
    const [cleaned] = cleanTeamsForPersist([team])
    expect(cleaned.name).toBe("My Team")
    expect(cleaned.orchestrator.name).toBe("Lead")
    expect(cleaned.workers[0].name).toBe("Worker")
  })
})

describe("buildInitialDraft", () => {
  it("generates UUIDs for a new team when given null", () => {
    const draft = buildInitialDraft(null)
    expect(draft.id).toBeTruthy()
    expect(draft.id).not.toBe("")
    expect(draft.orchestrator.id).toBeTruthy()
    expect(draft.orchestrator.id).not.toBe(draft.id)
    expect(draft.orchestrator.name).toBe(DEFAULT_ORCHESTRATOR_NAME)
    expect(draft.orchestrator.model).toBe(DEFAULT_GLOBAL_MODEL_CONFIG.model)
    expect(draft.orchestrator.contextWindow).toBe(DEFAULT_GLOBAL_MODEL_CONFIG.contextWindow)
    expect(draft.orchestrator.maxSteps).toBe(DEFAULT_GLOBAL_MODEL_CONFIG.maxSteps)
    expect(draft.workers).toEqual([])
  })

  it("shallow-clones an existing team", () => {
    const existing = {
      ...EMPTY_TEAM,
      id: "t1",
      name: "Test",
      orchestrator: { ...EMPTY_AGENT, id: "o1", name: "Orch" },
      workers: [{ ...EMPTY_AGENT, id: "w1", name: "W1" }],
    }
    const draft = buildInitialDraft(existing)
    expect(draft.id).toBe("t1")
    expect(draft.orchestrator.name).toBe("Orch")
    expect(draft.workers[0].name).toBe("W1")
    // Verify it's a shallow clone, not the same reference
    expect(draft.orchestrator).not.toBe(existing.orchestrator)
  })

  it("assigns _key to workers that lack one", () => {
    const existing = {
      ...EMPTY_TEAM,
      id: "t1",
      workers: [{ ...EMPTY_AGENT, id: "w1" }],
    }
    const draft = buildInitialDraft(existing)
    expect(draft.workers[0]._key).toBeTruthy()
  })

  it("uses provided global model defaults for a new orchestrator", () => {
    const globalModelConfig = {
      model: "openai:gpt-4o",
      contextWindow: 128_000,
      maxSteps: 42,
    }
    const draft = buildInitialDraft(null, [], globalModelConfig)
    expect(draft.orchestrator.name).toBe(DEFAULT_ORCHESTRATOR_NAME)
    expect(draft.orchestrator.model).toBe(globalModelConfig.model)
    expect(draft.orchestrator.contextWindow).toBe(globalModelConfig.contextWindow)
    expect(draft.orchestrator.maxSteps).toBe(globalModelConfig.maxSteps)
  })
})

describe("extractGlobalModelConfig", () => {
  it("returns defaults for invalid payloads", () => {
    expect(extractGlobalModelConfig(null)).toEqual(DEFAULT_GLOBAL_MODEL_CONFIG)
    expect(extractGlobalModelConfig("bad-shape")).toEqual(DEFAULT_GLOBAL_MODEL_CONFIG)
  })

  it("extracts model, contextWindow, and maxSteps from config", () => {
    const result = extractGlobalModelConfig({
      model: "openai:gpt-4o",
      contextWindow: 256_000,
      maxSteps: 30,
    })
    expect(result).toEqual({
      model: "openai:gpt-4o",
      contextWindow: 256_000,
      maxSteps: 30,
    })
  })
})

describe("parseTeamsFromConfig", () => {
  it("parses a valid config response", () => {
    const result = { config: { teams: [{ id: "t1", name: "T", orchestrator: EMPTY_AGENT, workers: [] }] } }
    const teams = parseTeamsFromConfig(result)
    expect(teams).toHaveLength(1)
    expect(teams![0].id).toBe("t1")
  })

  it("returns null for missing config key", () => {
    expect(parseTeamsFromConfig({})).toBeNull()
  })

  it("returns null for null input", () => {
    expect(parseTeamsFromConfig(null)).toBeNull()
  })

  it("returns null when teams is not an array", () => {
    expect(parseTeamsFromConfig({ config: { teams: "not-an-array" } })).toBeNull()
  })

  it("returns null when config is not an object", () => {
    expect(parseTeamsFromConfig({ config: 42 })).toBeNull()
  })
})

describe("nextAvailableColor", () => {
  it("keeps a fixed 32-color team palette", () => {
    expect(TEAM_COLORS).toHaveLength(32)
    expect(new Set(TEAM_COLORS).size).toBe(TEAM_COLORS.length)
  })

  it("returns the first color when no teams exist", () => {
    expect(nextAvailableColor([])).toBe(TEAM_COLORS[0])
  })

  it("skips colors already used", () => {
    const teams = [{ ...EMPTY_TEAM, color: TEAM_COLORS[0] }]
    expect(nextAvailableColor(teams)).toBe(TEAM_COLORS[1])
  })

  it("skips multiple used colors", () => {
    const teams = [
      { ...EMPTY_TEAM, color: TEAM_COLORS[0] },
      { ...EMPTY_TEAM, color: TEAM_COLORS[1] },
      { ...EMPTY_TEAM, color: TEAM_COLORS[2] },
    ]
    expect(nextAvailableColor(teams)).toBe(TEAM_COLORS[3])
  })

  it("wraps to first color when all are used", () => {
    const teams = TEAM_COLORS.map((c) => ({ ...EMPTY_TEAM, color: c }))
    expect(nextAvailableColor(teams)).toBe(TEAM_COLORS[0])
  })
})

describe("buildInitialDraft — color", () => {
  it("assigns auto color for new team", () => {
    const draft = buildInitialDraft(null, [])
    expect(draft.color).toBe(TEAM_COLORS[0])
  })

  it("assigns next available color when some are taken", () => {
    const existing = [{ ...EMPTY_TEAM, color: TEAM_COLORS[0] }]
    const draft = buildInitialDraft(null, existing)
    expect(draft.color).toBe(TEAM_COLORS[1])
  })

  it("preserves color when editing existing team", () => {
    const team = { ...EMPTY_TEAM, id: "t1", color: "#3b82f6" }
    const draft = buildInitialDraft(team)
    expect(draft.color).toBe("#3b82f6")
  })
})
