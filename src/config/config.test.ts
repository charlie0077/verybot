import { describe, it, expect } from "vitest";
import { loadConfig } from "../config.js";
import type { ConfigStore, ConfigData } from "./store.js";

/** Minimal in-memory ConfigStore for testing. */
function fakeStore(data: ConfigData = {}): ConfigStore {
  let stored = { ...data };
  return {
    load: () => ({ ...stored }),
    save: (d: ConfigData) => { stored = { ...d }; },
    patch: (d: Partial<ConfigData>) => { stored = { ...stored, ...d }; return stored; },
    getRedacted: () => stored,
    patchFromUI: (d: ConfigData) => { stored = { ...stored, ...d }; return stored; },
    getFilePath: () => "/tmp/fake-config.json",
  } as unknown as ConfigStore;
}

describe("loadConfig", () => {
  it("loads config without teams (teams now live in TeamStore)", () => {
    const config = loadConfig(fakeStore({
      model: "anthropic:claude-sonnet-4-5-20250929",
      identity: "You are helpful.",
    }));

    // Config no longer has teams field
    expect(config.model.id).toBe("claude-sonnet-4-5-20250929");
    expect(config.model.provider).toBe("anthropic");
    expect(config.identity).toBe("You are helpful.");
    expect("teams" in config).toBe(false);
  });

  it("loads default config when empty", () => {
    const config = loadConfig(fakeStore({}));

    expect(config.model.provider).toBe("");
    expect(config.model.id).toBe("");
    expect(config.identity).toBe("You are a helpful personal assistant.");
    expect("teams" in config).toBe(false);
  });

  it("falls back to per-tab-per-session for invalid browserMode", () => {
    const config = loadConfig(fakeStore({
      browserMode: "invalid-mode",
    }));
    expect(config.browserMode).toBe("per-tab-per-session");
  });

  it("accepts per-browser-per-session browserMode", () => {
    const config = loadConfig(fakeStore({
      browserMode: "per-browser-per-session",
    }));
    expect(config.browserMode).toBe("per-browser-per-session");
  });
});
