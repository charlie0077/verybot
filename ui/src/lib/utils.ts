import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const FALLBACK_ID_PREFIX = "id"
const RANDOM_SLICE_START = 2
const RANDOM_SLICE_END = 10

/**
 * Create a stable client-side ID even on insecure origins (e.g. http://LAN-IP)
 * where crypto.randomUUID() may be unavailable.
 */
export function createClientId(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (typeof randomUUID === "function") {
    return randomUUID.call(globalThis.crypto)
  }

  const timePart = Date.now().toString(36)
  const randomPart = Math.random().toString(36).slice(RANDOM_SLICE_START, RANDOM_SLICE_END)
  return `${FALLBACK_ID_PREFIX}-${timePart}-${randomPart}`
}
