import { MODEL_CATALOG } from "../../config/model-catalog.js";

export interface ModelEntry {
  value: string;
  group: string;
  contextWindow: number;
}

/** Derive the UI picker list from the single catalog. */
const DEFAULT_MODELS: ModelEntry[] = MODEL_CATALOG.map((m) => ({
  value: `${m.provider}:${m.modelId}`,
  group: m.group,
  contextWindow: m.contextWindow,
}));

export function modelMethods() {
  return {
    "models.list": async () => {
      return { models: DEFAULT_MODELS };
    },
  };
}
