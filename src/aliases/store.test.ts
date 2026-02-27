import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { CommandAliasStore } from "./store.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "verybot-aliases-"));
}

describe("CommandAliasStore", () => {
  let tempDir = "";

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  });

  it("starts empty and does not seed built-in commands", async () => {
    tempDir = makeTempDir();
    const filePath = join(tempDir, "command-aliases.json");

    const store = await CommandAliasStore.create(filePath);
    expect(store.list()).toEqual([]);
    store.close();
  });

  it("persists aliases to a file and normalizes alias names", async () => {
    tempDir = makeTempDir();
    const filePath = join(tempDir, "command-aliases.json");

    const store = await CommandAliasStore.create(filePath);
    const saved = store.upsert("R", "/remember {args}");

    expect(saved.alias).toBe("/r");
    expect(saved.expansion).toBe("/remember {args}");
    expect(store.list().some((row) => row.alias === "/r")).toBe(true);
    store.close();

    const reloaded = await CommandAliasStore.create(filePath);
    expect(reloaded.list().some((row) => row.alias === "/r" && row.expansion === "/remember {args}")).toBe(true);
    reloaded.close();
  });

  it("deletes aliases by normalized key", async () => {
    tempDir = makeTempDir();
    const filePath = join(tempDir, "command-aliases.json");

    const store = await CommandAliasStore.create(filePath);
    store.upsert("/r", "/remember {args}");

    expect(store.delete("/R")).toBe(true);
    expect(store.list().some((row) => row.alias === "/r")).toBe(false);
    expect(store.delete("/r")).toBe(false);
    store.close();
  });

  it("rejects invalid alias format", async () => {
    tempDir = makeTempDir();
    const filePath = join(tempDir, "command-aliases.json");
    const store = await CommandAliasStore.create(filePath);

    expect(() => store.upsert("/r b", "/remember {args}")).toThrow("alias must be a single token with no spaces");
    store.close();
  });
});
