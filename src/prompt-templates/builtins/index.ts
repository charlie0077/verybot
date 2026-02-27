import type { PromptTemplate } from "../types.js";
import { PLANNER } from "./planner.js";

export { PLANNER };

export const BUILTIN_TEMPLATES: Omit<PromptTemplate, "createdAt" | "updatedAt">[] = [
  PLANNER,
];
