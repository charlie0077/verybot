/** Check if two sets have the same elements. */
export function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

/** Extract a user-facing message from API/runtime errors. */
export function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  if (lower.includes("credit") || lower.includes("billing") || lower.includes("402") || lower.includes("payment"))
    return "API credit balance is too low. Please top up your account and try again.";
  if (lower.includes("rate limit") || lower.includes("429"))
    return "Rate limited by the API. Please wait a moment and try again.";
  if (lower.includes("authentication") || lower.includes("api key") || lower.includes("401"))
    return "API authentication failed. Please check your API key.";
  if (lower.includes("overloaded") || lower.includes("529"))
    return "The AI service is currently overloaded. Please try again shortly.";
  if (lower.includes("context") && lower.includes("overflow"))
    return "The conversation is too long. Please start a new session.";

  return `Something went wrong: ${msg.slice(0, 200)}`;
}
