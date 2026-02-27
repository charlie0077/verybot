import type { CommandAliasStore } from "../../aliases/store.js";

export function aliasMethods(store: CommandAliasStore) {
  return {
    "aliases.list": async () => {
      return { aliases: store.list() };
    },

    "aliases.upsert": async (params: { alias: string; expansion: string }) => {
      if (!params || typeof params.alias !== "string") {
        throw new Error("alias is required and must be a string");
      }
      if (typeof params.expansion !== "string") {
        throw new Error("expansion is required and must be a string");
      }
      return { alias: store.upsert(params.alias, params.expansion) };
    },

    "aliases.delete": async (params: { alias: string }) => {
      if (!params || typeof params.alias !== "string") {
        throw new Error("alias is required and must be a string");
      }
      return { deleted: store.delete(params.alias) };
    },
  };
}
