import type { TaskStatusConfig } from "../config/agent-config.js";

const STATUS_KEY_RE = /^\w+$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MIN_STATUS_COUNT = 1;
const MAX_STATUS_KEY_LENGTH = 128;
const DONE_STATUS_KEY = "done";

/** Required terminal task status key across all teams. */
export const REQUIRED_DONE_STATUS_KEY = DONE_STATUS_KEY;

/**
 * Validate a full TaskStatusConfig[] payload.
 * Enforces structural correctness plus the required `done` status invariant.
 */
export function validateStatusConfigs(statuses: unknown): asserts statuses is TaskStatusConfig[] {
  if (!Array.isArray(statuses)) throw new Error("statuses must be an array");
  if (statuses.length < MIN_STATUS_COUNT) throw new Error("statuses must contain at least one status");

  const keys = new Set<string>();
  for (const status of statuses) {
    if (typeof status !== "object" || status === null) throw new Error("Each status must be an object");
    const candidate = status as Record<string, unknown>;
    if (
      typeof candidate.key !== "string"
      || candidate.key.length > MAX_STATUS_KEY_LENGTH
      || !STATUS_KEY_RE.test(candidate.key)
    ) {
      throw new Error(`Invalid status key "${candidate.key}": only letters, numbers, and underscores allowed`);
    }
    if (keys.has(candidate.key)) throw new Error(`Duplicate status key "${candidate.key}"`);
    keys.add(candidate.key);

    if (typeof candidate.label !== "string" || candidate.label.trim().length === 0) {
      throw new Error(`Status "${candidate.key}" must have a non-empty label`);
    }
    if (typeof candidate.color !== "string" || !HEX_COLOR_RE.test(candidate.color)) {
      throw new Error(`Status "${candidate.key}" must have a valid hex color`);
    }
  }

  if (!keys.has(DONE_STATUS_KEY)) {
    throw new Error(`statuses must include a "${DONE_STATUS_KEY}" status key`);
  }
}
