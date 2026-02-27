import { describe, expect, it, vi } from "vitest";
import { aliasMethods } from "./aliases.js";

describe("aliasMethods", () => {
  it("lists aliases", async () => {
    const store = {
      list: vi.fn(() => [{ alias: "/r", expansion: "/remember {args}", createdAt: 1, updatedAt: 1 }]),
    } as unknown as Parameters<typeof aliasMethods>[0];
    const methods = aliasMethods(store);

    const result = await methods["aliases.list"]();

    expect(store.list).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      aliases: [{ alias: "/r", expansion: "/remember {args}", createdAt: 1, updatedAt: 1 }],
    });
  });

  it("upserts and deletes aliases", async () => {
    const store = {
      upsert: vi.fn((alias: string, expansion: string) => ({
        alias,
        expansion,
        createdAt: 1,
        updatedAt: 1,
      })),
      delete: vi.fn(() => true),
    } as unknown as Parameters<typeof aliasMethods>[0];
    const methods = aliasMethods(store);

    const upsertResult = await methods["aliases.upsert"]({ alias: "/r", expansion: "/remember {args}" });
    const deleteResult = await methods["aliases.delete"]({ alias: "/r" });

    expect(store.upsert).toHaveBeenCalledWith("/r", "/remember {args}");
    expect(store.delete).toHaveBeenCalledWith("/r");
    expect(upsertResult).toEqual({
      alias: { alias: "/r", expansion: "/remember {args}", createdAt: 1, updatedAt: 1 },
    });
    expect(deleteResult).toEqual({ deleted: true });
  });
});
